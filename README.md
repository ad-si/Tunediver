# Tunediver

Tunediver is a local music server and music-player webapp to listen
to your local music collection.


## API

The API is implemented with Rust's Rocket framework
and serves as a backend for the Tunediver webapp.
It provides endpoints to access and manage your local music collection.


### Endpoints

- Artists: `/music.php?artists=true`
- Songs of Artist: `/music.php?artist=<artist_name>&songs=true`
- Song: `/music.php?artist=<artist_name>&song=<song_name>`
- Artist Info: `/music.php?artist=<artist_name>`


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

You can configure the music directory path in several ways:

1. Using the makefile target:
   ```sh
   make start-with-path MUSIC_PATH=/path/to/your/music
   ```

2. Using environment variables:
   ```sh
   ROCKET_MUSIC_PATH=/path/to/your/music cargo run
   ```

3. By editing the `Rocket.toml` file:
   ```toml
   [default]
   music_path = "/path/to/your/music"
   ```

The API will be available at http://localhost:7313 by default.


## Front-end Development

The front-end uses vanilla JavaScript
with the DOMinate utility for DOM manipulation.
The source files are written in TypeScript,
which is then compiled to JavaScript with `make build`.
