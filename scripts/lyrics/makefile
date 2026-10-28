.PHONY: help
help: makefile
	@tail -n +4 makefile | grep ".PHONY"


node_modules: package.json package-lock.json
	npm install
	@touch $@


.PHONY: test
test: node_modules
	npx tsc


# Fill in missing lyrics, e.g. `make fetch PLAYLIST=18b05d3fed1a71d0`.
# Extra flags go in ARGS, e.g. ARGS="--dry-run --sources lrclib".
.PHONY: fetch
fetch: node_modules
	@test -n "$(PLAYLIST)" || (echo "Usage: make fetch PLAYLIST=<id> [ARGS=...]" && exit 1)
	node src/main.ts $(PLAYLIST) $(ARGS)
