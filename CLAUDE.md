# TuneDiver Development Guidelines

## Build Commands

- `make build` - Builds TypeScript and Rust components
- `make start` - Builds and starts the application server
- `make start-with-path MUSIC_PATH=/path/to/music` - Starts server with custom music path


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

- Frontend: TypeScript in public/js/, styles in styles/ (Stylus)
- Backend: Rust server in src/, API endpoints in main.rs
- Assets: Store in public/img/ and design/
- Music: Default in ./music directory, configurable via MUSIC_PATH


## Development Workflow

1. Write code following the style guidelines above
2. Build with `make build` to check for errors
3. Run tests with `make test`
