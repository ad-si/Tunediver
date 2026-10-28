// LRCLIB (https://lrclib.net): free lyrics database with synced (LRC) lyrics

import { artistsMatch, cleanTitle, stripTimestamps, titlesMatch } from "./match.ts"
import { sleep } from "./tunediver.ts"
import type { Lookup, LyricsSource, Track } from "./types.ts"

interface LrclibRecord {
  id: number,
  trackName: string,
  artistName: string,
  duration: number | null,
  instrumental: boolean,
  plainLyrics: string | null,
  syncedLyrics: string | null,
}

const apiUrl = "https://lrclib.net/api/"
const userAgent = "Tunediver lyrics script (https://github.com/ad-si/Tunediver)"

// Timestamps are only trusted if the recording lengths agree this closely
const maxDurationDiffSecs = 4

async function request<T>(endpoint: string, query: Record<string, string>): Promise<T | null> {
  const url = apiUrl + endpoint + "?" + new URLSearchParams(query)
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": userAgent } })
      if (response.status === 404) return null
      if (response.ok) return await response.json() as T
      lastError = new Error(`HTTP ${response.status}`)
    }
    catch (error) {
      lastError = error
    }
    await sleep(1000 * 2 ** attempt)
  }
  throw new Error(`LRCLIB ${endpoint} ${JSON.stringify(query)}: ${lastError}`)
}

function hasContent(record: LrclibRecord | null): record is LrclibRecord {
  return record !== null &&
    (record.instrumental || Boolean(record.syncedLyrics || record.plainLyrics))
}

function durationDiff(record: LrclibRecord, track: Track): number {
  return Math.abs((record.duration ?? 0) - track.durationSecs)
}

// Lower is better; null if the record is a different song
function rank(record: LrclibRecord, track: Track): number | null {
  if (!titlesMatch(record.trackName, track.title)) return null
  if (!artistsMatch(track.artists, record.artistName)) return null
  const hasText = Boolean(record.syncedLyrics || record.plainLyrics)
  if (durationDiff(record, track) > maxDurationDiffSecs) {
    return hasText ? 3 : 4
  }
  if (record.syncedLyrics) return 0
  return hasText ? 1 : 2
}

async function candidates(track: Track): Promise<LrclibRecord[]> {
  const found: LrclibRecord[] = []
  const titles = new Set([track.title, cleanTitle(track.title)])
  const artistQueries = new Set([track.artists.join(", "), track.artists[0]])

  for (const title of titles) {
    // Exact lookup; LRCLIB itself only matches within ±2 s of the duration
    for (const artist of artistQueries) {
      const record = await request<LrclibRecord>("get", {
        artist_name: artist,
        track_name: title,
        duration: String(track.durationSecs),
      })
      if (hasContent(record)) {
        if (record.syncedLyrics) return [record]
        found.push(record)
      }
    }
    const searches: Record<string, string>[] = [
      { track_name: title, artist_name: track.artists[0] },
      { q: `${track.artists[0]} ${title}` },
    ]
    for (const query of searches) {
      const records = await request<LrclibRecord[]>("search", query) ?? []
      found.push(...records.filter(hasContent))
    }
  }
  return found
}

async function find(track: Track): Promise<Lookup> {
  let best: { record: LrclibRecord, rank: number, diff: number } | null = null
  for (const record of await candidates(track)) {
    const recordRank = rank(record, track)
    if (recordRank === null) continue
    const diff = durationDiff(record, track)
    if (!best || recordRank < best.rank || (recordRank === best.rank && diff < best.diff)) {
      best = { record, rank: recordRank, diff }
    }
  }
  if (!best) return { status: "none", source: "lrclib" }

  const { record } = best
  const match = `${record.artistName} - ${record.trackName} (${record.duration}s, #${record.id})`
  const text = record.syncedLyrics ?? record.plainLyrics
  if (!text) return { status: "instrumental", source: "lrclib", match }

  // A different cut of the song (remix, radio edit, …): keep the text,
  // drop timestamps that would be off
  if (best.diff > maxDurationDiffSecs) {
    return {
      status: "plain",
      source: "lrclib",
      match,
      lyrics: record.plainLyrics ?? stripTimestamps(text),
    }
  }
  return {
    status: record.syncedLyrics ? "synced" : "plain",
    source: "lrclib",
    match,
    lyrics: text,
  }
}

export const lrclib: LyricsSource = { name: "lrclib", find }
