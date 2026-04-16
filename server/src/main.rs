#[macro_use]
extern crate rocket;
use rocket::fs::FileServer;
use rocket::serde::{json::Json, Serialize};
use rocket::State;
use std::fs;
use std::path::{Path, PathBuf};

// We'll replace the constant with configuration
#[derive(Debug)]
struct AppConfig {
  music_path: String,
}

// Virtual artist used for audio files that live directly in MUSIC_PATH
// rather than inside an artist subdirectory.
const VARIOUS_ARTISTS: &str = "Various Artists";

// Helper function to check if a file is an audio file. Includes a few
// container formats (mp4, m4v, webm) that often hold music videos — the
// <audio> element in modern browsers plays the audio track and ignores
// any video.
fn is_audio_file(filename: &str) -> bool {
  let extensions = [
    ".mp3", ".m4a", ".flac", ".wav", ".ogg", ".aac", ".wma", ".aiff", ".alac",
    ".opus", ".mp4", ".m4v", ".webm",
  ];

  for ext in extensions.iter() {
    if filename.to_lowercase().ends_with(ext) {
      return true;
    }
  }
  false
}

// Strip the extension from a filename, returning the bare title.
fn strip_ext(name: &str) -> String {
  match name.rfind('.') {
    Some(pos) => name[..pos].to_string(),
    None => name.to_string(),
  }
}

// URL-encode each path segment individually so slashes are preserved as
// path separators in the resulting URL.
fn encode_path(rel: &str) -> String {
  rel
    .split('/')
    .map(|seg| urlencoding::encode(seg).to_string())
    .collect::<Vec<_>>()
    .join("/")
}

// Recursively walk `current` and append every audio file found to `songs`,
// flattening any subdirectory structure into a single song list. The `src`
// URL is built from the path relative to `artist_root`.
fn walk_audio(
  current: &Path,
  artist_root: &Path,
  artist_slug: &str,
  songs: &mut Vec<Song>,
  counter: &mut usize,
) {
  let entries = match fs::read_dir(current) {
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
      walk_audio(&path, artist_root, artist_slug, songs, counter);
    } else if file_type.is_file() {
      let name = match entry.file_name().into_string() {
        Ok(n) => n,
        Err(_) => continue,
      };
      if !is_audio_file(&name) {
        continue;
      }
      let title = strip_ext(&name);
      let rel_path = path
        .strip_prefix(artist_root)
        .ok()
        .and_then(|p| p.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| name.clone());
      songs.push(Song {
        id: *counter,
        title: title.clone(),
        slug: urlencoding::encode(&title).to_string(),
        src: format!("/api/{}/{}", artist_slug, encode_path(&rel_path)),
      });
      *counter += 1;
    }
  }
}

// Find the first audio file under `root` whose title (filename without
// extension) matches `title`. Returns (relative path, filename).
fn find_song_in_dir(
  root: &Path,
  title: &str,
  recursive: bool,
) -> Option<(String, String)> {
  fn walk(
    root: &Path,
    current: &Path,
    title: &str,
    recursive: bool,
  ) -> Option<(String, String)> {
    let entries = fs::read_dir(current).ok()?;
    for entry in entries.flatten() {
      let file_type = match entry.file_type() {
        Ok(t) => t,
        Err(_) => continue,
      };
      let path = entry.path();
      if file_type.is_file() {
        let name = match entry.file_name().into_string() {
          Ok(n) => n,
          Err(_) => continue,
        };
        if !is_audio_file(&name) {
          continue;
        }
        if strip_ext(&name) == title {
          let rel = path
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| name.clone());
          return Some((rel, name));
        }
      } else if file_type.is_dir() && recursive {
        if let Some(found) = walk(root, &path, title, recursive) {
          return Some(found);
        }
      }
    }
    None
  }
  walk(root, root, title, recursive)
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
  let mut artists = Vec::new();
  let path = Path::new(&config.music_path);
  let mut has_root_audio = false;

  if let Ok(entries) = fs::read_dir(path) {
    for (i, entry) in entries.enumerate() {
      if let Ok(entry) = entry {
        if let Ok(file_type) = entry.file_type() {
          if file_type.is_dir() {
            if let Ok(name) = entry.file_name().into_string() {
              if !name.contains('.') && !name.contains(':') {
                artists.push(Artist {
                  id: i,
                  name: name.clone(),
                  slug: urlencoding::encode(&name).to_string(),
                });
              }
            }
          } else if file_type.is_file() {
            if let Ok(name) = entry.file_name().into_string() {
              if is_audio_file(&name) {
                has_root_audio = true;
              }
            }
          }
        }
      }
    }
  }

  if has_root_audio {
    let next_id = artists.iter().map(|a| a.id).max().map_or(0, |m| m + 1);
    artists.push(Artist {
      id: next_id,
      name: VARIOUS_ARTISTS.to_string(),
      slug: urlencoding::encode(VARIOUS_ARTISTS).to_string(),
    });
  }

  Json(ArtistResponse {
    error: false,
    data: artists,
  })
}

