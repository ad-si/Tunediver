#[macro_use]
extern crate rocket;
mod db;

use rocket::fs::FileServer;
use rocket::serde::{json::Json, Deserialize, Serialize};
use rocket::State;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use lofty::config::ParseOptions;
use lofty::file::{AudioFile, FileType, TaggedFileExt};
use lofty::picture::MimeType;
use lofty::probe::Probe;
use lofty::read_from_path;
use lofty::tag::Accessor;
use rocket::http::{ContentType, Status};
use rocket::response::status::{Created, NoContent, NotFound};

// Files whose tags are missing or unreadable surface under these labels
// instead of borrowing identity from the on-disk filename or path.
const UNKNOWN_ARTIST: &str = "Unknown Artist";
const UNKNOWN_TITLE: &str = "Unknown Title";

// In-memory catalog entry: the authoritative description of a track comes
// from its embedded tag data, not from the directory structure.
#[derive(Debug, Clone)]
struct Track {
  id: usize,
  artist: String,
  title: String,
  path: PathBuf,
}

#[derive(Debug)]
struct Catalog {
  tracks: Vec<Track>,
}

struct AppConfig {
  // Root scanned to build the catalog. Retained so /api/reload can
  // rebuild against the same source without re-reading Rocket config.
  music_path: PathBuf,
  // Connection pool to the SQLite cache (tag metadata + cover art).
  pool: db::Pool,
  // In-memory projection of the `tracks` table, serving the list endpoints.
  // Arc so a background scan thread can swap in a freshly rebuilt catalog.
  catalog: Arc<RwLock<Catalog>>,
  // True while a background scan runs; gates /api/scan-status and prevents
  // overlapping scans.
  scanning: Arc<AtomicBool>,
  // Progress of the current/last scan: number of files examined and the total
  // discovered on disk. Surfaced via /api/scan-status so the UI can render a
  // determinate progress bar instead of an indefinite spinner.
  scan_processed: Arc<AtomicUsize>,
  scan_total: Arc<AtomicUsize>,
}

// Helper function to check if a file is an audio file. Includes a few
// container formats (mp4, m4v, webm) that often hold music videos — the
// <audio> element in modern browsers plays the audio track and ignores
// any video.
fn is_audio_file(filename: &str) -> bool {
  let extensions = [
    ".mp3", ".m4a", ".flac", ".wav", ".ogg", ".aac", ".wma", ".aiff", ".alac",
    ".opus", ".mp4", ".m4v", ".webm",
  ];
  let lower = filename.to_lowercase();
  extensions.iter().any(|ext| lower.ends_with(ext))
}

// URL-encode a single path segment.
fn encode(segment: &str) -> String {
  urlencoding::encode(segment).to_string()
}

// Tag conventions pack collaborating artists into a single artist string.
// Split on the recognized separators so each participant surfaces as its
// own catalog entry and a collaboration appears under every artist
// involved. An artist string with no separator yields a single-element vec.
//
// Separators:
//   " / "  — surrounding spaces are required and load-bearing: splitting on
//            a bare "/" would mangle single names like "AC/DC", "D/troit".
//   ";"    — unambiguous (no artist name contains one); no spaces required.
fn split_artists(artist: &str) -> Vec<String> {
  artist
    .split(" / ")
    .flat_map(|s| s.split(';'))
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect()
}

// Whether a track's (possibly multi-artist) artist string belongs to
// `query`. Matches the full string verbatim — so links built from the
// original credit keep resolving — or any single split-out artist, which
// is what makes a collaboration reachable from each participant's page.
fn artist_matches(full: &str, query: &str) -> bool {
  full == query || split_artists(full).iter().any(|a| a == query)
}

// Read artist and title from the file's embedded tags. Falls back to
// "Unknown Artist" / "Unknown Title" when tags are missing or unreadable;
// never consults the filename or directory name.
fn read_track_tags(path: &Path) -> (String, String) {
  let tagged = match read_from_path(path) {
    Ok(t) => t,
    Err(_) => return (UNKNOWN_ARTIST.to_string(), UNKNOWN_TITLE.to_string()),
  };

  let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
  let (artist, title) = match tag {
    Some(t) => (
      t.artist().map(|s| s.to_string()).unwrap_or_default(),
      t.title().map(|s| s.to_string()).unwrap_or_default(),
    ),
    None => (String::new(), String::new()),
  };

  // Trim stray whitespace from tag values — some files in the wild ship
  // with leading/trailing spaces in `TPE1`/`TIT2` frames, which would
  // otherwise prevent (artist, title)-based lookups (e.g. playlist track
  // refs) from matching the catalog entry.
  let artist = if artist.trim().is_empty() {
    UNKNOWN_ARTIST.to_string()
  } else {
    artist.trim().to_string()
  };
  let title = if title.trim().is_empty() {
    UNKNOWN_TITLE.to_string()
  } else {
    title.trim().to_string()
  };
  (artist, title)
}

// Look up lyrics from whichever tag the file carries, if any.
// ID3v2 USLT frames surface as `UnsyncLyrics`, while other formats
// (e.g. Vorbis comments, MP4 atoms) use `Lyrics`, so try both.
fn read_track_lyrics(path: &Path) -> Option<String> {
  let tagged = read_from_path(path).ok()?;
  let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
  tag
    .get_string(lofty::tag::ItemKey::UnsyncLyrics)
    .or_else(|| tag.get_string(lofty::tag::ItemKey::Lyrics))
    .map(|s| s.to_string())
}

// Read a custom TXXX user-defined text frame (e.g. "DATE_ADDED") from the
// file's ID3v2 tag. The generic `Tag` view drops unmapped TXXX frames, so we
// reparse via the concrete format and pull the frame off the `Id3v2Tag`.
fn read_id3v2_user_text(path: &Path, description: &str) -> Option<String> {
  let file_type = Probe::open(path)
    .ok()?
    .guess_file_type()
    .ok()?
    .file_type()?;

  let mut file = fs::File::open(path).ok()?;
  let options = ParseOptions::default();

  let value = match file_type {
    FileType::Mpeg => lofty::mpeg::MpegFile::read_from(&mut file, options)
      .ok()?
      .id3v2()
      .and_then(|t| t.get_user_text(description))
      .map(str::to_string),
    FileType::Wav => lofty::iff::wav::WavFile::read_from(&mut file, options)
      .ok()?
      .id3v2()
      .and_then(|t| t.get_user_text(description))
      .map(str::to_string),
    FileType::Aiff => lofty::iff::aiff::AiffFile::read_from(&mut file, options)
      .ok()?
      .id3v2()
      .and_then(|t| t.get_user_text(description))
      .map(str::to_string),
    FileType::Flac => lofty::flac::FlacFile::read_from(&mut file, options)
      .ok()?
      .id3v2()
      .and_then(|t| t.get_user_text(description))
      .map(str::to_string),
    _ => None,
  };

  value.filter(|s| !s.is_empty())
}

