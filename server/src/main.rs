#[macro_use]
extern crate rocket;
use rocket::fs::FileServer;
use rocket::serde::{json::Json, Deserialize, Serialize};
use rocket::State;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
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

#[derive(Debug)]
struct AppConfig {
  catalog: Catalog,
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
fn collect_audio_files(dir: &Path, out: &mut Vec<PathBuf>) {
  let entries = match fs::read_dir(dir) {
    Ok(e) => e,
    Err(_) => return,
  };
  for entry in entries.flatten() {
    let path = entry.path();
    let file_type = match entry.file_type() {
      Ok(t) => t,
      Err(_) => continue,
    };
    if file_type.is_dir() {
      collect_audio_files(&path, out);
    } else if file_type.is_file() {
      if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if is_audio_file(name) {
          out.push(path);
        }
      }
    }
  }
}

// Scan `music_path` for audio files and build the tag-driven catalog.
// Paths and filenames only serve as a way to *locate* the files on disk;
// all user-visible metadata comes from the tags.
fn build_catalog(music_path: &Path) -> Catalog {
  let mut paths = Vec::new();
  collect_audio_files(music_path, &mut paths);
  // Sort so the catalog ordering is deterministic across restarts.
  paths.sort();

  let mut tracks = Vec::with_capacity(paths.len());
  for (id, path) in paths.into_iter().enumerate() {
    let (artist, title) = read_track_tags(&path);
    tracks.push(Track {
      id,
      artist,
      title,
      path,
    });
  }
  Catalog { tracks }
}

impl Catalog {
  // Unique artists, sorted alphabetically (case-insensitive) via BTreeSet
  // ordering. IDs are sequential in the returned slice.
  fn list_artists(&self) -> Vec<Artist> {
    let mut names: BTreeSet<String> = BTreeSet::new();
    for track in &self.tracks {
      names.insert(track.artist.clone());
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
    self.tracks.iter().filter(|t| t.artist == artist).collect()
  }

  // Find a track by artist + url-encoded title. If multiple tracks share
  // the same artist and title, the first one in catalog order wins.
  fn find_track(&self, artist: &str, title_slug: &str) -> Option<&Track> {
    let decoded = urlencoding::decode(title_slug).ok()?;
    self
      .tracks
      .iter()
      .find(|t| t.artist == artist && t.title == decoded)
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

#[derive(Debug)]
struct PlaylistStore {
  path: PathBuf,
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

impl PlaylistStore {
  fn load(path: PathBuf) -> Self {
    let playlists = match fs::read_to_string(&path) {
      Ok(s) => match serde_json::from_str::<PlaylistFile>(&s) {
        Ok(file) => file.playlists,
        Err(e) => {
          eprintln!(
            "Warning: could not parse {}: {}. Starting with empty list.",
            path.display(),
            e
          );
          Vec::new()
        }
      },
      Err(_) => Vec::new(),
    };
    PlaylistStore {
      path,
      playlists: RwLock::new(playlists),
    }
  }

  // Atomic-ish save: write to a temp file alongside the target and rename.
  // Fails silently with a log line — playlist persistence is best-effort and
  // the in-memory state remains authoritative for the current process.
  fn save(&self, playlists: &[Playlist]) {
    let file = PlaylistFile {
      version: 1,
      playlists: playlists.to_vec(),
    };
    let json = match serde_json::to_string_pretty(&file) {
      Ok(s) => s,
      Err(e) => {
        eprintln!("Failed to serialize playlists: {}", e);
        return;
      }
    };
    let tmp = self.path.with_extension("json.tmp");
    if let Err(e) = fs::write(&tmp, json) {
      eprintln!("Failed to write {}: {}", tmp.display(), e);
      return;
    }
    if let Err(e) = fs::rename(&tmp, &self.path) {
      eprintln!(
        "Failed to rename {} -> {}: {}",
        tmp.display(),
        self.path.display(),
        e
      );
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
    data: config.catalog.list_artists(),
  })
}

// All songs in the catalog, sorted alphabetically by title
// (case-insensitive) so the "Songs" tab can display a flat list.
#[get("/songs")]
fn get_all_songs(config: &State<AppConfig>) -> Json<SongResponse> {
  let mut songs: Vec<Song> =
    config.catalog.tracks.iter().map(track_to_song).collect();
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

  let songs = config
    .catalog
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

  match config.catalog.find_track(&decoded_artist, song) {
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
      let lyrics = read_track_lyrics(&track.path).unwrap_or_default();
      let date_added =
        read_id3v2_user_text(&track.path, "DATE_ADDED").unwrap_or_default();

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

  let track = config
    .catalog
    .find_track(&decoded_artist, song)
    .ok_or_else(|| NotFound("Track not found".to_string()))?;

  let tagged = read_from_path(&track.path)
    .map_err(|_| NotFound("Cannot read tags".to_string()))?;

  let tag = tagged
    .primary_tag()
    .or_else(|| tagged.first_tag())
    .ok_or_else(|| NotFound("No tags".to_string()))?;

  let picture = tag
    .pictures()
    .first()
    .ok_or_else(|| NotFound("No cover art".to_string()))?;

  let content_type = match picture.mime_type() {
    Some(MimeType::Png) => ContentType::PNG,
    Some(MimeType::Bmp) => ContentType::BMP,
    Some(MimeType::Gif) => ContentType::GIF,
    Some(MimeType::Tiff) => ContentType::new("image", "tiff"),
    _ => ContentType::JPEG,
  };

  Ok((content_type, picture.data().to_vec()))
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
    data: hydrate(playlist, &config.catalog),
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
  let detail = hydrate(playlist, &config.catalog);
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
  let detail = hydrate(playlist, &config.catalog);
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
  let detail = hydrate(playlist, &config.catalog);
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
  let detail = hydrate(playlist, &config.catalog);
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
  let track = config.catalog.find_track(&decoded_artist, song)?;
  let named_file = rocket::fs::NamedFile::open(&track.path).await.ok()?;
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

#[launch]
fn rocket() -> _ {
  // Read configuration from Rocket.toml
  let figment = rocket::Config::figment();
  let music_path: String = figment
    .extract_inner("music_path")
    .unwrap_or_else(|_| String::from("music"));

  println!("Starting Tunediver with music path: {}", music_path);
  let catalog = build_catalog(Path::new(&music_path));
  println!(
    "Indexed {} track(s) from tag metadata",
    catalog.tracks.len()
  );

  let playlists_path: PathBuf = figment
    .extract_inner::<String>("playlists_path")
    .map(PathBuf::from)
    .unwrap_or_else(|_| default_playlists_path(Path::new(&music_path)));
  println!("Loading playlists from: {}", playlists_path.display());
  let playlist_store = PlaylistStore::load(playlists_path);

  let config = AppConfig { catalog };

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