#[get("/artists/<artist>/songs")]
fn get_artist_songs(
  artist: String,
  config: &State<AppConfig>,
) -> Json<SongResponse> {
  let mut songs = Vec::new();
  let mut counter: usize = 0;
  let base = Path::new(&config.music_path);
  let artist_slug = urlencoding::encode(&artist).to_string();

  if artist == VARIOUS_ARTISTS {
    // For the virtual "Various Artists" entry, list only audio files that
    // sit directly in MUSIC_PATH (no recursion into real artist folders).
    if let Ok(entries) = fs::read_dir(base) {
      for entry in entries.flatten() {
        let file_type = match entry.file_type() {
          Ok(t) => t,
          Err(_) => continue,
        };
        if !file_type.is_file() {
          continue;
        }
        let name = match entry.file_name().into_string() {
          Ok(n) => n,
          Err(_) => continue,
        };
        if !is_audio_file(&name) {
          continue;
        }
        let title = strip_ext(&name);
        songs.push(Song {
          id: counter,
          title: title.clone(),
          slug: urlencoding::encode(&title).to_string(),
          src: format!("/api/{}/{}", artist_slug, urlencoding::encode(&name)),
        });
        counter += 1;
      }
    }
  } else {
    // Recursively walk the artist directory and flatten any nested
    // subfolders into a single song list.
    let artist_path = base.join(&artist);
    walk_audio(
      &artist_path,
      &artist_path,
      &artist_slug,
      &mut songs,
      &mut counter,
    );
  }

  Json(SongResponse { data: songs })
}

#[get("/artists/<artist>/songs/<song>")]
fn get_song(
  artist: String,
  song: String,
  config: &State<AppConfig>,
) -> Json<SingleSongResponse> {
  let title = if song.contains('.') {
    strip_ext(&song)
  } else {
    song.clone()
  };

  let base = Path::new(&config.music_path);
  let (search_root, recursive): (PathBuf, bool) = if artist == VARIOUS_ARTISTS {
    (base.to_path_buf(), false)
  } else {
    (base.join(&artist), true)
  };

  // Look up the matching file (with extension) by title.
  let (rel_path, actual_filename) =
    find_song_in_dir(&search_root, &title, recursive)
      .unwrap_or_else(|| (song.clone(), song.clone()));

  let artist_slug = urlencoding::encode(&artist).to_string();

  Json(SingleSongResponse {
    data: SingleSong {
      id: 1,
      title: title.clone(),
      slug: urlencoding::encode(&title).to_string(),
      track_artist: artist.clone(),
      lyrics: "This are the lyrics of the Song".to_string(),
      src: format!("/api/{}/{}", artist_slug, encode_path(&rel_path)),
      file_name: actual_filename,
    },
  })
}

#[get("/artists/<artist>")]
fn get_artist_info(artist: String) -> Json<ArtistInfoResponse> {
  Json(ArtistInfoResponse {
    data: ArtistInfo {
      name: artist.to_string(),
      bio: format!("This is the bio of {}", artist),
      country: "Someland".to_string(),
    },
  })
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

#[get("/<artist>/<song..>", rank = 5)]
async fn get_music_file(
  artist: String,
  song: PathBuf,
  config: &State<AppConfig>,
) -> Option<FileWithRanges> {
  let base = Path::new(&config.music_path);
  let search_root = if artist == VARIOUS_ARTISTS {
    base.to_path_buf()
  } else {
    base.join(&artist)
  };

  // First try the direct path (works for nested paths with an extension).
  let direct_path = search_root.join(&song);
  if direct_path.exists() {
    if let Ok(named_file) = rocket::fs::NamedFile::open(&direct_path).await {
      return Some(FileWithRanges(named_file));
    }
  }

  // Fallback: legacy URL with title only (no extension). Search by title.
  let song_str = song.to_str()?;
  if !song_str.contains('.') {
    let recursive = artist != VARIOUS_ARTISTS;
    if let Some((rel, _)) = find_song_in_dir(&search_root, song_str, recursive)
    {
      let file_path = search_root.join(&rel);
      if let Ok(named_file) = rocket::fs::NamedFile::open(&file_path).await {
        return Some(FileWithRanges(named_file));
      }
    }
  }

  None
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

#[launch]
fn rocket() -> _ {
  // Read configuration from Rocket.toml
  let figment = rocket::Config::figment();
  let music_path: String = figment
    .extract_inner("music_path")
    .unwrap_or_else(|_| String::from("music"));

  let config = AppConfig { music_path };

  println!("Starting TuneDiver with music path: {}", config.music_path);

  rocket::build()
    .mount("/", FileServer::from("../frontend/public"))
    .mount(
      "/api",
      routes![
        get_artists,
        get_artist_songs,
        get_artist_info,
        get_song,
        get_music_file
      ],
    )
    // Catch-all must be mounted last so it doesn't override other routes
    .mount("/", routes![catch_all])
    .register("/", catchers![not_found])
    .manage(config)
}