// Recursively collect every audio file under `dir`.
// Recursively collect audio file paths under `dir`. Returns `false` if any
// directory or entry could not be read, so the caller can distinguish a
// complete walk from a partial one. This matters on slow/removable storage
// (the music lives on a microSD): a transient read failure must not be
// mistaken for files having been deleted, which would otherwise prune them
// from the cache.
fn collect_audio_files(dir: &Path, out: &mut Vec<PathBuf>) -> bool {
  let entries = match fs::read_dir(dir) {
    Ok(e) => e,
    Err(_) => return false,
  };
  let mut complete = true;
  for entry in entries {
    let entry = match entry {
      Ok(e) => e,
      Err(_) => {
        complete = false;
        continue;
      }
    };
    let path = entry.path();
    let file_type = match entry.file_type() {
      Ok(t) => t,
      Err(_) => {
        complete = false;
        continue;
      }
    };
    if file_type.is_dir() {
      // A failed subtree taints the whole walk so pruning stays disabled.
      complete &= collect_audio_files(&path, out);
    } else if file_type.is_file() {
      if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        // Skip dotfiles: macOS AppleDouble resource forks (`._foo.flac`) on
        // exFAT/FAT volumes carry audio extensions but aren't real audio, and
        // hidden files (`.DS_Store`, etc.) aren't music either.
        if !name.starts_with('.') && is_audio_file(name) {
          out.push(path);
        }
      }
    }
  }
  complete
}

// Extract the first embedded cover picture as (has_cover, bytes, mime). Called
// only during a scan, so the per-request cover endpoint can serve from the
// cache without reopening the (possibly slow) audio file. `has_cover == false`
// is stored as a negative cache entry so missing art isn't re-probed.
fn read_cover(path: &Path) -> (bool, Option<Vec<u8>>, Option<String>) {
  let tagged = match read_from_path(path) {
    Ok(t) => t,
    Err(_) => return (false, None, None),
  };
  let tag = match tagged.primary_tag().or_else(|| tagged.first_tag()) {
    Some(t) => t,
    None => return (false, None, None),
  };
  let picture = match tag.pictures().first() {
    Some(p) => p,
    None => return (false, None, None),
  };
  let mime = match picture.mime_type() {
    Some(MimeType::Png) => "image/png",
    Some(MimeType::Bmp) => "image/bmp",
    Some(MimeType::Gif) => "image/gif",
    Some(MimeType::Tiff) => "image/tiff",
    _ => "image/jpeg",
  };
  (true, Some(picture.data().to_vec()), Some(mime.to_string()))
}

// Default max age of a recorded full scan before a startup re-scan is forced.
// The music is on slow removable storage and changes rarely, so a day bounds
// staleness while sparing repeated restarts a redundant tree walk. Overridable
// via the `startup_scan_max_age_secs` config key.
const DEFAULT_STARTUP_SCAN_MAX_AGE_SECS: i64 = 86_400;

// Current wall-clock time in whole UNIX seconds, 0 if the clock is before the
// epoch (which can't happen in practice but keeps this total).
fn now_unix_secs() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0)
}

// Whether to reconcile against disk on startup. The LaunchAgent restarts often
// (reboot, redeploy, crash) while the music rarely changes, so re-walking tens
// of thousands of files on every start is wasteful. Scan when the cache is
// empty (first run), when no full scan was ever recorded, or when the last
// recorded scan is older than `max_age_secs`. A `max_age_secs <= 0` forces a
// scan on every startup (the original behavior). Pure for testability; callers
// supply the cached-track count, the stored timestamp, and the current time.
fn should_scan_on_startup(
  cached_tracks: usize,
  last_scan: Option<i64>,
  now_secs: i64,
  max_age_secs: i64,
) -> bool {
  if cached_tracks == 0 || max_age_secs <= 0 {
    return true;
  }
  match last_scan {
    None => true,
    Some(t) => now_secs.saturating_sub(t) >= max_age_secs,
  }
}

// (mtime_secs, size) for change detection. Returns (0, 0) if the file can't
// be stat'd, which forces a re-read on the next scan.
fn file_stamp(path: &Path) -> (i64, i64) {
  match fs::metadata(path) {
    Ok(m) => {
      let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
      (mtime, m.len() as i64)
    }
    Err(_) => (0, 0),
  }
}

// Start a background scan unless one is already running. Returns immediately;
// the catalog is swapped in atomically once the scan finishes.
fn spawn_scan(
  pool: db::Pool,
  music_path: PathBuf,
  catalog: Arc<RwLock<Catalog>>,
  scanning: Arc<AtomicBool>,
  scan_processed: Arc<AtomicUsize>,
  scan_total: Arc<AtomicUsize>,
) {
  if scanning
    .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
    .is_err()
  {
    println!("Scan already in progress; ignoring request");
    return;
  }
  // Reset progress so a poll landing between flag-set and path-collection
  // doesn't report stale totals from the previous scan.
  scan_processed.store(0, Ordering::SeqCst);
  scan_total.store(0, Ordering::SeqCst);
  std::thread::spawn(move || {
    run_scan(&pool, &music_path, &catalog, &scan_processed, &scan_total);
    scanning.store(false, Ordering::SeqCst);
  });
}

