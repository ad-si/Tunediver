#[macro_use]
extern crate rocket;
mod db;
mod waveform;

use rocket::serde::{json::Json, Deserialize, Serialize};
use rocket::State;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rust_embed::RustEmbed;

use lofty::ape::ApeTag;
use lofty::config::ParseOptions;
use lofty::file::{AudioFile, FileType, TaggedFileExt};
use lofty::id3::v1::Id3v1Tag;
use lofty::id3::v2::{Frame, Id3v2Tag, Id3v2Version};
use lofty::iff::aiff::AiffTextChunks;
use lofty::iff::wav::RiffInfoList;
use lofty::mp4::{AtomData, AtomIdent, Ilst};
use lofty::ogg::{OggPictureStorage, VorbisComments};
use lofty::picture::MimeType;
use lofty::probe::Probe;
use lofty::read_from_path;
use lofty::tag::{Accessor, ItemKey, ItemValue, TagType};
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
  // Every credited artist as its own entry. Multi-artist files store their
  // collaborators either as separate ARTIST tag fields or as one delimited
  // string; both are resolved to this list at read time (see read_track_tags),
  // so the rest of the app never has to re-split a credit string.
  artists: Vec<String>,
  title: String,
  // Every genre the track is tagged with, resolved from the GENRE tag(s) the
  // same way artists are (multiple fields and delimited strings both yield a
  // flat list). Empty when the file carries no genre tag — such tracks simply
  // don't surface in the genre browser.
  genres: Vec<String>,
  // Release year from the file's date tag, when it carries a parseable one.
  // `None` for untagged files — they simply don't contribute to an artist's
  // release timeframe rather than being counted as year 0.
  year: Option<i32>,
  path: PathBuf,
  // URL slug key that `find_track` resolves back to this track. Normally the
  // plain title; when several files share the same (artist, title) it carries
  // a path-derived discriminator so each file is individually addressable.
  // Populated by `assign_track_slugs` when the catalog is built.
  slug: String,
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

// Whether a track (described by its list of individual artists) belongs to
// `query`. Matches when `query` is one of the participants — what makes a
// collaboration reachable from each artist's page — or when `query` is a
// full credit string (any recognized separator) naming exactly this set, so
// links built from an original delimited credit keep resolving.
fn artists_match(artists: &[String], query: &str) -> bool {
  if artists.iter().any(|a| a == query) {
    return true;
  }
  // The exact credit line this track produces ("A, B"), e.g. a playlist ref
  // added from `track_artist`. Checked directly because `split_artists` never
  // treats a comma as a separator, so it can't reconstruct this form.
  if artist_credit(artists) == query {
    return true;
  }
  // A credit delimited the older way (" / " or ";"), e.g. a legacy playlist
  // ref or a bookmarked URL, naming exactly this set.
  let parts = split_artists(query);
  parts.len() > 1 && parts == artists
}

// Split a genre tag value into individual genres. Genre names — unlike artist
// names ("AC/DC", "Grover Washington, Jr.") — contain neither slashes nor
// commas, so all the delimiters seen in the wild ("Rock/Pop", "Rock, Pop",
// "Rock; Pop") can be treated as separators without a surrounding-space rule.
fn split_genres(genre: &str) -> Vec<String> {
  genre
    .split(['/', ';', ','])
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .collect()
}

// A single, human-readable credit line for a track's artists. Also serves as
// the stable identity a playlist track ref is keyed by. Uses ", " because it
// reads naturally and `split_artists` never treats a comma as a separator (so
// names like "Grover Washington, Jr." survive intact).
fn artist_credit(artists: &[String]) -> String {
  artists.join(", ")
}

// The primary (first-credited) artist, used for a track's canonical URL and
// slug. Falls back to "Unknown Artist" for the degenerate empty list, which
// `read_track_tags`/`load_catalog` already guard against.
fn primary_artist(artists: &[String]) -> &str {
  artists
    .first()
    .map(String::as_str)
    .unwrap_or(UNKNOWN_ARTIST)
}

// Everything `read_track_tags` pulls out of a file's embedded tags in one
// pass. Grouped in a struct rather than returned as a tuple because the scan
// is the only caller and a four-element tuple stops being self-describing.
struct TrackTags {
  artists: Vec<String>,
  title: String,
  genres: Vec<String>,
  year: Option<i32>,
  // The date tag as a display-ready string; `None` exactly when `year` is.
  release_date: Option<String>,
}

// A file's date tag reduced to the two things the app shows: the release year
// (which drives an artist's release timeframe) and the date as text.
struct ReleaseDate {
  year: i32,
  // "1968", "1968-05" or "1968-05-03" — as much of the date as the tag
  // actually carried, with the separators normalized to ISO dashes.
  text: String,
}

// Parse a date tag value. Tag dates range from a bare "1968" through
// "1968-05-03" to a full "1968-05-03T00:00:00", and some taggers write
// "1968/05/03", so read the leading four-digit year and then whatever
// plausible month and day follow it. Values that don't start with a plausible
// year (blank, "0000", "Unknown") yield None so they can't drag an artist's
// timeframe back to antiquity; a year followed by anything unrecognized keeps
// the year and drops the rest.
fn parse_release_date(value: &str) -> Option<ReleaseDate> {
  let value = value.trim();
  let digits: String = value.chars().take_while(char::is_ascii_digit).collect();
  if digits.len() != 4 {
    return None;
  }
  let year = digits.parse::<i32>().ok()?;
  // Recorded music starts in the 1800s; anything outside that is a bad tag.
  if !(1800..=2999).contains(&year) {
    return None;
  }

  // Month, then day: each a single-byte separator plus exactly two digits in
  // the plausible range. The first part that doesn't fit ends the date, so a
  // trailing time ("…T00:00:00") or note ("1968 (remaster)") is dropped
  // rather than mangled.
  let mut text = digits;
  let mut rest = &value[4..];
  for max in [12u32, 31] {
    if !matches!(rest.chars().next(), Some('-' | '/' | '.')) {
      break;
    }
    let part: String =
      rest[1..].chars().take_while(char::is_ascii_digit).collect();
    match part.parse::<u32>() {
      Ok(n) if part.len() == 2 && (1..=max).contains(&n) => {
        text.push('-');
        text.push_str(&part);
        rest = &rest[1 + part.len()..];
      }
      _ => break,
    }
  }
  Some(ReleaseDate { year, text })
}

// Read the file's date tag, in key preference order: the recording date is
// what most taggers write (ID3 TDRC, Vorbis DATE, MP4 ©day), with the release
// dates as fallbacks for files that only carry those. Read as raw strings
// rather than via `Accessor::date()`, which parses strictly and drops the
// common bare-year and partial-date forms.
fn read_release_date(tag: &lofty::tag::Tag) -> Option<ReleaseDate> {
  [
    lofty::tag::ItemKey::RecordingDate,
    lofty::tag::ItemKey::Year,
    lofty::tag::ItemKey::ReleaseDate,
    lofty::tag::ItemKey::OriginalReleaseDate,
  ]
  .into_iter()
  .find_map(|key| tag.get_string(key).and_then(parse_release_date))
}

