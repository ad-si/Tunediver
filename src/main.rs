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

// Helper function to check if a file is an audio file
fn is_audio_file(filename: &str) -> bool {
  let extensions = [
    ".mp3", ".m4a", ".flac", ".wav", ".ogg", ".aac", ".wma", ".aiff", ".alac",
    ".opus",
  ];

  for ext in extensions.iter() {
    if filename.to_lowercase().ends_with(ext) {
      return true;
    }
  }
  false
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
          }
        }
      }
    }
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
  let path = Path::new(&config.music_path).join(&artist);

  if let Ok(entries) = fs::read_dir(path) {
    for (i, entry) in entries.enumerate() {
      if let Ok(entry) = entry {
        if let Ok(name) = entry.file_name().into_string() {
          // Only include audio file formats
          if is_audio_file(&name) {
            // Extract title by removing any file extension
            let title = match name.rfind('.') {
              Some(pos) => name[..pos].to_string(),
              None => name.clone(),
            };
            songs.push(Song {
              id: i,
              title: title.clone(),
              slug: urlencoding::encode(&title).to_string(),
              src: format!("/api/{}/{}", artist, name),
            });
          }
        }
      }
    }
  }

  Json(SongResponse { data: songs })
}

#[get("/artists/<artist>/songs/<song>")]
fn get_song(
  artist: String,
  song: String,
  config: &State<AppConfig>,
) -> Json<SingleSongResponse> {
  // Find the actual filename with extension
  let path = Path::new(&config.music_path).join(&artist);
  let mut actual_filename = song.clone();
  let title;

  // Check if the song already has an extension
  if song.contains('.') {
    // If it has an extension, extract title
    title = match song.rfind('.') {
      Some(pos) => song[..pos].to_string(),
      None => song.clone(),
    };
  } else {
    // If it doesn't have an extension, the song parameter is the title
    title = song.clone();

    // Find the matching file with extension
    if let Ok(entries) = fs::read_dir(path) {
      for entry in entries {
        if let Ok(entry) = entry {
          if let Ok(name) = entry.file_name().into_string() {
            if is_audio_file(&name) {
              // Extract title from this file
              let file_title = match name.rfind('.') {
                Some(pos) => name[..pos].to_string(),
                None => name.clone(),
              };

              // If this file's title matches our requested title
              if file_title == title {
                actual_filename = name;
                break;
              }
            }
          }
        }
      }
    }
  }

  Json(SingleSongResponse {
    data: SingleSong {
      id: 1,
      title: title.clone(),
      slug: urlencoding::encode(&title).to_string(),
      track_artist: artist.clone(),
      lyrics: "This are the lyrics of the Song".to_string(),
      src: format!("/api/{}/{}", artist, actual_filename),
      file_name: actual_filename, // Full filename with extension
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
  rocket::fs::NamedFile::open("public/index.html").await.ok()
}

#[get("/<artist>/<song>")]
async fn get_music_file(
  artist: String,
  song: String,
  config: &State<AppConfig>,
) -> Option<FileWithRanges> {
  // Check if the song already has an extension
  let path = if song.contains('.') {
    // Direct path lookup if it has an extension
    Path::new(&config.music_path).join(&artist).join(&song)
  } else {
    // The song parameter is the title without extension
    // Find the first matching file with an extension
    let dir_path = Path::new(&config.music_path).join(&artist);

    // Try to find the matching file with any extension
    if let Ok(entries) = fs::read_dir(&dir_path) {
      for entry in entries {
        if let Ok(entry) = entry {
          if let Ok(name) = entry.file_name().into_string() {
            if is_audio_file(&name) {
              // Extract title from this file
              let file_title = match name.rfind('.') {
                Some(pos) => name[..pos].to_string(),
                None => name.clone(),
              };

              // If this file's title matches our requested title
              if file_title == song {
                let file_path = dir_path.join(&name);
                if let Ok(named_file) =
                  rocket::fs::NamedFile::open(&file_path).await
                {
                  return Some(FileWithRanges(named_file));
                }
              }
            }
          }
        }
      }
    }

    return None;
  };

  if let Ok(named_file) = rocket::fs::NamedFile::open(&path).await {
    Some(FileWithRanges(named_file))
  } else {
    None
  }
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
    .mount("/", FileServer::from("public"))
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