// Reconcile the cache with the music folder, then rebuild the in-memory
// catalog. Files are re-read (tags, lyrics, DATE_ADDED, cover) only when new or
// changed by mtime/size; rows for vanished files are deleted. Paths and
// filenames only *locate* files on disk; all user-visible metadata comes from
// the tags.
fn run_scan(
  pool: &db::Pool,
  music_path: &Path,
  catalog: &RwLock<Catalog>,
  scan_processed: &AtomicUsize,
  scan_total: &AtomicUsize,
) {
  let conn = match pool.get() {
    Ok(c) => c,
    Err(e) => {
      eprintln!("Scan: cache connection unavailable: {}", e);
      return;
    }
  };

  let mut paths = Vec::new();
  let walk_complete = collect_audio_files(music_path, &mut paths);
  // Sort so the catalog ordering (and thus IDs) is deterministic.
  paths.sort();
  scan_total.store(paths.len(), Ordering::SeqCst);
  scan_processed.store(0, Ordering::SeqCst);

  let existing = db::load_track_stamps(&conn).unwrap_or_else(|e| {
    eprintln!("Scan: could not read cached stamps: {}", e);
    HashMap::new()
  });

  let mut seen: HashSet<String> = HashSet::with_capacity(paths.len());
  let mut changed = 0usize;
  for path in &paths {
    // Count every file examined (skipped or re-read) so the bar tracks how
    // far through the folder the scan is, not just how many files changed.
    scan_processed.fetch_add(1, Ordering::SeqCst);
    let path_str = path.to_string_lossy().to_string();
    let (mtime, size) = file_stamp(path);
    seen.insert(path_str.clone());

    // Skip files that are unchanged since the last scan.
    if let Some((m, s)) = existing.get(&path_str) {
      if *m == mtime && *s == size {
        continue;
      }
    }

    let (artist, title) = read_track_tags(path);
    let lyrics = read_track_lyrics(path);
    let date_added = read_id3v2_user_text(path, "DATE_ADDED");
    let (has_cover, cover_blob, cover_mime) = read_cover(path);
    let track = db::CachedTrack {
      path: path_str,
      mtime,
      size,
      artist,
      title,
      lyrics,
      date_added,
      has_cover,
      cover_blob,
      cover_mime,
    };
    if let Err(e) = db::upsert_track(&conn, &track) {
      eprintln!("Scan: failed to cache {}: {}", track.path, e);
    }
    changed += 1;
  }

  // Drop rows for files that disappeared from disk — but only when we trust
  // the walk. A partial walk (transient read failure on the slow/removable
  // microSD) or an empty result almost always means the volume wasn't fully
  // readable, not that the user deleted their music. Pruning then would wipe
  // cached tracks and make them vanish from the UI until a later full scan,
  // which is exactly the data-loss this guard prevents. New/changed files
  // found above are still upserted; only the destructive prune is skipped.
  let trustworthy = walk_complete && !paths.is_empty();
  if trustworthy {
    for path_str in existing.keys() {
      if !seen.contains(path_str) {
        if let Err(e) = db::delete_track(&conn, path_str) {
          eprintln!("Scan: failed to remove {}: {}", path_str, e);
        }
      }
    }
    // Record a successful full reconcile so a subsequent restart can skip an
    // immediate re-scan (see should_scan_on_startup). Only a trustworthy walk
    // resets the freshness clock; a partial scan leaves it stale on purpose so
    // the next start retries.
    if let Err(e) =
      db::set_meta(&conn, "last_scan", &now_unix_secs().to_string())
    {
      eprintln!("Scan: failed to record last_scan: {}", e);
    }
  } else if !existing.is_empty() {
    eprintln!(
      "Scan: walk incomplete (complete={}, {} file(s) found, {} cached); \
       skipping prune to avoid dropping cached tracks",
      walk_complete,
      paths.len(),
      existing.len()
    );
  }

  match db::load_catalog(&conn) {
    Ok(new_catalog) => {
      let count = new_catalog.tracks.len();
      *catalog.write().unwrap() = new_catalog;
      println!(
        "Scan complete: {} track(s) ({} new/updated)",
        count, changed
      );
    }
    Err(e) => eprintln!("Scan: failed to rebuild catalog: {}", e),
  }
}

impl Catalog {
  // Unique artists, sorted alphabetically (case-insensitive) via BTreeSet
  // ordering. IDs are sequential in the returned slice.
  fn list_artists(&self) -> Vec<Artist> {
    let mut names: BTreeSet<String> = BTreeSet::new();
    for track in &self.tracks {
      for name in split_artists(&track.artist) {
        names.insert(name);
      }
    }
    names
      .into_iter()
      .enumerate()
      .map(|(i, name)| Artist {
        id: i,
        slug: encode(&name),
        name,
      })
      .collect()
  }

  // Tracks belonging to `artist`, in catalog order.
  fn tracks_by_artist(&self, artist: &str) -> Vec<&Track> {
    self
      .tracks
      .iter()
      .filter(|t| artist_matches(&t.artist, artist))
      .collect()
  }

  // Find a track by artist + url-encoded title. If multiple tracks share
  // the same artist and title, the first one in catalog order wins.
  fn find_track(&self, artist: &str, title_slug: &str) -> Option<&Track> {
    let decoded = urlencoding::decode(title_slug).ok()?;
    self
      .tracks
      .iter()
      .find(|t| t.title == decoded && artist_matches(&t.artist, artist))
  }
}

// A playlist is identified by a generated id and contains an ordered list
// of track references. Track refs use `(artist, title)` (matching the URL
// scheme) so they remain stable across catalog rescans, at the cost of
// breaking if the user retags a file — surfaced to the UI as `available:
// false` rather than silently dropped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "rocket::serde")]
struct TrackRef {
  artist: String,
  title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "rocket::serde")]
struct Playlist {
  id: String,
  name: String,
  tracks: Vec<TrackRef>,
  created_at: u64,
  updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(crate = "rocket::serde")]
struct PlaylistFile {
  version: u32,
  playlists: Vec<Playlist>,
}

struct PlaylistStore {
  pool: db::Pool,
  playlists: RwLock<Vec<Playlist>>,
}

fn now_secs() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs())
    .unwrap_or(0)
}

// Generate an opaque id from the current time in nanoseconds. Collisions
// require sub-nanosecond playlist creation on the same machine, which we
// don't worry about for a single-user local app.
fn generate_playlist_id() -> String {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  format!("pl_{:x}", nanos)
}

// Parse a legacy playlists.json file into playlists for one-time import.
fn import_playlists_json(path: &Path) -> Option<Vec<Playlist>> {
  let contents = fs::read_to_string(path).ok()?;
  match serde_json::from_str::<PlaylistFile>(&contents) {
    Ok(file) => Some(file.playlists),
    Err(e) => {
      eprintln!("Warning: could not parse {}: {}", path.display(), e);
      None
    }
  }
}

