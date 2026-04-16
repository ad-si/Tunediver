.PHONY: help
help: makefile
	@tail -n +4 makefile | grep ".PHONY"


.PHONY: build
build: test
	cd desktop && make build
	cd frontend && make build
	cd server && make build


.PHONY: test
test:
	cd desktop && make test
	cd frontend && make test
	cd server && make test


.PHONY: format
format:
	cd server && make format


.PHONY: start
start:
	cd server && make start-with-path MUSIC_PATH=$(shell pwd)/example_music
