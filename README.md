# Tunediver

Tunediver is a local music server and music-player webapp to listen
to your local music collection.


## API

The API is implemented with Rust's Rocket framework
and serves as a backend for the Tunediver webapp.
It provides endpoints to access and manage your local music collection.


### Endpoints

- List artists: `GET /api/artists`
- Songs by artist: `GET /api/artists/<artist>/songs`
- Single song: `GET /api/artists/<artist>/songs/<song>`
- Artist info: `GET /api/artists/<artist>`
- Stream audio file: `GET /<artist>/<song>` (Range requests supported)


### Building and Running

1. Make sure you have Rust and Cargo installed (https://rustup.rs/)
2. Build the API:
   ```sh
   make build
   ```
3. Run the API:
   ```sh
   make start
   ```


### Configuring Music Path

The top-level `make start` runs the server against `./example_music`.
To use your own path:

```sh
cd server && make start-with-path MUSIC_PATH=/path/to/your/music
```

You can also set `ROCKET_MUSIC_PATH` directly,
or edit `music_path` in `server/Rocket.toml`.

The API will be available at http://localhost:7313 by default.


## Project Structure

- `frontend/` — TypeScript webapp (`public/js/`), plain CSS (`public/css/`), assets (`public/img/`)
- `server/` — Rust/Rocket backend (`src/main.rs`, config in `Rocket.toml`)
- `desktop/` — Tauri 2 scaffold (not yet integrated)
- `design/` — design assets


## Front-end Development

The front-end uses vanilla JavaScript
with the DOMinate utility for DOM manipulation.
The source files are written in TypeScript,
which is then compiled to JavaScript with `make build`.


## Related

### Players

- [Audioling] - Audio player with a focus on self-hosted music server support.
- [Aural] - Audio file player for macOS, inspired by Winamp.
- [Harmonoid] - Plays & manages your music library.
- [Musicat] - Desktop music player and tagger for offline music.
- [Musicpod] - Music, radio, TV, and podcast desktop player.
- [Quod Libet] - Music player and music library manager.
- [Tauon] - Music player for the desktop.

[Audioling]: https://github.com/audioling/audioling
[Aural]: https://github.com/kartik-venugopal/aural-player
[Harmonoid]: https://github.com/harmonoid/harmonoid
[Musicat]: https://github.com/basharovV/musicat
[Musicpod]: https://github.com/ubuntu-flutter-community/musicpod
[Quod Libet]: https://github.com/quodlibet/quodlibet
[Tauon]: https://github.com/Taiko2k/Tauon


### Streaming Servers

- [Navidrome] - Music server

[Navidrome]: https://github.com/navidrome/navidrome/
