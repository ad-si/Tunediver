# Tunediver Development Guidelines

## Build Commands

- `make build` - Builds all packages (desktop is currently a stub)
- `make start` - Runs the server against `./example_music`
- `cd server && make start-with-path MUSIC_PATH=/path/to/music` - Runs the server with a custom music path


## Test Commands

- `make test` - Builds and tests each component; the server test target starts a temporary server on port 7313 and kills it afterwards


## Code Style Guidelines

### TypeScript

- Types: Use explicit interfaces/types for all objects
- Naming: camelCase for variables/functions, PascalCase for types/interfaces
- Formatting: 2-space indentation, trailing commas in objects/arrays
- Error handling: Proper handling of API responses with error fields


### Rust

- Naming: snake_case for functions/variables, PascalCase for structs/enums
- Errors: Use Result/Option for error handling, avoid panic
- Structs: Add proper serde annotations for serialization
- API endpoints: Document with comments for clarity


## Project Structure

- `frontend/` — TypeScript sources in `public/js/`, plain CSS in `public/css/`, assets in `public/img/`
- `server/` — Rust/Rocket backend in `src/main.rs`; config in `Rocket.toml`
- `desktop/` — Tauri 2 scaffold, not yet integrated
- `design/` — design assets
- Music path: default in `server/Rocket.toml`, overridable via `ROCKET_MUSIC_PATH` env var or `MUSIC_PATH` makefile arg; top-level `make start` uses `./example_music/`


## Development Workflow

1. Write code following the style guidelines above
2. Build with `make build` to check for errors
3. Run tests with `make test`