impl PlaylistStore {
  // Load playlists from the cache database. On first run (empty table) the
  // legacy `playlists.json` — if present — is imported once and persisted to
  // the DB; the JSON file is left in place as a backup.
  fn load(pool: db::Pool, json_fallback: &Path) -> Self {
    let mut playlists = match pool.get() {
      Ok(conn) => db::load_playlists(&conn).unwrap_or_else(|e| {
        eprintln!("Warning: could not load playlists from cache: {}", e);
        Vec::new()
      }),
      Err(e) => {
        eprintln!("Warning: cache connection unavailable: {}", e);
        Vec::new()
      }
    };

    if playlists.is_empty() {
      if let Some(imported) = import_playlists_json(json_fallback) {
        if !imported.is_empty() {
          if let Ok(conn) = pool.get() {
            if let Err(e) = db::save_playlists(&conn, &imported) {
              eprintln!("Failed to import playlists into cache: {}", e);
            }
          }
          println!(
            "Imported {} playlist(s) from {}",
            imported.len(),
            json_fallback.display()
          );
          playlists = imported;
        }
      }
    }

    PlaylistStore {
      pool,
      playlists: RwLock::new(playlists),
    }
  }

  // Persist the full playlist set to the cache database. Fails with a log line
  // — persistence is best-effort and the in-memory state remains authoritative
  // for the current process.
  fn save(&self, playlists: &[Playlist]) {
    match self.pool.get() {
      Ok(conn) => {
        if let Err(e) = db::save_playlists(&conn, playlists) {
          eprintln!("Failed to save playlists: {}", e);
        }
      }
      Err(e) => eprintln!("Failed to get cache connection: {}", e),
    }
  }
}

