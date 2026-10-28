// Client for the Tunediver server API

import type { Track } from "./types.ts"

interface PlaylistEntry {
  artist_slug: string,
  slug: string,
  available: boolean,
}

interface SongDetail {
  title: string,
  track_artists: string[],
  lyrics: string,
  file_path: string,
  duration_secs: number,
}

interface ScanStatus {
  scanning: boolean,
}

// A playlist track as currently seen by the server
export interface Song extends Track {
  hasLyrics: boolean,
}

export class Tunediver {
  baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "") + "/api"
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.baseUrl + path, init)
    if (!response.ok) {
      throw new Error(`${init?.method ?? "GET"} ${path}: HTTP ${response.status}`)
    }
    const body = await response.json() as { data?: T, error?: string }
    if (body.data === undefined) {
      throw new Error(`${path}: ${body.error ?? "response has no data"}`)
    }
    return body.data
  }

  // Every available track of a playlist, deduplicated by file path
  async playlistSongs(playlistId: string): Promise<Song[]> {
    const playlist = await this.request<{ tracks: PlaylistEntry[] }>(
      `/playlists/${encodeURIComponent(playlistId)}`,
    )
    const songs = new Map<string, Song>()
    const entries = playlist.tracks.filter(entry => entry.available)
    // Slugs arrive already URL-encoded
    await mapConcurrent(entries, 8, async entry => {
      const song = await this.request<SongDetail>(
        `/artists/${entry.artist_slug}/songs/${entry.slug}`,
      )
      songs.set(song.file_path, {
        path: song.file_path,
        title: song.title,
        artists: song.track_artists,
        durationSecs: song.duration_secs,
        hasLyrics: song.lyrics.trim() !== "",
      })
    })
    return [...songs.values()]
  }

  // Rescan the library and wait until the server has picked up the changes
  async reload(): Promise<void> {
    await this.request("/reload", { method: "POST" })
    await sleep(2000)
    while ((await this.request<ScanStatus>("/scan-status")).scanning) {
      await sleep(2000)
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}
