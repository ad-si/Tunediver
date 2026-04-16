.PHONY: help
help: makefile
	@tail -n +4 makefile | grep ".PHONY"


.PHONY: test
test:
	npx tsc --noEmit


.PHONY: build
build: public/js/shaven.js
	npx tsc


# Copy shaven from node_modules and append a line to unwrap the default export
# (the bundle exposes shaven as { default: fn }, not a plain function)
public/js/shaven.js: node_modules/shaven/build/browser.js
	cp $< $@
	printf '\nshaven=shaven.default;\n' >> $@


node_modules/shaven/build/browser.js:
	npm install