fn track_to_song(track: &Track) -> Song {
  Song {
    id: track.id,
    title: track.title.clone(),
    slug: encode(&track.title),
    src: format!("/api/{}/{}", encode(&track.artist), encode(&track.title)),
    track_artist: track.artist.clone(),
    artist_slug: encode(&track.artist),
  }
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct Artist {
  id: usize,
  name: String,
  slug: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ArtistResponse {
  error: bool,
  data: Vec<Artist>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct Song {
  id: usize,
  title: String,
  slug: String,
  src: String,
  track_artist: String,
  artist_slug: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct SongResponse {
  data: Vec<Song>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct SingleSong {
  id: usize,
  title: String,
  slug: String,
  track_artist: String,
  lyrics: String,
  src: String,
  file_name: String,
  file_path: String,
  date_added: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct SingleSongResponse {
  data: SingleSong,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ArtistInfo {
  name: String,
  bio: String,
  country: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ArtistInfoResponse {
  data: ArtistInfo,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ErrorResponse {
  error: bool,
  data: String,
}

#[get("/artists")]
fn get_artists(config: &State<AppConfig>) -> Json<ArtistResponse> {
  Json(ArtistResponse {
    error: false,
    data: config.catalog.read().unwrap().list_artists(),
  })
}

// All songs in the catalog, sorted alphabetically by title
// (case-insensitive) so the "Songs" tab can display a flat list.
#[get("/songs")]
fn get_all_songs(config: &State<AppConfig>) -> Json<SongResponse> {
  let catalog = config.catalog.read().unwrap();
  let mut songs: Vec<Song> = catalog.tracks.iter().map(track_to_song).collect();
  songs.sort_by(|a, b| {
    a.title
      .to_lowercase()
      .cmp(&b.title.to_lowercase())
      .then_with(|| {
        a.track_artist
          .to_lowercase()
          .cmp(&b.track_artist.to_lowercase())
      })
  });
  Json(SongResponse { data: songs })
}

#[get("/artists/<artist>/songs")]
fn get_artist_songs(
  artist: &str,
  config: &State<AppConfig>,
) -> Json<SongResponse> {
  let decoded_artist = urlencoding::decode(artist)
    .map(|s| s.into_owned())
    .unwrap_or_else(|_| artist.to_string());

  let catalog = config.catalog.read().unwrap();
  let songs = catalog
    .tracks_by_artist(&decoded_artist)
    .into_iter()
    .map(track_to_song)
    .collect();

  Json(SongResponse { data: songs })
}

#[get("/artists/<artist>/songs/<song>")]
fn get_song(
  artist: &str,
  song: &str,
  config: &State<AppConfig>,
) -> Json<SingleSongResponse> {
  let decoded_artist = urlencoding::decode(artist)
    .map(|s| s.into_owned())
    .unwrap_or_else(|_| artist.to_string());

  let catalog = config.catalog.read().unwrap();
  match catalog.find_track(&decoded_artist, song) {
    Some(track) => {
      let file_name = track
        .path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
      let file_path = track
        .path
        .canonicalize()
        .unwrap_or_else(|_| track.path.clone())
        .to_string_lossy()
        .into_owned();
      // Lyrics and DATE_ADDED come from the cache, not a fresh file read.
      let path_str = track.path.to_string_lossy().to_string();
      let (lyrics, date_added) = match config.pool.get() {
        Ok(conn) => db::get_track_detail(&conn, &path_str)
          .ok()
          .flatten()
          .map(|(l, d)| (l.unwrap_or_default(), d.unwrap_or_default()))
          .unwrap_or_default(),
        Err(_) => (String::new(), String::new()),
      };

      Json(SingleSongResponse {
        data: SingleSong {
          id: track.id,
          title: track.title.clone(),
          slug: encode(&track.title),
          track_artist: track.artist.clone(),
          lyrics,
          src: format!(
            "/api/{}/{}",
            encode(&track.artist),
            encode(&track.title)
          ),
          file_name,
          file_path,
          date_added,
        },
      })
    }
    None => Json(SingleSongResponse {
      data: SingleSong {
        id: 0,
        title: song.to_string(),
        slug: song.to_string(),
        track_artist: decoded_artist,
        lyrics: String::new(),
        src: String::new(),
        file_name: String::new(),
        file_path: String::new(),
        date_added: String::new(),
      },
    }),
  }
}

// Serve the embedded cover art from an audio file's tags. Returns the raw
// image bytes with the appropriate content type, or 404 if no picture is
// embedded.
#[get("/artists/<artist>/songs/<song>/cover")]
fn get_song_cover(
  artist: &str,
  song: &str,
  config: &State<AppConfig>,
) -> Result<(ContentType, Vec<u8>), NotFound<String>> {
  let decoded_artist = urlencoding::decode(artist)
    .map(|s| s.into_owned())
    .unwrap_or_else(|_| artist.to_string());

  let path_str = {
    let catalog = config.catalog.read().unwrap();
    let track = catalog
      .find_track(&decoded_artist, song)
      .ok_or_else(|| NotFound("Track not found".to_string()))?;
    track.path.to_string_lossy().to_string()
  };

  let conn = config
    .pool
    .get()
    .map_err(|_| NotFound("Cache unavailable".to_string()))?;
  let (has_cover, blob, mime) = db::get_cover(&conn, &path_str)
    .map_err(|_| NotFound("Cache error".to_string()))?
    .ok_or_else(|| NotFound("Track not cached".to_string()))?;

  if !has_cover {
    return Err(NotFound("No cover art".to_string()));
  }
  let data = blob.ok_or_else(|| NotFound("No cover art".to_string()))?;
  let content_type = mime
    .as_deref()
    .and_then(ContentType::parse_flexible)
    .unwrap_or(ContentType::JPEG);

  Ok((content_type, data))
}

#[get("/artists/<artist>")]
fn get_artist_info(artist: &str) -> Json<ArtistInfoResponse> {
  let decoded = urlencoding::decode(artist)
    .map(|s| s.into_owned())
    .unwrap_or_else(|_| artist.to_string());
  Json(ArtistInfoResponse {
    data: ArtistInfo {
      name: decoded.clone(),
      bio: format!("This is the bio of {}", decoded),
      country: "Someland".to_string(),
    },
  })
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ReloadData {
  track_count: usize,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ReloadResponse {
  data: ReloadData,
}

// Kick off a background rescan of the music directory and return immediately
// with the current track count. The scan re-reads only changed files and swaps
// in the updated catalog when done; clients poll /api/scan-status to learn when
// it completes. Used when files are added/removed/retagged on disk while the
// server runs, so the UI can pick up changes without a restart.
#[post("/reload")]
fn reload_catalog(config: &State<AppConfig>) -> Json<ReloadResponse> {
  spawn_scan(
    config.pool.clone(),
    config.music_path.clone(),
    config.catalog.clone(),
    config.scanning.clone(),
    config.scan_processed.clone(),
    config.scan_total.clone(),
  );
  let track_count = config.catalog.read().unwrap().tracks.len();
  Json(ReloadResponse {
    data: ReloadData { track_count },
  })
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ScanStatusData {
  scanning: bool,
  track_count: usize,
  // Files examined so far and the total discovered this scan. Both 0 before
  // path collection finishes; `processed == total` once the scan completes.
  processed: usize,
  total: usize,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ScanStatusResponse {
  data: ScanStatusData,
}

// Report whether a background scan is running and the current catalog size, so
// the UI can keep the reload button spinning until the scan finishes and then
// refresh.
#[get("/scan-status")]
fn scan_status(config: &State<AppConfig>) -> Json<ScanStatusResponse> {
  Json(ScanStatusResponse {
    data: ScanStatusData {
      scanning: config.scanning.load(Ordering::SeqCst),
      track_count: config.catalog.read().unwrap().tracks.len(),
      processed: config.scan_processed.load(Ordering::SeqCst),
      total: config.scan_total.load(Ordering::SeqCst),
    },
  })
}

// Playlist API ---------------------------------------------------------------

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct PlaylistSummary {
  id: String,
  name: String,
  track_count: usize,
  created_at: u64,
  updated_at: u64,
  // Only set when the `/playlists` endpoint is queried with `?artist=&title=`,
  // so the UI's "add to playlist" bubble can pre-disable playlists that
  // already contain the song.
  #[serde(skip_serializing_if = "Option::is_none")]
  contains_song: Option<bool>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct PlaylistListResponse {
  data: Vec<PlaylistSummary>,
}

// A hydrated track in a playlist. Fields mirror `Song` so the frontend can
// pass entries straight to `playSong`. `available` is false when the
// catalog no longer contains the referenced `(artist, title)` pair (e.g.
// the file was retagged or removed) — `src`/`slug` are empty in that case.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct PlaylistTrack {
  artist: String,
  title: String,
  available: bool,
  slug: String,
  src: String,
  artist_slug: String,
  track_artist: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct PlaylistDetail {
  id: String,
  name: String,
  created_at: u64,
  updated_at: u64,
  tracks: Vec<PlaylistTrack>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct PlaylistDetailResponse {
  data: PlaylistDetail,
}

#[derive(Deserialize)]
#[serde(crate = "rocket::serde")]
struct CreatePlaylistInput {
  name: String,
}

#[derive(Deserialize)]
#[serde(crate = "rocket::serde")]
struct RenamePlaylistInput {
  name: String,
}

#[derive(Deserialize)]
#[serde(crate = "rocket::serde")]
struct TrackRefInput {
  artist: String,
  title: String,
}

fn summarize(
  playlist: &Playlist,
  contains: Option<(&str, &str)>,
) -> PlaylistSummary {
  let contains_song = contains.map(|(artist, title)| {
    playlist
      .tracks
      .iter()
      .any(|t| t.artist == artist && t.title == title)
  });
  PlaylistSummary {
    id: playlist.id.clone(),
    name: playlist.name.clone(),
    track_count: playlist.tracks.len(),
    created_at: playlist.created_at,
    updated_at: playlist.updated_at,
    contains_song,
  }
}

fn hydrate(playlist: &Playlist, catalog: &Catalog) -> PlaylistDetail {
  let tracks = playlist
    .tracks
    .iter()
    .map(|tr| {
      match catalog
        .tracks
        .iter()
        .find(|t| t.artist == tr.artist && t.title == tr.title)
      {
        Some(t) => PlaylistTrack {
          artist: tr.artist.clone(),
          title: tr.title.clone(),
          available: true,
          slug: encode(&t.title),
          src: format!("/api/{}/{}", encode(&t.artist), encode(&t.title)),
          artist_slug: encode(&t.artist),
          track_artist: t.artist.clone(),
        },
        None => PlaylistTrack {
          artist: tr.artist.clone(),
          title: tr.title.clone(),
          available: false,
          slug: String::new(),
          src: String::new(),
          artist_slug: encode(&tr.artist),
          track_artist: tr.artist.clone(),
        },
      }
    })
    .collect();

  PlaylistDetail {
    id: playlist.id.clone(),
    name: playlist.name.clone(),
    created_at: playlist.created_at,
    updated_at: playlist.updated_at,
    tracks,
  }
}

#[get("/playlists?<artist>&<title>")]
fn list_playlists(
  artist: Option<&str>,
  title: Option<&str>,
  store: &State<PlaylistStore>,
) -> Json<PlaylistListResponse> {
  let playlists = store.playlists.read().expect("playlists lock poisoned");
  let contains = match (artist, title) {
    (Some(a), Some(t)) if !a.is_empty() && !t.is_empty() => Some((a, t)),
    _ => None,
  };
  Json(PlaylistListResponse {
    data: playlists.iter().map(|p| summarize(p, contains)).collect(),
  })
}

#[post("/playlists", data = "<input>")]
fn create_playlist(
  input: Json<CreatePlaylistInput>,
  store: &State<PlaylistStore>,
) -> Result<Created<Json<PlaylistDetailResponse>>, Status> {
  let name = input.name.trim();
  if name.is_empty() {
    return Err(Status::BadRequest);
  }
  let now = now_secs();
  let playlist = Playlist {
    id: generate_playlist_id(),
    name: name.to_string(),
    tracks: Vec::new(),
    created_at: now,
    updated_at: now,
  };
  let location = format!("/api/playlists/{}", playlist.id);
  let detail = PlaylistDetail {
    id: playlist.id.clone(),
    name: playlist.name.clone(),
    created_at: playlist.created_at,
    updated_at: playlist.updated_at,
    tracks: Vec::new(),
  };

  let mut playlists = store.playlists.write().expect("playlists lock poisoned");
  playlists.push(playlist);
  store.save(&playlists);
  drop(playlists);

  Ok(Created::new(location).body(Json(PlaylistDetailResponse { data: detail })))
}

#[get("/playlists/<id>")]
fn get_playlist(
  id: &str,
  store: &State<PlaylistStore>,
  config: &State<AppConfig>,
) -> Result<Json<PlaylistDetailResponse>, Status> {
  let playlists = store.playlists.read().expect("playlists lock poisoned");
  let playlist = playlists
    .iter()
    .find(|p| p.id == id)
    .ok_or(Status::NotFound)?;
  Ok(Json(PlaylistDetailResponse {
    data: hydrate(playlist, &config.catalog.read().unwrap()),
  }))
}

#[patch("/playlists/<id>", data = "<input>")]
fn rename_playlist(
  id: &str,
  input: Json<RenamePlaylistInput>,
  store: &State<PlaylistStore>,
  config: &State<AppConfig>,
) -> Result<Json<PlaylistDetailResponse>, Status> {
  let name = input.name.trim();
  if name.is_empty() {
    return Err(Status::BadRequest);
  }

  let mut playlists = store.playlists.write().expect("playlists lock poisoned");
  let playlist = playlists
    .iter_mut()
    .find(|p| p.id == id)
    .ok_or(Status::NotFound)?;
  playlist.name = name.to_string();
  playlist.updated_at = now_secs();
  let detail = hydrate(playlist, &config.catalog.read().unwrap());
  store.save(&playlists);
  Ok(Json(PlaylistDetailResponse { data: detail }))
}

#[delete("/playlists/<id>")]
fn delete_playlist(
  id: &str,
  store: &State<PlaylistStore>,
) -> Result<NoContent, Status> {
  let mut playlists = store.playlists.write().expect("playlists lock poisoned");
  let before = playlists.len();
  playlists.retain(|p| p.id != id);
  if playlists.len() == before {
    return Err(Status::NotFound);
  }
  store.save(&playlists);
  Ok(NoContent)
}

#[post("/playlists/<id>/tracks", data = "<input>")]
fn add_playlist_track(
  id: &str,
  input: Json<TrackRefInput>,
  store: &State<PlaylistStore>,
  config: &State<AppConfig>,
) -> Result<Json<PlaylistDetailResponse>, Status> {
  let artist = input.artist.trim();
  let title = input.title.trim();
  if artist.is_empty() || title.is_empty() {
    return Err(Status::BadRequest);
  }

  let mut playlists = store.playlists.write().expect("playlists lock poisoned");
  let playlist = playlists
    .iter_mut()
    .find(|p| p.id == id)
    .ok_or(Status::NotFound)?;
  if playlist
    .tracks
    .iter()
    .any(|t| t.artist == artist && t.title == title)
  {
    return Err(Status::Conflict);
  }
  playlist.tracks.push(TrackRef {
    artist: artist.to_string(),
    title: title.to_string(),
  });
  playlist.updated_at = now_secs();
  let detail = hydrate(playlist, &config.catalog.read().unwrap());
  store.save(&playlists);
  Ok(Json(PlaylistDetailResponse { data: detail }))
}

#[delete("/playlists/<id>/tracks/<index>")]
fn remove_playlist_track(
  id: &str,
  index: usize,
  store: &State<PlaylistStore>,
  config: &State<AppConfig>,
) -> Result<Json<PlaylistDetailResponse>, Status> {
  let mut playlists = store.playlists.write().expect("playlists lock poisoned");
  let playlist = playlists
    .iter_mut()
    .find(|p| p.id == id)
    .ok_or(Status::NotFound)?;
  if index >= playlist.tracks.len() {
    return Err(Status::NotFound);
  }
  playlist.tracks.remove(index);
  playlist.updated_at = now_secs();
  let detail = hydrate(playlist, &config.catalog.read().unwrap());
  store.save(&playlists);
  Ok(Json(PlaylistDetailResponse { data: detail }))
}

#[put("/playlists/<id>/tracks", data = "<input>")]
fn reorder_playlist_tracks(
  id: &str,
  input: Json<Vec<TrackRefInput>>,
  store: &State<PlaylistStore>,
  config: &State<AppConfig>,
) -> Result<Json<PlaylistDetailResponse>, Status> {
  let mut playlists = store.playlists.write().expect("playlists lock poisoned");
  let playlist = playlists
    .iter_mut()
    .find(|p| p.id == id)
    .ok_or(Status::NotFound)?;
  playlist.tracks = input
    .into_inner()
    .into_iter()
    .map(|t| TrackRef {
      artist: t.artist,
      title: t.title,
    })
    .collect();
  playlist.updated_at = now_secs();
  let detail = hydrate(playlist, &config.catalog.read().unwrap());
  store.save(&playlists);
  Ok(Json(PlaylistDetailResponse { data: detail }))
}

#[catch(404)]
fn not_found() -> Json<ErrorResponse> {
  Json(ErrorResponse {
    error: true,
    data: "Something went wrong".to_string(),
  })
}

// Catch-all route handler for client-side routing
#[get("/<_path..>", rank = 100)]
async fn catch_all(_path: PathBuf) -> Option<rocket::fs::NamedFile> {
  rocket::fs::NamedFile::open("../frontend/public/index.html")
    .await
    .ok()
}

// Serve the audio file for a given artist+song slug by resolving to the
// actual file path via the catalog. The URL shape is intentionally opaque
// — it carries slugs, not filesystem paths.
#[get("/<artist>/<song>", rank = 5)]
async fn get_music_file(
  artist: &str,
  song: &str,
  config: &State<AppConfig>,
) -> Option<FileWithRanges> {
  let decoded_artist = urlencoding::decode(artist).ok()?.into_owned();
  let track_path = {
    let catalog = config.catalog.read().unwrap();
    let track = catalog.find_track(&decoded_artist, song)?;
    track.path.clone()
  };
  let named_file = rocket::fs::NamedFile::open(&track_path).await.ok()?;
  Some(FileWithRanges(named_file))
}

// Custom responder that wraps NamedFile and adds Accept-Ranges header
struct FileWithRanges(rocket::fs::NamedFile);

#[rocket::async_trait]
impl<'r> rocket::response::Responder<'r, 'static> for FileWithRanges {
  fn respond_to(
    self,
    req: &'r rocket::Request<'_>,
  ) -> rocket::response::Result<'static> {
    let mut response = self.0.respond_to(req)?;
    response.set_header(rocket::http::Header::new("Accept-Ranges", "bytes"));
    Ok(response)
  }
}

// Default playlist file location: alongside (i.e. in the parent of) the
// music directory, so it doesn't get scanned and isn't tangled up with the
// audio files themselves. Falls back to "./playlists.json" if the music
// path has no parent (e.g. a bare filename).
fn default_playlists_path(music_path: &Path) -> PathBuf {
  match music_path.parent() {
    Some(p) if !p.as_os_str().is_empty() => p.join("playlists.json"),
    _ => PathBuf::from("playlists.json"),
  }
}

// Default cache database location: fast local storage, deliberately NOT beside
// the music directory — the music may live on slow or removable media (a NAS,
// an SD card, an external/backup drive), and the whole point of the cache is to
// avoid touching that medium for metadata. The cache also holds playlists
// (durable user data), so it goes under Application Support rather than a
// purgeable cache dir. Falls back to the working directory if $HOME is unset.
// Override with the `cache_db_path` config key / `ROCKET_CACHE_DB_PATH`.
fn default_cache_db_path() -> PathBuf {
  if let Some(home) = std::env::var_os("HOME") {
    let dir = PathBuf::from(home).join("Library/Application Support/Tunediver");
    if fs::create_dir_all(&dir).is_ok() {
      return dir.join("tunediver-cache.db");
    }
  }
  PathBuf::from("tunediver-cache.db")
}

#[launch]
fn rocket() -> _ {
  // Read configuration from Rocket.toml
  let figment = rocket::Config::figment();
  let music_path: String = figment
    .extract_inner("music_path")
    .unwrap_or_else(|_| String::from("music"));

  println!("Starting Tunediver with music path: {}", music_path);

  let cache_db_path: PathBuf = figment
    .extract_inner::<String>("cache_db_path")
    .map(PathBuf::from)
    .unwrap_or_else(|_| default_cache_db_path());
  println!("Using cache database: {}", cache_db_path.display());
  let pool =
    db::open_pool(&cache_db_path).expect("Failed to open cache database");

  // Serve immediately from whatever is cached; a background scan below
  // reconciles against the (possibly slow) music folder.
  let catalog = match pool.get() {
    Ok(conn) => db::load_catalog(&conn).unwrap_or_else(|e| {
      eprintln!("Warning: could not load catalog from cache: {}", e);
      Catalog { tracks: Vec::new() }
    }),
    Err(e) => {
      eprintln!("Warning: cache connection unavailable: {}", e);
      Catalog { tracks: Vec::new() }
    }
  };
  let cached_count = catalog.tracks.len();
  println!("Loaded {} track(s) from cache", cached_count);

  let playlists_path: PathBuf = figment
    .extract_inner::<String>("playlists_path")
    .map(PathBuf::from)
    .unwrap_or_else(|_| default_playlists_path(Path::new(&music_path)));
  let playlist_store = PlaylistStore::load(pool.clone(), &playlists_path);

  let catalog = Arc::new(RwLock::new(catalog));
  let scanning = Arc::new(AtomicBool::new(false));
  let scan_processed = Arc::new(AtomicUsize::new(0));
  let scan_total = Arc::new(AtomicUsize::new(0));

  // Decide whether the cache is fresh enough to skip the startup reconcile.
  let startup_scan_max_age_secs: i64 = figment
    .extract_inner("startup_scan_max_age_secs")
    .unwrap_or(DEFAULT_STARTUP_SCAN_MAX_AGE_SECS);
  let last_scan: Option<i64> = pool
    .get()
    .ok()
    .and_then(|conn| db::get_meta(&conn, "last_scan").ok().flatten())
    .and_then(|s| s.parse().ok());

  if should_scan_on_startup(
    cached_count,
    last_scan,
    now_unix_secs(),
    startup_scan_max_age_secs,
  ) {
    // Reconcile the cache with disk in the background so startup stays fast
    // even on slow storage.
    spawn_scan(
      pool.clone(),
      PathBuf::from(&music_path),
      catalog.clone(),
      scanning.clone(),
      scan_processed.clone(),
      scan_total.clone(),
    );
  } else {
    let age = last_scan.map(|t| now_unix_secs().saturating_sub(t));
    println!(
      "Skipping startup scan: cache has {} track(s), last scanned {}s ago \
       (threshold {}s). Use the rescan button or POST /api/reload to force.",
      cached_count,
      age.unwrap_or(0),
      startup_scan_max_age_secs
    );
  }

  let config = AppConfig {
    music_path: PathBuf::from(&music_path),
    pool,
    catalog,
    scanning,
    scan_processed,
    scan_total,
  };

  rocket::build()
    .mount("/", FileServer::from("../frontend/public"))
    .mount(
      "/api",
      routes![
        get_artists,
        get_all_songs,
        get_artist_songs,
        get_artist_info,
        get_song,
        get_song_cover,
        get_music_file,
        reload_catalog,
        scan_status,
        list_playlists,
        create_playlist,
        get_playlist,
        rename_playlist,
        delete_playlist,
        add_playlist_track,
        remove_playlist_track,
        reorder_playlist_tracks,
      ],
    )
    // Catch-all must be mounted last so it doesn't override other routes
    .mount("/", routes![catch_all])
    .register("/", catchers![not_found])
    .manage(config)
    .manage(playlist_store)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn collect_audio_files_skips_dotfiles_and_non_audio() {
    // Fixture tree: a real track, a macOS AppleDouble resource fork, a hidden
    // file, a non-audio file, and a real track inside a subdirectory.
    let dir = std::env::temp_dir().join("tunediver-collect-test");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("sub")).unwrap();
    fs::write(dir.join("song.flac"), b"x").unwrap();
    fs::write(dir.join("._song.flac"), b"x").unwrap(); // AppleDouble junk
    fs::write(dir.join(".DS_Store"), b"x").unwrap(); // hidden, non-audio
    fs::write(dir.join("notes.txt"), b"x").unwrap(); // non-audio
    fs::write(dir.join("sub/track.mp3"), b"x").unwrap();
    fs::write(dir.join("sub/._track.mp3"), b"x").unwrap(); // AppleDouble junk

    let mut found = Vec::new();
    let complete = collect_audio_files(&dir, &mut found);
    assert!(
      complete,
      "a fully readable tree should report a complete walk"
    );
    let mut names: Vec<String> = found
      .iter()
      .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
      .collect();
    names.sort();

    assert_eq!(
      names,
      vec!["song.flac".to_string(), "track.mp3".to_string()]
    );
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn collect_audio_files_reports_unreadable_dir() {
    // A directory that can't be read (here: doesn't exist) must report an
    // incomplete walk so the caller skips pruning the cache.
    let dir = std::env::temp_dir().join("tunediver-missing-dir-xyz");
    let _ = fs::remove_dir_all(&dir);
    let mut found = Vec::new();
    let complete = collect_audio_files(&dir, &mut found);
    assert!(!complete, "an unreadable directory should taint the walk");
    assert!(found.is_empty());
  }

  #[test]
  fn startup_scan_decision() {
    // Empty cache always scans (first run), regardless of timestamp.
    assert!(should_scan_on_startup(0, Some(1000), 1000, 86_400));
    // Populated cache, fresh scan within the window -> skip.
    assert!(!should_scan_on_startup(
      500,
      Some(1000),
      1000 + 3600,
      86_400
    ));
    // Populated cache, last scan older than the window -> scan.
    assert!(should_scan_on_startup(
      500,
      Some(1000),
      1000 + 90_000,
      86_400
    ));
    // Populated cache but no recorded scan -> scan.
    assert!(should_scan_on_startup(500, None, 5000, 86_400));
    // max_age <= 0 forces a scan even with a fresh timestamp.
    assert!(should_scan_on_startup(500, Some(4999), 5000, 0));
    // Clock skew (now before last_scan) reads as fresh -> skip.
    assert!(!should_scan_on_startup(500, Some(9000), 5000, 86_400));
  }

  #[test]
  fn split_artists_separates_collaborations() {
    // " / " (spaced) and ";" split into individual artists.
    assert_eq!(
      split_artists("Bobby McFerrin / Chick Corea"),
      vec!["Bobby McFerrin", "Chick Corea"]
    );
    assert_eq!(
      split_artists("2Pac;K-Ci & JoJo"),
      vec!["2Pac", "K-Ci & JoJo"]
    );
    // A single artist yields one element.
    assert_eq!(split_artists("Chick Corea"), vec!["Chick Corea"]);
  }

  #[test]
  fn split_artists_preserves_names_with_bare_slash() {
    // Without surrounding spaces a slash is part of the name, not a
    // separator — band names must stay intact.
    assert_eq!(split_artists("AC/DC"), vec!["AC/DC"]);
    assert_eq!(split_artists("Usher/Pitbull"), vec!["Usher/Pitbull"]);
    assert_eq!(split_artists("fwd/slash"), vec!["fwd/slash"]);
  }

  #[test]
  fn artist_matches_full_string_and_each_participant() {
    let full = "Bobby McFerrin / Chick Corea";
    assert!(artist_matches(full, full)); // verbatim (link from credit)
    assert!(artist_matches(full, "Bobby McFerrin")); // participant
    assert!(artist_matches(full, "Chick Corea")); // participant
    assert!(!artist_matches(full, "Herbie Hancock"));
  }

  #[test]
  fn catalog_unifies_artists_across_collaborations() {
    let track = |id, artist: &str| Track {
      id,
      artist: artist.to_string(),
      title: format!("Song {}", id),
      path: PathBuf::from(format!("/{}.mp3", id)),
    };
    let catalog = Catalog {
      tracks: vec![
        track(0, "Bobby McFerrin / Chick Corea"),
        track(1, "Chick Corea"),
        track(2, "Bobby McFerrin"),
        track(3, "Chick Corea / Bobby McFerrin"),
      ],
    };

    // Exactly two artist entries despite four distinct tag strings.
    let names: Vec<String> =
      catalog.list_artists().into_iter().map(|a| a.name).collect();
    assert_eq!(names, vec!["Bobby McFerrin", "Chick Corea"]);

    // Each artist's page gathers every track they appear on.
    let mcferrin: Vec<usize> = catalog
      .tracks_by_artist("Bobby McFerrin")
      .iter()
      .map(|t| t.id)
      .collect();
    assert_eq!(mcferrin, vec![0, 2, 3]);

    // The original collaboration credit still resolves verbatim.
    assert!(catalog
      .tracks_by_artist("Chick Corea / Bobby McFerrin")
      .iter()
      .any(|t| t.id == 3));
  }
}
