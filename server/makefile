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
	cargo build


.PHONY: format
format:
	cargo fmt


TEST_PORT ?= 7413

.PHONY: test
test: build
	@ROCKET_PORT=$(TEST_PORT) \
		ROCKET_MUSIC_PATH=$(shell pwd)/../example_music \
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
	http GET "http://127.0.0.1:$(TEST_PORT)/api/artists/Aquanaut/"; \
	echo "# Get songs for a specific artist"; \
	http GET "http://127.0.0.1:$(TEST_PORT)/api/artists/Aquanaut/songs"; \
	echo "# Test the 404 error handler"; \
	http GET "http://127.0.0.1:$(TEST_PORT)/api/nonexistent"
