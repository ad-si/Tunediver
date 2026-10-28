// Genius (https://genius.com): plain lyrics only.
// Genius rejects scripted HTTP clients, so requests run inside a visible
// Chrome window driven by Playwright, one at a time.

import { chromium, type Browser, type Page } from "playwright-core"

import { artistsMatch, cleanTitle, titlesMatch } from "./match.ts"
import { sleep } from "./tunediver.ts"
import type { Lookup, LyricsSource, Track } from "./types.ts"

interface GeniusSong {
  title: string,
  url: string,
  artist_names?: string,
  primary_artist: { name: string },
  instrumental: boolean,
}

interface GeniusSearch {
  response: {
    sections: {
      type: string,
      hits: { type: string, result: GeniusSong }[],
    }[],
  },
}

const requestDelayMs = 800

// Runs in the page: text of all lyrics containers, without the
// contributor/translation header Genius places inside the first one
function extractLyrics(): string {
  return [...document.querySelectorAll("[data-lyrics-container=\"true\"]")]
    .map(container => {
      const copy = container.cloneNode(true) as Element
      copy.querySelectorAll("[data-exclude-from-selection=\"true\"]")
        .forEach(element => element.remove())
      copy.querySelectorAll("br").forEach(br => br.replaceWith("\n"))
      return copy.textContent ?? ""
    })
    .join("\n")
}

// Drop "[Chorus]"-style section labels and collapse blank-line runs
function tidy(text: string): string {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => !/^\[[^\]]*\]$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export function createGenius(): LyricsSource {
  let browser: Browser | null = null
  let page: Page | null = null

  async function openPage(): Promise<Page> {
    if (page) return page
    browser = await chromium.launch({ channel: "chrome", headless: false })
    page = await browser.newPage()
    await page.goto("https://genius.com/", { waitUntil: "domcontentloaded" })
    await sleep(3000)
    return page
  }

  async function search(query: string): Promise<GeniusSong[]> {
    const tab = await openPage()
    const [status, body] = await tab.evaluate(async query => {
      const response = await fetch("/api/search/multi?q=" + encodeURIComponent(query))
      return [response.status, await response.text()] as const
    }, query)
    await sleep(requestDelayMs)
    if (status !== 200) throw new Error(`Genius search "${query}": HTTP ${status}`)
    return (JSON.parse(body) as GeniusSearch).response.sections
      .filter(section => section.type === "song" || section.type === "top_hit")
      .flatMap(section => section.hits)
      .filter(hit => hit.type === "song")
      .map(hit => hit.result)
  }

  async function find(track: Track): Promise<Lookup> {
    const title = cleanTitle(track.title)
    const queries = new Set([
      `${track.artists[0]} ${title}`,
      `${title} ${track.artists[1] ?? ""}`.trim(),
    ])
    let song: GeniusSong | undefined
    for (const query of queries) {
      song = (await search(query)).find(hit =>
        titlesMatch(hit.title, track.title) &&
        artistsMatch(track.artists, hit.artist_names ?? hit.primary_artist.name)
      )
      if (song) break
    }
    if (!song) return { status: "none", source: "genius" }

    const match = song.url
    if (song.instrumental) return { status: "instrumental", source: "genius", match }

    const tab = await openPage()
    await tab.goto(song.url, { waitUntil: "domcontentloaded" })
    await sleep(1500)
    const lyrics = tidy(await tab.evaluate(extractLyrics))
    // Pages of unreleased or untranscribed songs have a placeholder instead
    if (lyrics.length < 40 || /lyrics for this song have yet to be/i.test(lyrics)) {
      return { status: "none", source: "genius", match }
    }
    return { status: "plain", source: "genius", match, lyrics }
  }

  async function close(): Promise<void> {
    await browser?.close()
    browser = null
    page = null
  }

  return { name: "genius", find, close }
}