// Read the credited artists, title, genres, and release year from the file's
// embedded tags. Each ARTIST/GENRE field is split on the recognized separators
// and the results are flattened, so a file that stores multiple values as
// separate fields *or* as one delimited string both yield the same
// fully-resolved list. Falls back to ["Unknown Artist"] / "Unknown Title" when
// tags are missing or unreadable (genres stay empty and the year stays None —
// no placeholders); never consults the filename or directory name.
fn read_track_tags(path: &Path) -> TrackTags {
  let tagged = match read_from_path(path) {
    Ok(t) => t,
    Err(_) => {
      return TrackTags {
        artists: vec![UNKNOWN_ARTIST.to_string()],
        title: UNKNOWN_TITLE.to_string(),
        genres: Vec::new(),
        year: None,
        release_date: None,
      }
    }
  };

  let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
  let (artists, title, genres, date) = match tag {
    Some(t) => {
      // `Accessor::artist()` yields only the first ARTIST value, silently
      // dropping the rest on files (notably Opus/Vorbis comments) that store
      // each collaborator in its own field. Collect every value instead, then
      // split each on the recognized separators so single-field delimited
      // credits resolve the same way. `split_artists` trims and drops empties.
      let artists: Vec<String> = t
        .get_strings(lofty::tag::ItemKey::TrackArtist)
        .flat_map(split_artists)
        .collect();
      // GENRE fields get the same treatment (via the genre separator set).
      let genres: Vec<String> = t
        .get_strings(lofty::tag::ItemKey::Genre)
        .flat_map(split_genres)
        .collect();
      (
        artists,
        t.title().map(|s| s.to_string()).unwrap_or_default(),
        genres,
        read_release_date(t),
      )
    }
    None => (Vec::new(), String::new(), Vec::new(), None),
  };

  // An empty list (no/blank ARTIST tags) falls back to the placeholder so the
  // track still surfaces under a stable identity.
  let artists = if artists.is_empty() {
    vec![UNKNOWN_ARTIST.to_string()]
  } else {
    artists
  };
  // Trim stray whitespace from the title — some files ship with leading or
  // trailing spaces in the `TIT2`/title frame, which would otherwise prevent
  // (artist, title)-based lookups (e.g. playlist track refs) from matching.
  let title = if title.trim().is_empty() {
    UNKNOWN_TITLE.to_string()
  } else {
    title.trim().to_string()
  };
  TrackTags {
    artists,
    title,
    genres,
    year: date.as_ref().map(|d| d.year),
    release_date: date.map(|d| d.text),
  }
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

// Human-readable container/format name for a lofty `FileType`, falling back to
// the uppercased file extension for anything lofty doesn't specifically name
// (custom resolvers, future variants).
fn format_name(file_type: FileType, path: &Path) -> Option<String> {
  let name = match file_type {
    FileType::Mpeg => "MP3",
    FileType::Flac => "FLAC",
    FileType::Mp4 => "MP4/M4A",
    FileType::Aac => "AAC",
    FileType::Opus => "Opus",
    FileType::Vorbis => "Ogg Vorbis",
    FileType::Speex => "Speex",
    FileType::Wav => "WAV",
    FileType::Aiff => "AIFF",
    FileType::Ape => "APE",
    FileType::WavPack => "WavPack",
    FileType::Mpc => "Musepack",
    _ => {
      return path
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| !e.is_empty())
        .map(|e| e.to_uppercase())
    }
  };
  Some(name.to_string())
}

