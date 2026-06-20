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


.PHONY: clean
clean:
	cd desktop && make clean
	cd frontend && make clean
	cd server && make clean


.PHONY: format
format:
	cd server && make format


.PHONY: start
start:
	cd server && ROCKET_PORT=7314 make start-with-path MUSIC_PATH=$(shell pwd)/example_music


.PHONY: website-serve
website-serve:
	@echo "Serving website on http://localhost:8080"
	cd website && python3 -m http.server 8080


.PHONY: restart
restart:
	cargo install --path ./server --force
	launchctl kickstart -k gui/$(shell id -u)/com.tunediver.server


.PHONY: install
install:
	cargo install --path ./server
