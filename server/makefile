.PHONY: help
help: makefile
	@tail -n +4 makefile | grep ".PHONY"


# Local dev DB, kept separate from the deployed instance's DB (which lives in
# ~/Library/Application Support/Tunediver via the default). The LaunchAgent
# runs the release binary directly, not these makefile targets, so overriding
# the path here only affects dev runs — without it, dev and prod share one DB
# and dev would show the deployed instance's playlists.
DEV_DB ?= $(shell pwd)/tunediver.db

# Same reasoning for the test run, and more urgently: the test server scans
# ../example_music, and a scan reconciles the DB against what it walked. Point
# it at the default path and it would prune every one of the deployed
# instance's cached tracks — the whole library — the moment the scan finished.
TEST_DB ?= $(shell pwd)/tunediver-test.db


.PHONY: start
start: build
	ROCKET_DB_PATH=$(DEV_DB) cargo run


.PHONY: start-with-path
start-with-path: build
	@if [ -z "$(MUSIC_PATH)" ]; then \
		echo "Usage: make start-with-path MUSIC_PATH=/path/to/music"; \
		exit 1; \
	fi
	ROCKET_MUSIC_PATH=$(MUSIC_PATH) ROCKET_DB_PATH=$(DEV_DB) cargo run


.PHONY: build
build:
	cargo build


.PHONY: clean
clean:
	cargo clean
	rm -f $(DEV_DB) $(DEV_DB)-wal $(DEV_DB)-shm
	rm -f $(TEST_DB) $(TEST_DB)-wal $(TEST_DB)-shm


.PHONY: format
format:
	cargo clippy --fix --allow-dirty
	cargo fmt


TEST_PORT ?= 7413

# Two layers: the in-process unit tests (tag parsing, the DB cache, waveform
# bucketing), then a smoke test that drives the real endpoints against a
# temporary server over ./example_music. Unit tests run first so a failure
# there is reported before the noisier HTTP output scrolls past.
.PHONY: test
test: build
	cargo test
	@rm -f $(TEST_DB) $(TEST_DB)-wal $(TEST_DB)-shm
	@ROCKET_PORT=$(TEST_PORT) \
		ROCKET_MUSIC_PATH=$(shell pwd)/../example_music \
		ROCKET_DB_PATH=$(TEST_DB) \
		./target/debug/tunediver-api > /dev/null 2>&1 & \
	SERVER_PID=$$!; \
	trap "kill $$SERVER_PID 2>/dev/null" EXIT INT TERM; \
	for i in 1 2 3 4 5 6 7 8 9 10; do \
		curl -sf http://127.0.0.1:$(TEST_PORT)/api/artists > /dev/null 2>&1 && break; \
		sleep 0.5; \
	done; \
	set -e; \
	echo "# Get all artists"; \
	http GET "http://127.0.0.1:$(TEST_PORT)/api/artists"; \
	echo "# Get artist info"; \
	http GET "http://127.0.0.1:$(TEST_PORT)/api/artists/Fred/"; \
	echo "# Get songs for a specific artist"; \
	http GET "http://127.0.0.1:$(TEST_PORT)/api/artists/Fred/songs"; \
	echo "# Get a song's waveform (headers only: the body is 400 peak values)"; \
	http --headers GET \
		"http://127.0.0.1:$(TEST_PORT)/api/artists/Fred/songs/Binary%20Dreams/waveform"; \
	echo "# Test the 404 error handler"; \
	http GET "http://127.0.0.1:$(TEST_PORT)/api/nonexistent"
