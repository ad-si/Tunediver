// Fill in missing lyrics for the tracks of a Tunediver playlist.
//
// Looks every track without lyrics up in each source in turn (LRCLIB, then
// Genius), writes the first hit into the file's tags, rescans the library,
// and checks that the server sees the lyrics and unchanged artists.
// Lookups are cached per playlist, so interrupted runs resume where they
// stopped. Lyrics are never printed.

import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

import { createGenius } from "./genius.ts"
import { lrclib } from "./lrclib.ts"
import { writeLyrics } from "./tags.ts"
import { mapConcurrent, Tunediver, type Song } from "./tunediver.ts"
import type { Lookup, LyricsSource } from "./types.ts"

// file path → source name → lookup
type Cache = Record<string, Record<string, Lookup>>

const usage = `Usage: node src/main.ts <playlist-id> [options]

Options:
  --server <url>      Tunediver server (default: http://127.0.0.1:7313)
  --sources <list>    Comma-separated, in priority order (default: lrclib,genius)
  --cache <dir>       Lookup cache directory (default: ./lyrics-cache)
  --dry-run           Only look lyrics up, don't write any files
  --help              Show this help`

const sourceFactories: Record<string, () => LyricsSource> = {
  lrclib: () => lrclib,
  genius: createGenius,
}

// Genius only tolerates a single sequential browser session
const concurrency: Record<string, number> = { lrclib: 3, genius: 1 }

function parseCli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string", default: "http://127.0.0.1:7313" },
      sources: { type: "string", default: "lrclib,genius" },
      cache: { type: "string", default: "lyrics-cache" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  })
  if (values.help || positionals.length !== 1) {
    console.log(usage)
    process.exit(values.help ? 0 : 1)
  }
  const sources = values.sources.split(",").map(name => name.trim())
  const unknown = sources.filter(name => !(name in sourceFactories))
  if (unknown.length) {
    console.error(`Unknown source(s): ${unknown.join(", ")}`)
    process.exit(1)
  }
  return {
    playlistId: positionals[0],
    server: values.server,
    sources,
    cacheFile: path.join(values.cache, `${positionals[0]}.json`),
    dryRun: values["dry-run"],
  }
}

function loadCache(file: string): Cache {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Cache : {}
}

function saveCache(file: string, cache: Cache): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cache, null, 2) + "\n")
}

// The first lookup with lyrics, in source priority order
function bestLookup(cache: Cache, song: Song, sources: string[]): Lookup | undefined {
  return sources
    .map(source => cache[song.path]?.[source])
    .find(lookup => lookup?.lyrics !== undefined)
}

function describe(song: Song): string {
  return `${song.artists.join(", ")} — ${song.title}`
}

function countBy<T>(items: T[], key: (item: T) => string): string {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1)
  return [...counts].map(([name, count]) => `${count} ${name}`).join(", ") || "none"
}

async function lookUp(
  missing: Song[],
  sourceNames: string[],
  cache: Cache,
  cacheFile: string,
): Promise<void> {
  for (const name of sourceNames) {
    const pending = missing.filter(song =>
      !bestLookup(cache, song, sourceNames) && !cache[song.path]?.[name]
    )
    if (!pending.length) continue
    console.log(`\n${name}: looking up ${pending.length} tracks`)

    const source = sourceFactories[name]()
    let done = 0
    try {
      await mapConcurrent(pending, concurrency[name] ?? 1, async song => {
        const progress = () => `[${++done}/${pending.length}]`
        try {
          const lookup = await source.find(song)
          cache[song.path] = { ...cache[song.path], [name]: lookup }
          saveCache(cacheFile, cache)
          console.log(`${progress()} ${lookup.status.padEnd(12)} ${describe(song)}`)
        }
        catch (error) {
          // Not cached, so the next run retries it
          console.error(`${progress()} error        ${describe(song)}: ${error}`)
        }
      })
    }
    finally {
      await source.close?.()
    }
  }
}

async function main(): Promise<void> {
  const options = parseCli()
  const server = new Tunediver(options.server)
  const cache = loadCache(options.cacheFile)

  const before = await server.playlistSongs(options.playlistId)
  const missing = before.filter(song => !song.hasLyrics)
  console.log(`${before.length} tracks, ${missing.length} without lyrics`)

  await lookUp(missing, options.sources, cache, options.cacheFile)

  const found = missing.flatMap(song => {
    const lookup = bestLookup(cache, song, options.sources)
    return lookup ? [{ song, lookup }] : []
  })
  console.log(`\nFound: ${countBy(found, ({ lookup }) => `${lookup.status} (${lookup.source})`)}`)
  const notFound = missing.filter(song => !bestLookup(cache, song, options.sources))
  const instrumental = notFound.filter(song =>
    Object.values(cache[song.path] ?? {}).some(lookup => lookup.status === "instrumental")
  )
  console.log(`Not found: ${notFound.length} (${instrumental.length} marked instrumental)`)

  if (options.dryRun || !found.length) return

  console.log(`\nWriting ${found.length} files`)
  const written = new Set<string>()
  for (const { song, lookup } of found) {
    try {
      writeLyrics(song.path, lookup.lyrics as string)
      written.add(song.path)
    }
    catch (error) {
      console.error(`Writing ${song.path} failed: ${error}`)
    }
  }

  console.log("Rescanning library")
  await server.reload()
  const after = new Map(
    (await server.playlistSongs(options.playlistId)).map(song => [song.path, song]),
  )
  let problems = 0
  for (const song of missing.filter(song => written.has(song.path))) {
    const now = after.get(song.path)
    if (!now?.hasLyrics) {
      console.error(`Server sees no lyrics: ${song.path}`)
      problems++
    }
    else if (now.artists.join("\n") !== song.artists.join("\n")) {
      console.error(`Artists changed: ${song.path}: ${song.artists} → ${now.artists}`)
      problems++
    }
  }
  const stillMissing = [...after.values()].filter(song => !song.hasLyrics).length
  console.log(
    `Wrote ${written.size} files, ${problems} verification problems; ` +
    `${stillMissing} of ${after.size} tracks still without lyrics`,
  )
  if (problems) process.exitCode = 1
}

await main()