// Read the technical stream properties (length, bitrate, sample rate, bit
// depth, channel count, format) from the audio file itself. Called during a
// scan and as a lazy backfill, so the per-request detail endpoint serves these
// from the cache without reopening the (possibly slow) audio file. Returns an
// all-`None` `AudioProps` if the file can't be parsed.
fn read_audio_properties(path: &Path) -> db::AudioProps {
  let tagged = match read_from_path(path) {
    Ok(t) => t,
    Err(_) => return db::AudioProps::default(),
  };
  let props = tagged.properties();
  // A duration of zero means lofty couldn't determine one; report it as
  // absent rather than a misleading "0:00".
  let duration = props.duration().as_secs();
  db::AudioProps {
    duration_secs: (duration > 0).then_some(duration as i64),
    bitrate_kbps: props.overall_bitrate().map(|b| b as i64),
    sample_rate_hz: props.sample_rate().map(|s| s as i64),
    bit_depth: props.bit_depth().map(|d| d as i64),
    channels: props.channels().map(|c| c as i64),
    format: format_name(tagged.file_type(), path),
  }
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

    // Skip files that are unchanged since the last scan — but only if they
    // were also read by the current tag-reading version. A stale `tags_v`
    // forces a re-read even when mtime/size match, so a logic improvement
    // (e.g. multi-artist parsing) heals older cached rows.
    if let Some((m, s, tags_v)) = existing.get(&path_str) {
      if *m == mtime && *s == size && *tags_v >= db::CURRENT_TAGS_VERSION {
        continue;
      }
    }

    let tags = read_track_tags(path);
    let lyrics = read_track_lyrics(path);
    let date_added = read_id3v2_user_text(path, "DATE_ADDED");
    let (has_cover, cover_blob, cover_mime) = read_cover(path);
    let props = read_audio_properties(path);
    let track = db::CachedTrack {
      path: path_str,
      mtime,
      size,
      artists: tags.artists,
      title: tags.title,
      genres: tags.genres,
      year: tags.year.map(i64::from),
      release_date: tags.release_date,
      lyrics,
      date_added,
      has_cover,
      cover_blob,
      cover_mime,
      props,
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
      for name in &track.artists {
        names.insert(name.clone());
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

  // Unique genres, sorted via BTreeSet ordering. IDs are sequential in the
  // returned slice. Tracks without a genre tag contribute nothing.
  fn list_genres(&self) -> Vec<Genre> {
    let mut names: BTreeSet<String> = BTreeSet::new();
    for track in &self.tracks {
      for name in &track.genres {
        names.insert(name.clone());
      }
    }
    names
      .into_iter()
      .enumerate()
      .map(|(i, name)| Genre {
        id: i,
        slug: encode(&name),
        name,
      })
      .collect()
  }

  // Tracks tagged with `genre`, in catalog order.
  fn tracks_by_genre(&self, genre: &str) -> Vec<&Track> {
    self
      .tracks
      .iter()
      .filter(|t| t.genres.iter().any(|g| g == genre))
      .collect()
  }

  // Tracks belonging to `artist`, in catalog order.
  fn tracks_by_artist(&self, artist: &str) -> Vec<&Track> {
    self
      .tracks
      .iter()
      .filter(|t| artists_match(&t.artists, artist))
      .collect()
  }

  // Find a track by artist + url-encoded slug. For a track with a unique
  // (artist, title) the slug is just its title; files that share an
  // (artist, title) carry a path-derived discriminator (see
  // `assign_track_slugs`), so each resolves to its own file rather than all
  // collapsing onto the first match.
  fn find_track(&self, artist: &str, slug: &str) -> Option<&Track> {
    let decoded = urlencoding::decode(slug).ok()?;
    self
      .tracks
      .iter()
      .find(|t| t.slug == decoded && artists_match(&t.artists, artist))
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
  // When this track was added to the playlist, as an ISO 8601 string (e.g.
  // "2016-08-19T20:09:09Z"). Imported from external sources such as a Spotify
  // CSV export; `None` for tracks added before this field existed or without a
  // known timestamp.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  added_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(crate = "rocket::serde")]
struct Playlist {
  id: String,
  name: String,
  tracks: Vec<TrackRef>,
  created_at: u64,
  updated_at: u64,
  // The display sort last selected for this playlist ("index" / "added-asc" /
  // "added-desc"). `None` for playlists whose sort was never changed; the
  // client falls back to its own default in that case.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  sort_order: Option<String>,
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

// Format the current UTC time as an ISO 8601 timestamp (e.g.
// "2016-08-19T20:09:09Z"), matching the format used for playlist `added_at`
// values imported from playlists.json. Computed without a date crate via
// Howard Hinnant's days-to-civil algorithm.
fn now_iso8601() -> String {
  let secs = now_secs() as i64;
  let days = secs.div_euclid(86_400);
  let rem = secs.rem_euclid(86_400);
  let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z.rem_euclid(146_097);
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };

  format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

// Generate an opaque id from the current time in nanoseconds. Collisions
// require sub-nanosecond playlist creation on the same machine, which we
// don't worry about for a single-user local app.
fn generate_playlist_id() -> String {
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  format!("{nanos:x}")
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

// Short, stable, URL-safe discriminator derived from a track's file path,
// used to tell apart multiple files that carry identical (artist, title) tags
// (e.g. a studio and an acoustic recording tagged the same, or duplicate
// copies). FNV-1a over the path bytes — a fixed algorithm, so the value is
// stable across restarts and rescans as long as the file keeps its path,
// independent of the standard library's (unspecified) default hasher.
fn path_discriminator(path: &Path) -> String {
  let mut hash: u32 = 0x811c_9dc5;
  for byte in path.to_string_lossy().bytes() {
    hash ^= byte as u32;
    hash = hash.wrapping_mul(0x0100_0193);
  }
  format!("{:08x}", hash)
}

// Assign every track its URL slug key (the value `find_track` resolves back).
// A track whose (artist, title) is unique in the catalog gets the plain title,
// so its URLs stay clean and unchanged. When several files share the same
// (artist, title) — the pair the catalog otherwise resolves by — each gets a
// path-derived discriminator appended, so all of them become individually
// addressable instead of every copy collapsing onto the first match. The slug
// is stored decoded; endpoints URL-encode it when building links.
fn assign_track_slugs(tracks: &mut [Track]) {
  let mut counts: HashMap<(String, String), usize> = HashMap::new();
  for t in tracks.iter() {
    *counts
      .entry((artist_credit(&t.artists), t.title.clone()))
      .or_insert(0) += 1;
  }
  for t in tracks.iter_mut() {
    let ambiguous = counts
      .get(&(artist_credit(&t.artists), t.title.clone()))
      .copied()
      .unwrap_or(1)
      > 1;
    t.slug = if ambiguous {
      format!("{} ({})", t.title, path_discriminator(&t.path))
    } else {
      t.title.clone()
    };
  }
}

fn track_to_song(track: &Track) -> Song {
  let primary = primary_artist(&track.artists);
  Song {
    id: track.id,
    title: track.title.clone(),
    slug: encode(&track.slug),
    src: format!("/api/{}/{}", encode(primary), encode(&track.slug)),
    track_artist: artist_credit(&track.artists),
    track_artists: track.artists.clone(),
    artist_slug: encode(primary),
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
struct Genre {
  id: usize,
  name: String,
  slug: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct GenreResponse {
  error: bool,
  data: Vec<Genre>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct Song {
  id: usize,
  title: String,
  slug: String,
  src: String,
  // A single, ready-to-display credit line ("A, B, C"); also the identity a
  // playlist track ref is keyed by.
  track_artist: String,
  // The individual credited artists, so the UI can render one link per artist.
  track_artists: Vec<String>,
  // Slug of the primary (first-credited) artist — the track's canonical URL.
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
  track_artists: Vec<String>,
  lyrics: String,
  src: String,
  file_name: String,
  file_path: String,
  date_added: String,
  // The file's date tag ("1968", "1968-05" or "1968-05-03"), absent when it
  // carries none that parses.
  #[serde(skip_serializing_if = "Option::is_none")]
  release_date: Option<String>,
  // Technical audio properties. Absent (skipped) when unknown, so the frontend
  // can omit the corresponding row rather than render a blank or "0".
  #[serde(skip_serializing_if = "Option::is_none")]
  duration_secs: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  bitrate_kbps: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  sample_rate_hz: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  bit_depth: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  channels: Option<i64>,
  #[serde(skip_serializing_if = "Option::is_none")]
  format: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  file_size: Option<i64>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct SingleSongResponse {
  data: SingleSong,
}

// One genre the artist's tracks are tagged with, plus how many of them carry
// it — the weight the frontend sizes its tag cloud by.
#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ArtistGenre {
  name: String,
  slug: String,
  count: usize,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct ArtistInfo {
  name: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  bio: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  country: Option<String>,
  // How many catalog tracks credit this artist.
  song_count: usize,
  // Oldest and newest release year among those tracks. Absent when none of
  // them carries a parseable date tag; both are equal for a single year.
  #[serde(skip_serializing_if = "Option::is_none")]
  first_year: Option<i32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  last_year: Option<i32>,
  // Genres across those tracks, most-used first (ties broken alphabetically).
  genres: Vec<ArtistGenre>,
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

#[get("/genres")]
fn get_genres(config: &State<AppConfig>) -> Json<GenreResponse> {
  Json(GenreResponse {
    error: false,
    data: config.catalog.read().unwrap().list_genres(),
  })
}

// All songs tagged with `genre`, sorted alphabetically by title then artist
// (case-insensitive) — like /songs, since a genre spans many artists.
#[get("/genres/<genre>/songs")]
fn get_genre_songs(
  genre: &str,
  config: &State<AppConfig>,
) -> Json<SongResponse> {
  let decoded_genre = urlencoding::decode(genre)
    .map(|s| s.into_owned())
    .unwrap_or_else(|_| genre.to_string());

  let catalog = config.catalog.read().unwrap();
  let mut songs: Vec<Song> = catalog
    .tracks_by_genre(&decoded_genre)
    .into_iter()
    .map(track_to_song)
    .collect();
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
      // Lyrics, DATE_ADDED, the release date, and technical properties come
      // from the cache, not a fresh file read. Values for rows that predate
      // the cache columns are backfilled lazily here: read from disk once,
      // persist, then serve.
      let path_str = track.path.to_string_lossy().to_string();
      let (lyrics, date_added, release_date, props, file_size) =
        match config.pool.get() {
          Ok(conn) => {
            let (lyrics, date_added, release_date) =
              db::get_track_detail(&conn, &path_str)
                .ok()
                .flatten()
                .map(|(l, d, r)| {
                  (l.unwrap_or_default(), d.unwrap_or_default(), r)
                })
                .unwrap_or_default();
            // The row's `year` comes from the very tag the release date does,
            // so a set year with no date string means the row predates the
            // column: re-read that one tag and cache it. Tracks without a year
            // have no date to find, and are left alone.
            let release_date = match (&release_date, track.year) {
              (None, Some(_)) => {
                let fresh = read_track_tags(&track.path).release_date;
                let _ = db::update_track_release_date(
                  &conn,
                  &path_str,
                  fresh.as_deref(),
                );
                fresh
              }
              _ => release_date,
            };
            let (props, size) = db::get_track_properties(&conn, &path_str)
              .ok()
              .flatten()
              .unwrap_or_default();
            // `format == None` means the row predates these columns; probe the
            // file once and cache the result so later views stay cache-served.
            let props = if props.format.is_none() {
              let fresh = read_audio_properties(&track.path);
              let _ = db::update_track_properties(&conn, &path_str, &fresh);
              fresh
            } else {
              props
            };
            (lyrics, date_added, release_date, props, Some(size))
          }
          Err(_) => (
            String::new(),
            String::new(),
            None,
            db::AudioProps::default(),
            None,
          ),
        };

      Json(SingleSongResponse {
        data: SingleSong {
          id: track.id,
          title: track.title.clone(),
          slug: encode(&track.slug),
          track_artist: artist_credit(&track.artists),
          track_artists: track.artists.clone(),
          lyrics,
          src: format!(
            "/api/{}/{}",
            encode(primary_artist(&track.artists)),
            encode(&track.slug)
          ),
          file_name,
          file_path,
          date_added,
          release_date,
          duration_secs: props.duration_secs,
          bitrate_kbps: props.bitrate_kbps,
          sample_rate_hz: props.sample_rate_hz,
          bit_depth: props.bit_depth,
          channels: props.channels,
          format: props.format,
          // A cached size of 0 is a not-yet-stamped placeholder, not a real
          // empty file; suppress it so the UI omits the row.
          file_size: file_size.filter(|&s| s > 0),
        },
      })
    }
    None => Json(SingleSongResponse {
      data: SingleSong {
        id: 0,
        title: song.to_string(),
        slug: song.to_string(),
        track_artists: vec![decoded_artist.clone()],
        track_artist: decoded_artist,
        lyrics: String::new(),
        src: String::new(),
        file_name: String::new(),
        file_path: String::new(),
        date_added: String::new(),
        release_date: None,
        duration_secs: None,
        bitrate_kbps: None,
        sample_rate_hz: None,
        bit_depth: None,
        channels: None,
        format: None,
        file_size: None,
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

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct WaveformResponse {
  // One 0-255 amplitude value per horizontal slice of the track, normalized so
  // the loudest moment of the track is 255.
  peaks: Vec<u8>,
}

// Serve the amplitude peaks the transport draws its waveform from.
//
// Producing them means decoding the entire file, which takes seconds, so the
// result is cached in the DB and only recomputed when the file changes. The
// decode runs on a blocking thread so it can't stall the async workers serving
// everything else. 404 means no waveform is available (unknown track, or a
// codec the decoder can't read) and the client falls back to a plain bar.
#[get("/artists/<artist>/songs/<song>/waveform")]
async fn get_song_waveform(
  artist: &str,
  song: &str,
  config: &State<AppConfig>,
) -> Result<Json<WaveformResponse>, NotFound<String>> {
  let decoded_artist = urlencoding::decode(artist)
    .map(|s| s.into_owned())
    .unwrap_or_else(|_| artist.to_string());

  let path = {
    let catalog = config.catalog.read().unwrap();
    let track = catalog
      .find_track(&decoded_artist, song)
      .ok_or_else(|| NotFound("Track not found".to_string()))?;
    track.path.clone()
  };

  let pool = config.pool.clone();
  let peaks = rocket::tokio::task::spawn_blocking(move || {
    cached_waveform_peaks(&pool, &path)
  })
  .await
  .map_err(|_| NotFound("Waveform extraction failed".to_string()))?
  .ok_or_else(|| NotFound("No waveform available".to_string()))?;

  Ok(Json(WaveformResponse { peaks }))
}

// Peaks for one file, from the cache when they're there and by decoding the
// file when they aren't. Blocking, and slow on a cache miss. Returns None for
// a file that can't be decoded — which is cached too, so the next request for
// the same track doesn't pay for the failed decode again.
fn cached_waveform_peaks(pool: &db::Pool, path: &Path) -> Option<Vec<u8>> {
  let path_str = path.to_string_lossy().to_string();
  let (mtime, size) = file_stamp(path);
  let buckets = waveform::BUCKETS as i64;

  let version = waveform::PEAKS_VERSION;

  let conn = pool.get().ok()?;
  match db::get_waveform(&conn, &path_str, mtime, size, buckets, version) {
    Ok(Some(db::CachedWaveform::Peaks(peaks))) => return Some(peaks),
    Ok(Some(db::CachedWaveform::Unavailable)) => return None,
    Ok(None) => {}
    Err(err) => eprintln!("Waveform cache read failed for {path_str}: {err}"),
  }

  let peaks = waveform::compute_peaks(path);
  // A track the scan hasn't reached yet has no `tracks` row for the waveform's
  // foreign key to reference, so this write fails and the peaks are recomputed
  // on a later request — worth it to keep stale waveforms from outliving their
  // track.
  if let Err(err) = db::set_waveform(
    &conn,
    &path_str,
    mtime,
    size,
    buckets,
    version,
    peaks.as_deref(),
  ) {
    eprintln!("Waveform cache write failed for {path_str}: {err}");
  }
  peaks
}

// --- Raw tag metadata -------------------------------------------------------
//
// Everything above reads the handful of fields the catalog understands. The
// detail view's metadata dialog shows the opposite: every tag the file
// actually carries, in the file's own vocabulary.
//
// That rules out the generic `Tag` view lofty hands out, which is lossy by
// design — it keeps only what maps onto a known `ItemKey` and silently drops
// the rest (custom TXXX frames such as our own DATE_ADDED, iTunes freeform
// atoms, anything a tagger invented). So each format is opened through its
// concrete file type and its tags are walked in their native form: ID3v2
// frames keep their four-character IDs, Vorbis comments their field names,
// MP4 atoms their identifiers. The generic view survives only as a fallback
// for file types this doesn't enumerate.

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct MetadataItem {
  // The key exactly as the file stores it ("TIT2", "ALBUMARTIST", "©nam").
  key: String,
  // A readable name for keys that map onto a field lofty knows, so opaque
  // four-character IDs still mean something. None for anything unmapped.
  name: Option<String>,
  value: String,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct MetadataTag {
  // Which tag these items came from ("ID3v2.4", "Vorbis Comments", …).
  kind: String,
  items: Vec<MetadataItem>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct SongMetadata {
  file_name: String,
  file_path: String,
  // One entry per tag present in the file; a file can carry several (an MP3
  // with both ID3v2 and ID3v1, a FLAC with Vorbis comments and an ID3v2 tag).
  tags: Vec<MetadataTag>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct SongMetadataResponse {
  data: SongMetadata,
}

// Every tag in a track's file, read fresh from disk.
//
// Deliberately uncached: this is an explicit, one-track-at-a-time user action,
// and a cache of every frame of every file would dwarf what the cache exists
// for. Reading runs on a blocking thread because the music may live on slow
// removable storage.
#[get("/artists/<artist>/songs/<song>/metadata")]
async fn get_song_metadata(
  artist: &str,
  song: &str,
  config: &State<AppConfig>,
) -> Result<Json<SongMetadataResponse>, NotFound<String>> {
  let decoded_artist = urlencoding::decode(artist)
    .map(|s| s.into_owned())
    .unwrap_or_else(|_| artist.to_string());

  let path = {
    let catalog = config.catalog.read().unwrap();
    let track = catalog
      .find_track(&decoded_artist, song)
      .ok_or_else(|| NotFound("Track not found".to_string()))?;
    track.path.clone()
  };

  let file_name = path
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or("")
    .to_string();
  let file_path = path
    .canonicalize()
    .unwrap_or_else(|_| path.clone())
    .to_string_lossy()
    .into_owned();

  let read_path = path.clone();
  let tags =
    rocket::tokio::task::spawn_blocking(move || read_all_tags(&read_path))
      .await
      .map_err(|_| NotFound("Metadata read failed".to_string()))?;

  Ok(Json(SongMetadataResponse {
    data: SongMetadata {
      file_name,
      file_path,
      tags,
    },
  }))
}

// Read every tag in `path` through its concrete file type. Returns an empty
// list for an untagged or unreadable file.
fn read_all_tags(path: &Path) -> Vec<MetadataTag> {
  use lofty::ape::ApeFile;
  use lofty::flac::FlacFile;
  use lofty::mp4::Mp4File;
  use lofty::mpeg::MpegFile;
  use lofty::musepack::MpcFile;
  use lofty::ogg::{OpusFile, SpeexFile, VorbisFile};
  use lofty::wavpack::WavPackFile;

  let file_type = Probe::open(path)
    .ok()
    .and_then(|p| p.guess_file_type().ok())
    .and_then(|p| p.file_type());
  let (Some(file_type), Ok(mut file)) = (file_type, fs::File::open(path))
  else {
    return generic_tags(path);
  };

  let options = ParseOptions::default();
  let mut tags: Vec<MetadataTag> = Vec::new();

  match file_type {
    FileType::Mpeg => {
      if let Ok(f) = MpegFile::read_from(&mut file, options) {
        push_id3v2(&mut tags, f.id3v2());
        push_id3v1(&mut tags, f.id3v1());
        push_ape(&mut tags, f.ape());
      }
    }
    FileType::Aac => {
      if let Ok(f) = lofty::aac::AacFile::read_from(&mut file, options) {
        push_id3v2(&mut tags, f.id3v2());
        push_id3v1(&mut tags, f.id3v1());
      }
    }
    FileType::Flac => {
      if let Ok(f) = FlacFile::read_from(&mut file, options) {
        push_vorbis(&mut tags, f.vorbis_comments());
        push_id3v2(&mut tags, f.id3v2());
        // FLAC keeps its cover art in standalone picture blocks rather than
        // in the Vorbis comment tag, so they need listing separately.
        push_pictures(&mut tags, "FLAC Picture Blocks", f.pictures());
      }
    }
    FileType::Mp4 => {
      if let Ok(f) = Mp4File::read_from(&mut file, options) {
        push_ilst(&mut tags, f.ilst());
      }
    }
    FileType::Opus => {
      if let Ok(f) = OpusFile::read_from(&mut file, options) {
        push_vorbis(&mut tags, Some(f.vorbis_comments()));
      }
    }
    FileType::Vorbis => {
      if let Ok(f) = VorbisFile::read_from(&mut file, options) {
        push_vorbis(&mut tags, Some(f.vorbis_comments()));
      }
    }
    FileType::Speex => {
      if let Ok(f) = SpeexFile::read_from(&mut file, options) {
        push_vorbis(&mut tags, Some(f.vorbis_comments()));
      }
    }
    FileType::Wav => {
      if let Ok(f) = lofty::iff::wav::WavFile::read_from(&mut file, options) {
        push_riff_info(&mut tags, f.riff_info());
        push_id3v2(&mut tags, f.id3v2());
      }
    }
    FileType::Aiff => {
      if let Ok(f) = lofty::iff::aiff::AiffFile::read_from(&mut file, options) {
        push_aiff_text(&mut tags, f.text_chunks());
        push_id3v2(&mut tags, f.id3v2());
      }
    }
    FileType::Ape => {
      if let Ok(f) = ApeFile::read_from(&mut file, options) {
        push_ape(&mut tags, f.ape());
        push_id3v2(&mut tags, f.id3v2());
        push_id3v1(&mut tags, f.id3v1());
      }
    }
    FileType::WavPack => {
      if let Ok(f) = WavPackFile::read_from(&mut file, options) {
        push_ape(&mut tags, f.ape());
        push_id3v1(&mut tags, f.id3v1());
      }
    }
    FileType::Mpc => {
      if let Ok(f) = MpcFile::read_from(&mut file, options) {
        push_ape(&mut tags, f.ape());
        push_id3v2(&mut tags, f.id3v2());
        push_id3v1(&mut tags, f.id3v1());
      }
    }
    // A format without a concrete reader here (or one added to lofty later):
    // fall back to the generic view, which is lossy but better than nothing.
    _ => return generic_tags(path),
  }

  tags
}

// Fallback for file types `read_all_tags` doesn't enumerate: lofty's generic
// `Tag` view, with each item's key mapped back to the format's own spelling.
fn generic_tags(path: &Path) -> Vec<MetadataTag> {
  let tagged = match read_from_path(path) {
    Ok(t) => t,
    Err(_) => return Vec::new(),
  };

  tagged
    .tags()
    .iter()
    .map(|tag| {
      let tag_type = tag.tag_type();
      let items = tag
        .items()
        .map(|item| {
          let key = item.key();
          MetadataItem {
            key: key
              .map_key(tag_type)
              .map(str::to_string)
              .unwrap_or_else(|| format!("{key:?}")),
            name: Some(split_camel_case(&format!("{key:?}"))),
            value: item_value_string(item.value()),
          }
        })
        .collect();
      MetadataTag {
        kind: tag_type_name(tag_type).to_string(),
        items,
      }
    })
    .collect()
}

fn tag_type_name(tag_type: TagType) -> &'static str {
  match tag_type {
    TagType::Ape => "APE",
    TagType::Id3v1 => "ID3v1",
    TagType::Id3v2 => "ID3v2",
    TagType::Mp4Ilst => "MP4 Atoms",
    TagType::VorbisComments => "Vorbis Comments",
    TagType::RiffInfo => "RIFF INFO",
    TagType::AiffText => "AIFF Text Chunks",
    _ => "Tag",
  }
}

// Insert spaces at word boundaries so a Rust enum name reads as a label
// ("TrackArtist" → "Track Artist"), then put back the acronyms and proper
// nouns that camel case flattened ("Isrc" → "ISRC", "MusicBrainzArtistId" →
// "MusicBrainz Artist ID"). These labels are what the metadata dialog shows,
// so a stray "Acoust Id" reads as a bug rather than a transliteration.
fn split_camel_case(name: &str) -> String {
  let mut words: Vec<String> = Vec::new();
  for ch in name.chars() {
    let starts_word = ch.is_uppercase()
      && words
        .last()
        .and_then(|w| w.chars().last())
        .is_some_and(|last| last.is_lowercase() || last.is_ascii_digit());
    if words.is_empty() || starts_word {
      words.push(String::new());
    }
    if let Some(word) = words.last_mut() {
      word.push(ch);
    }
  }

  for word in words.iter_mut() {
    let fixed = match word.as_str() {
      "Id" => "ID",
      "Isrc" => "ISRC",
      "Url" => "URL",
      "Bpm" => "BPM",
      "Dj" => "DJ",
      _ => continue,
    };
    *word = fixed.to_string();
  }

  // Names that are one word in the wild but two after the split.
  words
    .join(" ")
    .replace("Music Brainz", "MusicBrainz")
    .replace("Acoust ID", "AcoustID")
    .replace("Replay Gain", "ReplayGain")
}

// The readable name of a format-specific key, when lofty maps it onto a field
// it knows. Derived from the `ItemKey` variant's name, which is the only place
// that description exists.
fn friendly_name_for(tag_type: TagType, key: &str) -> Option<String> {
  // These frames/atoms hold "number/total" in a single value, and lofty's key
  // map has an entry for each half; the lookup arbitrarily resolves to the
  // "total" one, which mislabels them. Name them for what they carry.
  match (tag_type, key) {
    (TagType::Id3v2, "TRCK") | (TagType::Mp4Ilst, "trkn") => {
      return Some("Track Number / Total".to_string())
    }
    (TagType::Id3v2, "TPOS") | (TagType::Mp4Ilst, "disk") => {
      return Some("Disc Number / Total".to_string())
    }
    _ => {}
  }
  if let Some(item_key) = ItemKey::from_key(tag_type, key) {
    return Some(split_camel_case(&format!("{item_key:?}")));
  }
  // Frames lofty has no `ItemKey` for at all — mostly the non-text ones, whose
  // four-character IDs are the least guessable of the lot.
  if tag_type == TagType::Id3v2 {
    let name = match key {
      "APIC" => "Picture",
      "COMM" => "Comment",
      "USLT" => "Unsynchronized Lyrics",
      "SYLT" => "Synchronized Lyrics",
      "GEOB" => "Encapsulated Object",
      "PRIV" => "Private Data",
      "UFID" => "Unique File Identifier",
      "MCDI" => "Music CD Identifier",
      "RVA2" => "Relative Volume Adjustment",
      "ETCO" => "Event Timing Codes",
      "OWNE" => "Ownership",
      "PCNT" => "Play Counter",
      "SEEK" => "Seek Point",
      "TDTG" => "Tagging Time",
      _ => return None,
    };
    return Some(name.to_string());
  }
  None
}

fn item_value_string(value: &ItemValue) -> String {
  match value {
    ItemValue::Text(text) | ItemValue::Locator(text) => text.clone(),
    ItemValue::Binary(data) => describe_binary(data),
  }
}

// Binary payloads (encapsulated objects, private frames, …) are summarized
// rather than dumped: the dialog is for reading tags, not hex.
fn describe_binary(data: &[u8]) -> String {
  format!("<{} bytes of binary data>", data.len())
}

fn describe_picture(picture: &lofty::picture::Picture) -> String {
  let mime = picture
    .mime_type()
    .map(MimeType::as_str)
    .unwrap_or("unknown type");
  let kind = split_camel_case(&format!("{:?}", picture.pic_type()));
  let size = picture.data().len();
  match picture.description().filter(|d| !d.is_empty()) {
    Some(desc) => format!("{kind} \"{desc}\" ({mime}, {size} bytes)"),
    None => format!("{kind} ({mime}, {size} bytes)"),
  }
}

// ID3v2 frames, in the order they appear in the file. Frames that carry a
// description or owner (TXXX, WXXX, COMM, USLT, PRIV) get it appended to the
// frame ID, since that is what distinguishes several frames of the same kind.
fn push_id3v2(tags: &mut Vec<MetadataTag>, tag: Option<&Id3v2Tag>) {
  let Some(tag) = tag else { return };

  let items = tag
    .into_iter()
    .map(|frame| {
      let id = frame.id_str().to_string();
      // `lookup` is what the key maps onto a known field by: the frame ID for
      // most frames, but the description for TXXX/WXXX, which is how those
      // carry their identity.
      let (key, lookup, value) = match frame {
        // ID3v2.4 packs multiple values into one frame separated by NULs.
        Frame::Text(f) => (id.clone(), id, f.value.replace('\0', " / ")),
        Frame::UserText(f) => (
          format!("TXXX:{}", f.description),
          f.description.to_string(),
          f.content.replace('\0', " / "),
        ),
        Frame::Url(f) => (id.clone(), id, f.url().to_string()),
        Frame::UserUrl(f) => (
          format!("WXXX:{}", f.description),
          f.description.to_string(),
          f.content.to_string(),
        ),
        Frame::Comment(f) => (
          language_key("COMM", f.language, &f.description),
          id,
          f.content.to_string(),
        ),
        Frame::UnsynchronizedText(f) => (
          language_key("USLT", f.language, &f.description),
          id,
          f.content.to_string(),
        ),
        Frame::Picture(f) => (id.clone(), id, describe_picture(&f.picture)),
        Frame::Popularimeter(f) => (
          id.clone(),
          id,
          format!(
            "{} — rating {}/255, {} play(s)",
            f.email, f.rating, f.counter
          ),
        ),
        Frame::KeyValue(f) => (
          id.clone(),
          id,
          f.key_value_pairs
            .iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect::<Vec<_>>()
            .join(", "),
        ),
        Frame::RelativeVolumeAdjustment(f) => (
          id.clone(),
          id,
          format!("{}: {} channel(s)", f.identification, f.channels.len()),
        ),
        Frame::UniqueFileIdentifier(f) => (
          format!("UFID:{}", f.owner),
          id,
          String::from_utf8(f.identifier.to_vec())
            .unwrap_or_else(|_| describe_binary(&f.identifier)),
        ),
        Frame::Ownership(f) => (
          id.clone(),
          id,
          format!(
            "{} on {} from {}",
            f.price_paid, f.date_of_purchase, f.seller
          ),
        ),
        Frame::EventTimingCodes(f) => {
          (id.clone(), id, format!("{} event(s)", f.events.len()))
        }
        Frame::Private(f) => (
          format!("PRIV:{}", f.owner),
          id,
          describe_binary(&f.private_data),
        ),
        Frame::Timestamp(f) => (id.clone(), id, f.timestamp.to_string()),
        Frame::Binary(f) => (id.clone(), id, describe_binary(&f.data)),
        // `Frame` is non-exhaustive; a variant added later still lists.
        _ => (id.clone(), id, String::new()),
      };
      MetadataItem {
        name: friendly_name_for(TagType::Id3v2, &lookup),
        key,
        value,
      }
    })
    .collect();

  tags.push(MetadataTag {
    kind: match tag.original_version() {
      Id3v2Version::V2 => "ID3v2.2".to_string(),
      Id3v2Version::V3 => "ID3v2.3".to_string(),
      Id3v2Version::V4 => "ID3v2.4".to_string(),
    },
    items,
  });
}

// A COMM/USLT key, qualified by the language and description that distinguish
// several such frames in one tag ("COMM:eng:iTunNORM").
fn language_key(id: &str, language: [u8; 3], description: &str) -> String {
  let lang = String::from_utf8_lossy(&language).trim().to_string();
  match (lang.is_empty(), description.is_empty()) {
    (true, true) => id.to_string(),
    (true, false) => format!("{id}:{description}"),
    (false, true) => format!("{id}:{lang}"),
    (false, false) => format!("{id}:{lang}:{description}"),
  }
}

fn push_id3v1(tags: &mut Vec<MetadataTag>, tag: Option<&Id3v1Tag>) {
  let Some(tag) = tag else { return };

  // ID3v1 is a fixed set of fields rather than a list of items, so the keys
  // (and their names) are ours to spell out.
  let mut items = Vec::new();
  let mut push = |key: &str, name: &str, value: Option<String>| {
    if let Some(value) = value {
      items.push(MetadataItem {
        key: key.to_string(),
        name: Some(name.to_string()),
        value,
      });
    }
  };
  push("TITLE", "Track Title", tag.title.clone());
  push("ARTIST", "Track Artist", tag.artist.clone());
  push("ALBUM", "Album Title", tag.album.clone());
  push("YEAR", "Year", tag.year.map(|y| y.to_string()));
  push("COMMENT", "Comment", tag.comment.clone());
  push(
    "TRACK",
    "Track Number",
    tag.track_number.map(|t| t.to_string()),
  );
  // ID3v1 stores the genre as an index into a fixed list.
  push(
    "GENRE",
    "Genre",
    tag.genre.map(|g| {
      lofty::id3::v1::GENRES
        .get(g as usize)
        .map_or_else(|| format!("Unknown ({g})"), |name| (*name).to_string())
    }),
  );

  tags.push(MetadataTag {
    kind: "ID3v1".to_string(),
    items,
  });
}

fn push_ape(tags: &mut Vec<MetadataTag>, tag: Option<&ApeTag>) {
  let Some(tag) = tag else { return };

  let items = tag
    .into_iter()
    .map(|item| MetadataItem {
      name: friendly_name_for(TagType::Ape, item.key()),
      key: item.key().to_string(),
      value: item_value_string(item.value()),
    })
    .collect();

  tags.push(MetadataTag {
    kind: "APE".to_string(),
    items,
  });
}

fn push_vorbis(tags: &mut Vec<MetadataTag>, tag: Option<&VorbisComments>) {
  let Some(tag) = tag else { return };

  let mut items: Vec<MetadataItem> = tag
    .items()
    .map(|(key, value)| MetadataItem {
      name: friendly_name_for(TagType::VorbisComments, key),
      key: key.to_string(),
      value: value.to_string(),
    })
    .collect();

  // Not a comment field, but part of what the tag stores.
  if !tag.vendor().is_empty() {
    items.push(MetadataItem {
      key: "VENDOR".to_string(),
      name: Some("Encoder vendor string".to_string()),
      value: tag.vendor().to_string(),
    });
  }
  for (picture, _) in tag.pictures() {
    items.push(MetadataItem {
      key: "METADATA_BLOCK_PICTURE".to_string(),
      name: Some("Picture".to_string()),
      value: describe_picture(picture),
    });
  }

  tags.push(MetadataTag {
    kind: "Vorbis Comments".to_string(),
    items,
  });
}

fn push_ilst(tags: &mut Vec<MetadataTag>, tag: Option<&Ilst>) {
  let Some(tag) = tag else { return };

  let mut items = Vec::new();
  for atom in tag {
    let key = match atom.ident() {
      // A four-character code is Latin-1, not UTF-8: the leading byte of the
      // common ones is 0xA9, which decodes as "©" only that way (as UTF-8 it
      // is an invalid sequence, and would come out as a replacement char).
      AtomIdent::Fourcc(fourcc) => {
        fourcc.iter().map(|&b| b as char).collect::<String>()
      }
      // iTunes-style freeform atom: "----:com.apple.iTunes:REPLAYGAIN…".
      AtomIdent::Freeform { mean, name } => format!("----:{mean}:{name}"),
    };
    for data in atom.data() {
      items.push(MetadataItem {
        name: friendly_name_for(TagType::Mp4Ilst, &key),
        value: atom_data_string(&key, data),
        key: key.clone(),
      });
    }
  }

  tags.push(MetadataTag {
    kind: "MP4 Atoms".to_string(),
    items,
  });
}

fn atom_data_string(key: &str, data: &AtomData) -> String {
  match data {
    AtomData::UTF8(text) | AtomData::UTF16(text) => text.clone(),
    AtomData::Picture(picture) => describe_picture(picture),
    AtomData::SignedInteger(int) => int.to_string(),
    AtomData::UnsignedInteger(int) => int.to_string(),
    AtomData::Bool(flag) => flag.to_string(),
    AtomData::Unknown { code, data } => decode_track_pair(key, data)
      .unwrap_or_else(|| {
        format!("data type {code:?}: {}", describe_binary(data))
      }),
  }
}

// `trkn` and `disk` carry their two numbers as a packed binary payload with no
// declared data type — a pair of big-endian 16-bit values after a two-byte
// pad — so without this they would show up as raw bytes.
fn decode_track_pair(key: &str, data: &[u8]) -> Option<String> {
  if (key != "trkn" && key != "disk") || data.len() < 6 {
    return None;
  }
  let number = u16::from_be_bytes([data[2], data[3]]);
  let total = u16::from_be_bytes([data[4], data[5]]);
  Some(if total > 0 {
    format!("{number}/{total}")
  } else {
    number.to_string()
  })
}

fn push_riff_info(tags: &mut Vec<MetadataTag>, tag: Option<&RiffInfoList>) {
  let Some(tag) = tag else { return };

  let items = tag
    .into_iter()
    .map(|(key, value)| MetadataItem {
      name: friendly_name_for(TagType::RiffInfo, key),
      key: key.clone(),
      value: value.clone(),
    })
    .collect();

  tags.push(MetadataTag {
    kind: "RIFF INFO".to_string(),
    items,
  });
}

fn push_aiff_text(tags: &mut Vec<MetadataTag>, tag: Option<&AiffTextChunks>) {
  let Some(tag) = tag else { return };

  let mut items = Vec::new();
  let mut push = |key: &str, name: &str, value: String| {
    items.push(MetadataItem {
      key: key.to_string(),
      name: Some(name.to_string()),
      value,
    });
  };
  if let Some(name) = &tag.name {
    push("NAME", "Title", name.clone());
  }
  if let Some(author) = &tag.author {
    push("AUTH", "Author", author.clone());
  }
  if let Some(copyright) = &tag.copyright {
    push("(c) ", "Copyright", copyright.clone());
  }
  for annotation in tag.annotations.iter().flatten() {
    push("ANNO", "Annotation", annotation.clone());
  }
  for comment in tag.comments.iter().flatten() {
    push("COMT", "Comment", comment.text.clone());
  }

  tags.push(MetadataTag {
    kind: "AIFF Text Chunks".to_string(),
    items,
  });
}

fn push_pictures(
  tags: &mut Vec<MetadataTag>,
  kind: &str,
  pictures: &[(lofty::picture::Picture, lofty::picture::PictureInformation)],
) {
  if pictures.is_empty() {
    return;
  }

  let items = pictures
    .iter()
    .map(|(picture, info)| MetadataItem {
      key: "PICTURE".to_string(),
      name: Some(split_camel_case(&format!("{:?}", picture.pic_type()))),
      value: if info.width > 0 && info.height > 0 {
        format!(
          "{} ({}×{})",
          describe_picture(picture),
          info.width,
          info.height
        )
      } else {
        describe_picture(picture)
      },
    })
    .collect();

  tags.push(MetadataTag {
    kind: kind.to_string(),
    items,
  });
}

#[get("/artists/<artist>")]
fn get_artist_info(
  artist: &str,
  config: &State<AppConfig>,
) -> Json<ArtistInfoResponse> {
  let decoded = urlencoding::decode(artist)
    .map(|s| s.into_owned())
    .unwrap_or_else(|_| artist.to_string());

  let catalog = config.catalog.read().unwrap();
  let tracks = catalog.tracks_by_artist(&decoded);

  // Genre counts keyed by name; BTreeMap so equally-used genres come out in
  // alphabetical order after the count sort below.
  let mut genre_counts: BTreeMap<&str, usize> = BTreeMap::new();
  let mut years: Vec<i32> = Vec::new();
  for track in &tracks {
    for genre in &track.genres {
      *genre_counts.entry(genre.as_str()).or_insert(0) += 1;
    }
    if let Some(year) = track.year {
      years.push(year);
    }
  }
  let mut genres: Vec<ArtistGenre> = genre_counts
    .into_iter()
    .map(|(name, count)| ArtistGenre {
      slug: encode(name),
      name: name.to_string(),
      count,
    })
    .collect();
  genres.sort_by(|a, b| b.count.cmp(&a.count));

  Json(ArtistInfoResponse {
    data: ArtistInfo {
      name: decoded.clone(),
      // No real bio/country source yet; omit rather than fabricate.
      bio: None,
      country: None,
      song_count: tracks.len(),
      first_year: years.iter().min().copied(),
      last_year: years.iter().max().copied(),
      genres,
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
  // The individual credited artists, so the UI can render one link per artist.
  track_artists: Vec<String>,
  // ISO 8601 timestamp of when the track was added to the playlist, or `None`.
  added_at: Option<String>,
}

#[derive(Serialize)]
#[serde(crate = "rocket::serde")]
struct PlaylistDetail {
  id: String,
  name: String,
  created_at: u64,
  updated_at: u64,
  tracks: Vec<PlaylistTrack>,
  // Last-selected display sort, echoed so the client can restore it on open.
  #[serde(skip_serializing_if = "Option::is_none")]
  sort_order: Option<String>,
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
struct SetPlaylistSortInput {
  sort: String,
}

#[derive(Deserialize)]
#[serde(crate = "rocket::serde")]
struct TrackRefInput {
  artist: String,
  title: String,
  #[serde(default)]
  added_at: Option<String>,
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
  let tracks =
    playlist
      .tracks
      .iter()
      .map(|tr| {
        match catalog.tracks.iter().find(|t| {
          t.title == tr.title && artists_match(&t.artists, &tr.artist)
        }) {
          Some(t) => PlaylistTrack {
            artist: tr.artist.clone(),
            title: tr.title.clone(),
            available: true,
            slug: encode(&t.slug),
            src: format!(
              "/api/{}/{}",
              encode(primary_artist(&t.artists)),
              encode(&t.slug)
            ),
            artist_slug: encode(primary_artist(&t.artists)),
            track_artist: artist_credit(&t.artists),
            track_artists: t.artists.clone(),
            added_at: tr.added_at.clone(),
          },
          None => PlaylistTrack {
            artist: tr.artist.clone(),
            title: tr.title.clone(),
            available: false,
            slug: String::new(),
            src: String::new(),
            artist_slug: encode(primary_artist(&split_artists(&tr.artist))),
            track_artist: tr.artist.clone(),
            track_artists: split_artists(&tr.artist),
            added_at: tr.added_at.clone(),
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
    sort_order: playlist.sort_order.clone(),
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

// Export all playlists as a single JSON document in the same shape as the
// legacy `playlists.json` import format, so users can back them up and
// re-import them elsewhere. The static `export` segment outranks the dynamic
// `/playlists/<id>` route, so there is no collision.
#[get("/playlists/export")]
fn export_playlists(store: &State<PlaylistStore>) -> Json<PlaylistFile> {
  let playlists = store.playlists.read().expect("playlists lock poisoned");
  Json(PlaylistFile {
    version: 1,
    playlists: playlists.clone(),
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
    sort_order: None,
  };
  let location = format!("/api/playlists/{}", playlist.id);
  let detail = PlaylistDetail {
    id: playlist.id.clone(),
    name: playlist.name.clone(),
    created_at: playlist.created_at,
    updated_at: playlist.updated_at,
    tracks: Vec::new(),
    sort_order: playlist.sort_order.clone(),
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

// Persist the display sort last selected for a playlist so it can be restored
// on reopen. This is a view preference, not a content change, so it does not
// bump `updated_at`.
#[patch("/playlists/<id>/sort", data = "<input>")]
fn set_playlist_sort(
  id: &str,
  input: Json<SetPlaylistSortInput>,
  store: &State<PlaylistStore>,
  config: &State<AppConfig>,
) -> Result<Json<PlaylistDetailResponse>, Status> {
  let sort = input.sort.trim();
  if !matches!(sort, "index" | "added-asc" | "added-desc") {
    return Err(Status::BadRequest);
  }

  let mut playlists = store.playlists.write().expect("playlists lock poisoned");
  let playlist = playlists
    .iter_mut()
    .find(|p| p.id == id)
    .ok_or(Status::NotFound)?;
  playlist.sort_order = Some(sort.to_string());
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
    added_at: Some(
      input
        .added_at
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(now_iso8601),
    ),
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
      added_at: t.added_at,
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

// The frontend (HTML/CSS/JS/images) is baked into the binary at compile time
// so the server is self-contained — no dependency on `../frontend/public` at
// runtime. In debug builds rust-embed reads these from disk so edits show up
// without a recompile; release builds embed the bytes (see build.rs).
#[derive(RustEmbed)]
#[folder = "../frontend/public"]
struct Frontend;

// A static asset served straight from the embedded bundle.
struct EmbeddedAsset {
  content_type: rocket::http::ContentType,
  data: std::borrow::Cow<'static, [u8]>,
}

impl<'r> rocket::response::Responder<'r, 'static> for EmbeddedAsset {
  fn respond_to(
    self,
    _: &'r rocket::Request<'_>,
  ) -> rocket::response::Result<'static> {
    rocket::Response::build()
      .header(self.content_type)
      .sized_body(self.data.len(), std::io::Cursor::new(self.data))
      .ok()
  }
}

// Look up an embedded file by its path (e.g. "js/tunediver.js"), inferring the
// content type from the file extension.
fn embedded_asset(path: &str) -> Option<EmbeddedAsset> {
  let file = Frontend::get(path)?;
  let content_type = Path::new(path)
    .extension()
    .and_then(|ext| ext.to_str())
    .and_then(rocket::http::ContentType::from_extension)
    .unwrap_or(rocket::http::ContentType::Bytes);
  Some(EmbeddedAsset {
    content_type,
    data: file.data,
  })
}

// Serve the SPA shell at the root.
#[get("/")]
fn index() -> Option<EmbeddedAsset> {
  embedded_asset("index.html")
}

// Serve embedded static files (js, css, img, ...). Any path that doesn't map to
// a real asset falls back to the SPA shell so client-side routing works.
#[get("/<path..>", rank = 100)]
fn static_files(path: PathBuf) -> Option<EmbeddedAsset> {
  path
    .to_str()
    .and_then(embedded_asset)
    .or_else(|| embedded_asset("index.html"))
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

// Default database location: fast local storage, deliberately NOT beside the
// music directory — the music may live on slow or removable media (a NAS, an
// SD card, an external/backup drive), and a key job of the DB is to cache
// metadata so that medium isn't touched. The DB also holds playlists (primary
// user data that lives nowhere else), so it goes under Application Support
// rather than a purgeable cache dir. Falls back to the working directory if
// $HOME is unset. Override with the `db_path` config key / `ROCKET_DB_PATH`.
fn default_db_path() -> PathBuf {
  if let Some(home) = std::env::var_os("HOME") {
    let dir = PathBuf::from(home).join("Library/Application Support/Tunediver");
    if fs::create_dir_all(&dir).is_ok() {
      return dir.join("tunediver.db");
    }
  }
  PathBuf::from("tunediver.db")
}

#[launch]
fn rocket() -> _ {
  // Read configuration from Rocket.toml
  let figment = rocket::Config::figment();
  let music_path: String = figment
    .extract_inner("music_path")
    .unwrap_or_else(|_| String::from("music"));

  println!("Starting Tunediver with music path: {}", music_path);

  let db_path: PathBuf = figment
    .extract_inner::<String>("db_path")
    .map(PathBuf::from)
    .unwrap_or_else(|_| default_db_path());
  println!("Using database: {}", db_path.display());
  let pool = db::open_pool(&db_path).expect("Failed to open database");

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
    .mount("/", routes![index, static_files])
    .mount(
      "/api",
      routes![
        get_artists,
        get_genres,
        get_genre_songs,
        get_all_songs,
        get_artist_songs,
        get_artist_info,
        get_song,
        get_song_cover,
        get_song_waveform,
        get_song_metadata,
        get_music_file,
        reload_catalog,
        scan_status,
        list_playlists,
        export_playlists,
        create_playlist,
        get_playlist,
        rename_playlist,
        set_playlist_sort,
        delete_playlist,
        add_playlist_track,
        remove_playlist_track,
        reorder_playlist_tracks,
      ],
    )
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
  fn artists_match_full_credit_and_each_participant() {
    let artists = vec!["Bobby McFerrin".to_string(), "Chick Corea".to_string()];
    // The credit line the track itself produces ("A, B"), as a playlist ref
    // added from `track_artist` would carry it.
    assert_eq!(artist_credit(&artists), "Bobby McFerrin, Chick Corea");
    assert!(artists_match(&artists, "Bobby McFerrin, Chick Corea"));
    // A delimited full credit (older separators) naming this exact set.
    assert!(artists_match(&artists, "Bobby McFerrin / Chick Corea"));
    assert!(artists_match(&artists, "Bobby McFerrin; Chick Corea"));
    // Each participant on its own.
    assert!(artists_match(&artists, "Bobby McFerrin"));
    assert!(artists_match(&artists, "Chick Corea"));
    assert!(!artists_match(&artists, "Herbie Hancock"));
    // A credit naming a different set does not match.
    assert!(!artists_match(&artists, "Bobby McFerrin / Herbie Hancock"));
  }

  #[test]
  fn read_track_tags_returns_unknown_artist_for_unreadable_file() {
    // A path that can't be parsed as audio falls back to the placeholders
    // rather than borrowing identity from the filename.
    let tags = read_track_tags(Path::new("/nonexistent/not-audio.mp3"));
    assert_eq!(tags.artists, vec!["Unknown Artist".to_string()]);
    assert_eq!(tags.title, "Unknown Title");
    assert!(tags.genres.is_empty(), "no placeholder genre is invented");
    assert_eq!(tags.year, None, "no placeholder year is invented");
  }

  #[test]
  fn parse_release_date_reads_the_common_date_tag_shapes() {
    // (tag value, expected year, expected display text)
    let parsed =
      |v: &str| parse_release_date(v).map(|d| (d.year, d.text.clone()));
    for (value, year, text) in [
      ("1968", 1968, "1968"),
      ("1968-05", 1968, "1968-05"),
      ("1968-05-03", 1968, "1968-05-03"),
      // A time component, a foreign separator and a trailing note all keep
      // whatever prefix parses and drop the rest.
      ("1968-05-03T00:00:00", 1968, "1968-05-03"),
      ("1968/05/03", 1968, "1968-05-03"),
      ("1968.05.03", 1968, "1968-05-03"),
      ("1968-05-03 12:30", 1968, "1968-05-03"),
      ("1968 (remaster)", 1968, "1968"),
      ("1968-13-03", 1968, "1968"),
      ("1968-5-3", 1968, "1968"),
      (" 2024 ", 2024, "2024"),
    ] {
      assert_eq!(parsed(value), Some((year, text.to_string())), "{value}");
    }
    // Neither a placeholder nor a partial year is a release date.
    for value in ["", "0000", "68", "Unknown"] {
      assert_eq!(parsed(value), None, "{value}");
    }
  }

  #[test]
  fn split_genres_handles_all_common_separators() {
    for tag in ["Rock/Pop", "Rock, Pop", "Rock; Pop", "Rock /Pop"] {
      assert_eq!(
        split_genres(tag),
        vec!["Rock".to_string(), "Pop".to_string()],
        "failed for {tag:?}"
      );
    }
    assert_eq!(split_genres("Drum'n'Bass"), vec!["Drum'n'Bass".to_string()]);
    assert!(split_genres("  ").is_empty());
  }

  #[test]
  fn slugs_disambiguate_only_colliding_artist_title() {
    let track = |id, artist: &str, title: &str, path: &str| Track {
      id,
      artists: split_artists(artist),
      title: title.to_string(),
      genres: Vec::new(),
      year: None,
      path: PathBuf::from(path),
      slug: String::new(),
    };
    let mut tracks = vec![
      // Three files with identical tags — each must get a distinct slug.
      track(0, "Herbie Hancock", "Watermelon Man", "/a.mp3"),
      track(1, "Herbie Hancock", "Watermelon Man", "/b.mp3"),
      track(2, "Herbie Hancock", "Watermelon Man", "/c.mp3"),
      // Same title, different artist → its own (artist, title), stays clean.
      track(3, "Someone Else", "Watermelon Man", "/d.mp3"),
      // A genuinely unique track keeps its plain title as the slug.
      track(4, "Herbie Hancock", "Cantaloupe Island", "/e.mp3"),
    ];
    assign_track_slugs(&mut tracks);

    // The unique tracks keep clean, title-only slugs.
    assert_eq!(tracks[3].slug, "Watermelon Man");
    assert_eq!(tracks[4].slug, "Cantaloupe Island");

    // The three colliding copies get distinct, discriminated slugs...
    let colliding: Vec<&str> =
      tracks[0..3].iter().map(|t| t.slug.as_str()).collect();
    assert!(colliding.iter().all(|s| s.starts_with("Watermelon Man (")));
    let distinct: BTreeSet<&&str> = colliding.iter().collect();
    assert_eq!(distinct.len(), 3, "each copy must get its own slug");

    // ...and each slug resolves back to exactly its own file via find_track.
    let catalog = Catalog { tracks };
    for id in 0..3 {
      let slug = encode(&catalog.tracks[id].slug);
      let found = catalog.find_track("Herbie Hancock", &slug).unwrap();
      assert_eq!(found.id, id);
    }
  }

  #[test]
  fn catalog_unifies_artists_across_collaborations() {
    let track = |id, artist: &str| Track {
      id,
      artists: split_artists(artist),
      title: format!("Song {}", id),
      genres: Vec::new(),
      year: None,
      path: PathBuf::from(format!("/{}.mp3", id)),
      slug: format!("Song {}", id),
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

  #[test]
  fn catalog_lists_genres_and_filters_tracks_by_genre() {
    let track = |id, genres: &[&str]| Track {
      id,
      artists: vec!["Artist".to_string()],
      title: format!("Song {}", id),
      genres: genres.iter().map(|g| g.to_string()).collect(),
      year: None,
      path: PathBuf::from(format!("/{}.mp3", id)),
      slug: format!("Song {}", id),
    };
    let catalog = Catalog {
      tracks: vec![
        track(0, &["Jazz", "Funk"]),
        track(1, &["Jazz"]),
        track(2, &[]), // untagged: appears in no genre
        track(3, &["Funk"]),
      ],
    };

    // Each genre appears once despite being shared across tracks; untagged
    // tracks contribute nothing.
    let names: Vec<String> =
      catalog.list_genres().into_iter().map(|g| g.name).collect();
    assert_eq!(names, vec!["Funk", "Jazz"]);

    // A multi-genre track surfaces under each of its genres.
    let funk: Vec<usize> = catalog
      .tracks_by_genre("Funk")
      .iter()
      .map(|t| t.id)
      .collect();
    assert_eq!(funk, vec![0, 3]);
    let jazz: Vec<usize> = catalog
      .tracks_by_genre("Jazz")
      .iter()
      .map(|t| t.id)
      .collect();
    assert_eq!(jazz, vec![0, 1]);
    assert!(catalog.tracks_by_genre("Polka").is_empty());
  }
}
