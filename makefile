.PHONY: help
help: makefile
	@tail -n +4 makefile | grep ".PHONY"


.PHONY: start
start: build
	cargo run
	
.PHONY: start-with-path
start-with-path: build
	@if [ -z "$(MUSIC_PATH)" ]; then \
		echo "Usage: make start-with-path MUSIC_PATH=/path/to/music"; \
		exit 1; \
	fi
	ROCKET_MUSIC_PATH=$(MUSIC_PATH) cargo run


.PHONY: build
build:
	npx tsc
	cargo build


.PHONY: test
test:
	# Get all artists
	http GET "http://127.0.0.1:7313/api/artists"

	# Get artist info
	http GET "http://127.0.0.1:7313/api/artists/Beatles/"

	# Get songs for a specific artist
	http GET "http://127.0.0.1:7313/api/artists/Beatles/songs"

	# Test the 404 error handler
	http GET "http://127.0.0.1:7313/api/nonexistent"
