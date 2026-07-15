// Global song registry (simpler approach for TypeScript compatibility)
let songRegistry: Record<string, SongRegistryEntry> = {}

// DOM helper utility function similar to jQuery"s $
function $(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Element with id "${id}" not found`)
  }
  return element
}

// DOM element creation/manipulation function (externally defined)
declare function shaven(a: any[] | object): {
  rootElement: HTMLElement
  0: HTMLElement
  ids: Record<string, HTMLElement>
  references: Record<string, HTMLElement>
  toString(): string
}

// Global variables
const baseURL = ""
const settings: Record<string, any> = {}
const playlist: Song[] = []

// The current track, active tab, open playlist, playlist sort, shuffle, and
// repeat state now live in the reactive `store` (see store.ts). Row markers,
// the play/pause button, and the shuffle/repeat button state re-sync
// automatically when those fields change, via the effects in wireStoreEffects.

// Keys ("artistSlug/songSlug") of the most recently played tracks, oldest
// first. Shuffle avoids re-picking anything in this window so the same songs
// don't recur too soon; it's a best-effort filter that's relaxed when the
// active list is too small to offer fresh tracks.
const recentlyPlayed: string[] = []
const RECENT_LIMIT = 10

// Mark the given c1 tab button as active and clear the active state
// from the others. Pass null to clear all. Drives the colored highlight
// on whichever tab's view is currently rendered.
function setActiveTab(tabId: string | null): void {
  document.querySelectorAll("#c1 > button").forEach((b) => {
    b.classList.remove("active")
  })
  if (!tabId) return
  const tab = document.getElementById(tabId)
  if (tab) tab.classList.add("active")
}

// Add/remove the `.playing` CSS class on artist and song rows so the
// currently playing track is visually highlighted in the columns. The store
// effect in wireStoreEffects re-runs this when the current track or play state
// changes; the render functions also call it to mark their freshly-built rows.
function updatePlayingMarkers(): void {
  document.querySelectorAll(".row.playing").forEach((r) => {
    r.classList.remove("playing")
  })

  const playing = store.currentlyPlaying
  if (!playing || store.playState !== "playing") return

  const artistSlug = playing.artistSlug
  const songSlug = playing.songSlug

  // Artist rows carry only an artist slug; song rows (artist tab's c3, the
  // songs tab's flat list in c2, and search results) also carry a song slug,
  // so exclude them here to avoid marking the wrong song by the same artist.
  const artistRow = document.querySelector(
    `#c2 .row[data-artist-slug="${CSS.escape(artistSlug)}"]`
    + `:not([data-song-slug])`
  )
  if (artistRow) artistRow.classList.add("playing")

  const songSelector =
    `.row[data-artist-slug="${CSS.escape(artistSlug)}"]`
    + `[data-song-slug="${CSS.escape(songSlug)}"]`
  document.querySelectorAll(`#c2 ${songSelector}, #c3 ${songSelector}`)
    .forEach((row) => row.classList.add("playing"))
}

// Register the reactive effects that keep the player UI in sync with the
// store. Called once from index() after the player DOM exists. Each effect
// also runs immediately on registration, which is a harmless no-op against the
// defaults (paused, nothing playing, shuffle off, repeat off).
function wireStoreEffects(): void {
  // Row highlighting and synced-lyrics highlighting follow the current track
  // and play state, wherever they were changed from.
  effect(["currentlyPlaying", "playState"], () => {
    updatePlayingMarkers()
    updateSyncedLyrics()
  })

  // The transport play/pause button and the OS media-session state mirror
  // playState (set by the audio element's play/pause/ended events).
  effect(["playState"], () => {
    const playEl = document.getElementById("play")
    if (playEl) {
      playEl.className = store.playState === "playing" ? "playing" : "paused"
    }
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = store.playState
    }
  })

  // Shuffle button: `.active` class + title.
  effect(["shuffleEnabled"], () => {
    const el = document.getElementById("shuffle")
    if (!el) return
    el.classList.toggle("active", store.shuffleEnabled)
    el.setAttribute(
      "title", store.shuffleEnabled ? "Shuffle: on" : "Shuffle: off"
    )
  })

  // Repeat button: `.active` lights the icon for both repeat modes; `.one`
  // adds the "1" badge that distinguishes repeat-one from repeat-all.
  effect(["repeatMode"], () => {
    const el = document.getElementById("repeat")
    if (!el) return
    el.classList.toggle("active", store.repeatMode !== "off")
    el.classList.toggle("one", store.repeatMode === "one")
    el.setAttribute("title", "Repeat: " + store.repeatMode)
  })
}

// --- Global fuzzy search ---------------------------------------------------

// The search catalog, its loading flag, and the last-acted query live in the
// reactive `store` (see store.ts). Invalidate drops the cached catalog so the
// next search re-fetches (after the query clears, a scan finishes, or
// playlists mutate).
function invalidateSearchCatalog(): void {
  store.searchCatalog = null
}

// How many hits each category section shows at most.
const SEARCH_LIMITS = { artists: 8, songs: 20, playlists: 8 }

function isWordChar(ch: string): boolean {
  return /[a-z0-9]/i.test(ch)
}

// Score how well the (lowercased) query matches the (lowercased) target, as
// a fraction in (0, 1] where 1 is a perfect match, or null when the query's
// characters don't all appear in order. Substring hits (≥ 0.6) always
// outrank scattered subsequence hits (≤ 0.6); within each kind, matches at
// the start of the string or of a word outrank mid-word ones, and queries
// covering more of the target outrank ones that leave most of it unmatched.
function fuzzyScoreSingle(q: string, t: string): number | null {
  const idx = t.indexOf(q)
  if (idx !== -1) {
    const positionBonus = idx === 0
      ? 0.15
      : !isWordChar(t[idx - 1]) ? 0.1 : 0.05
    return 0.6 + 0.25 * (q.length / t.length) + positionBonus
  }

  // Subsequence match: all query characters appear in order, but scattered.
  // Favour runs of adjacent characters and characters landing on word starts.
  let qi = 0
  let adjacent = 0
  let wordStarts = 0
  let prev = -2
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    if (ti === prev + 1) adjacent++
    if (ti === 0 || !isWordChar(t[ti - 1])) wordStarts++
    prev = ti
    qi++
  }
  if (qi < q.length) return null
  const adjacency = q.length > 1 ? adjacent / (q.length - 1) : 0
  return 0.1
    + 0.25 * adjacency
    + 0.15 * (wordStarts / q.length)
    + 0.1 * (q.length / t.length)
}

// Case-insensitive scoring entry point. Besides matching the query as a
// whole, a multi-word query may match with its tokens in any order (so
// "hurricane dylan" still finds "Bob Dylan — Hurricane"); the token score
// is the average of the per-token scores, and the best variant wins.
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q.length || !t.length) return null

  let best = fuzzyScoreSingle(q, t)

  const tokens = q.split(/\s+/).filter((tok) => tok.length > 0)
  if (tokens.length > 1) {
    let sum = 0
    let allMatch = true
    for (const tok of tokens) {
      const s = fuzzyScoreSingle(tok, t)
      if (s === null) {
        allMatch = false
        break
      }
      sum += s
    }
    if (allMatch) {
      const avg = sum / tokens.length
      if (best === null || avg > best) best = avg
    }
  }

  return best
}

// Score every item against the query via one or more candidate strings (the
// best-scoring candidate wins) and return the matches sorted by descending
// score. Ties keep the catalog's (alphabetical) order — sort is stable.
function rankMatches<T>(
  items: T[],
  candidates: (item: T) => string[],
  query: string,
): { item: T; score: number }[] {
  const scored: { item: T; score: number }[] = []
  items.forEach((item) => {
    let best: number | null = null
    for (const text of candidates(item)) {
      const s = fuzzyScore(query, text)
      if (s !== null && (best === null || s > best)) best = s
    }
    if (best !== null) scored.push({ item, score: best })
  })
  return scored.sort((a, b) => b.score - a.score)
}

function currentSearchQuery(): string {
  return ($("search") as HTMLInputElement).value.trim()
}

// React to the search box changing. An empty query ends the search session
// and re-renders whatever view the URL points at; a non-empty query renders
// global results (fetching the catalog first if needed).
function handleSearchInput(): void {
  const q = currentSearchQuery()
  if (q === store.lastSearchQuery) return
  store.lastSearchQuery = q

  if (!q) {
    invalidateSearchCatalog()
    const path = location.pathname.slice(
      baseURL.length + 1, location.pathname.length
    )
    route(path)
    return
  }

  if (store.searchCatalog) {
    renderSearchResults()
  } else {
    fetchSearchCatalog()
  }
}

// Reset the search box and end the search session without re-routing —
// used by the tab buttons, which render their own view right after.
function clearSearch(): void {
  ;($("search") as HTMLInputElement).value = ""
  store.lastSearchQuery = ""
  invalidateSearchCatalog()
}

// Load artists, songs, and playlists in parallel, then render results for
// whatever query is in the box by then (it may have changed while the
// requests were in flight, or been cleared entirely).
function fetchSearchCatalog(): void {
  if (store.searchCatalogLoading) return
  store.searchCatalogLoading = true

  let artists: Artist[] = []
  let songs: Song[] = []
  let playlists: PlaylistSummary[] = []
  let pending = 3

  const done = (): void => {
    pending--
    if (pending > 0) return
    store.searchCatalogLoading = false
    store.searchCatalog = { artists, songs, playlists }
    if (currentSearchQuery()) renderSearchResults()
  }

  ajax<Artist[]>("/artists", (data) => { artists = data; done() })
  ajax<Song[]>("/songs", (data) => { songs = data; done() })
  ajax<PlaylistSummary[]>("/playlists", (data) => { playlists = data; done() })
}

function playFirstArtistSong(artistSlug: string): void {
  ajax<Song[]>(`/artists/${artistSlug}/songs`, (songs) => {
    if (songs.length) playSong(songs[0], artistSlug, false)
  })
}

function playFirstGenreSong(genreSlug: string): void {
  ajax<Song[]>(`/genres/${genreSlug}/songs`, (songs) => {
    if (songs.length) playGenreSong(genreSlug, songs[0])
  })
}

function playFirstPlaylistTrack(id: string): void {
  ajax<Playlist>(`/playlists/${id}`, (full) => {
    const idx = full.tracks.findIndex((t) => t.available)
    if (idx === -1) return
    playPlaylistTrack(full.id, idx, full.tracks[idx])
  })
}

// Render grouped global search results into c2: one section per category
// (Songs, Artists, Playlists) with the top hits sorted by match quality.
// c3 is hidden until a result that needs it (an artist or playlist) is
// opened; clicking a result behaves like clicking it in its home tab, and
// the play button / double-click starts playback directly.
function renderSearchResults(): void {
  if (!store.searchCatalog) return
  const query = currentSearchQuery()
  if (!query) return

  const artists = rankMatches(
    store.searchCatalog.artists,
    (artist) => [artist.name],
    query,
  )
  const songs = rankMatches(
    store.searchCatalog.songs,
    (song) => {
      const texts = [song.title]
      if (song.track_artist) {
        texts.push(song.track_artist)
        texts.push(song.track_artist + " " + song.title)
      }
      return texts
    },
    query,
  )
  const playlists = rankMatches(
    store.searchCatalog.playlists,
    (playlist) => [playlist.name],
    query,
  )

  const c2 = $("c2")
  c2.innerHTML = ""
  c2.style.display = "inline-block"
  $("c3").innerHTML = ""
  $("c3").style.display = "none"
  setActiveTab(null)
  // Widen c2 to an equal share of the space while it shows search results;
  // the tab views remove the class again when they take c2 back over.
  $("wrapper").classList.remove("songsActive")
  $("wrapper").classList.remove("playlistActive")
  $("wrapper").classList.add("searchActive")

  const heading = (label: string, shown: number, total: number): void => {
    const text = total > shown
      ? `${label} · top ${shown} of ${total}`
      : `${label} (${total})`
    c2.appendChild(shaven(["h3#.searchHeading", text]).rootElement)
  }

  const pct = (score: number): string =>
    `${Math.round(score * 100)}% match`

  if (songs.length) {
    heading(
      "Songs",
      Math.min(songs.length, SEARCH_LIMITS.songs),
      songs.length,
    )
    songs.slice(0, SEARCH_LIMITS.songs).forEach(({ item, score }, i) => {
      const artistSlug = item.artist_slug || ""
      const songId = `search-song-${i}-${item.id || 0}`
      songRegistry[songId] = { song: item, artist: artistSlug }

      const link = shaven(["a", item.title]).rootElement
      if (item.track_artist) {
        link.appendChild(shaven(
          ["span#.resultMeta", " — " + item.track_artist]
        ).rootElement)
      }

      c2.appendChild(shaven(
        ["div#.row", {
          "title":
            `${item.track_artist || ""} — ${item.title} (${pct(score)})`,
          "data-search-type": "song",
          "data-song-id": songId,
          "data-search-index": String(i),
          "data-artist-slug": artistSlug,
          "data-song-slug": item.slug,
        },
          ["button#.play"],
          [link],
        ]
      ).rootElement)
    })
  }

  if (artists.length) {
    heading(
      "Artists",
      Math.min(artists.length, SEARCH_LIMITS.artists),
      artists.length,
    )
    artists.slice(0, SEARCH_LIMITS.artists).forEach(({ item, score }) => {
      c2.appendChild(shaven(
        ["div#.row", {
          "title": `${item.name} (${pct(score)})`,
          "data-search-type": "artist",
          "data-artist-slug": item.slug,
        },
          ["button#.play"],
          ["a", item.name],
        ]
      ).rootElement)
    })
  }

  if (playlists.length) {
    heading(
      "Playlists",
      Math.min(playlists.length, SEARCH_LIMITS.playlists),
      playlists.length,
    )
    playlists.slice(0, SEARCH_LIMITS.playlists).forEach(({ item, score }) => {
      const link = shaven(["a", item.name]).rootElement
      link.appendChild(shaven(
        ["span#.resultMeta",
          ` — ${item.track_count} ${item.track_count === 1 ? "track" : "tracks"}`]
      ).rootElement)

      c2.appendChild(shaven(
        ["div#.row", {
          "title": `${item.name} (${pct(score)})`,
          "data-search-type": "playlist",
          "data-playlist-id": item.id,
        },
          ["button#.play"],
          [link],
        ]
      ).rootElement)
    })
  }

  if (!artists.length && !songs.length && !playlists.length) {
    c2.appendChild(shaven(
      ["p#.searchEmpty", `No results for “${query}”`]
    ).rootElement)
  }

  // The playable song results, in display order, so playing one can snapshot
  // this list as the search queue (store.searchQueue) for prev/next. Row
  // `data-search-index` values index into it.
  const shownSongs: Song[] = songs
    .slice(0, SEARCH_LIMITS.songs)
    .map(({ item }) => item)

  // Start playback from a search song row, remembering the search results as
  // the playback context so the transport prev/next walk them.
  const playSearchRow = (row: HTMLElement): void => {
    const idxAttr = row.getAttribute("data-search-index")
    if (idxAttr === null) return
    store.searchQueue = shownSongs
    playSearchSong(parseInt(idxAttr, 10))
  }

  // Property-assigned so re-renders (and the tab views, which assign their
  // own delegated handlers to c2) replace rather than stack. Guarded on
  // data-search-type so a stale handler no-ops on other views' rows.
  c2.onclick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const row = target.closest(".row") as HTMLElement | null
    if (!row) return
    const type = row.getAttribute("data-search-type")
    if (!type) return
    e.preventDefault()

    const isPlay = target.classList.contains("play")

    if (type === "artist") {
      const slug = row.getAttribute("data-artist-slug") || ""
      if (isPlay) {
        e.stopPropagation()
        playFirstArtistSong(slug)
        return
      }
      highlight(row)
      printObj.songs(slug)
      printObj.artist(slug)
      const url = artistPath(slug)
      history.pushState({ "url": url }, slug, baseURL + "/" + url)
      return
    }

    if (type === "song") {
      const songId = row.getAttribute("data-song-id")
      if (!songId || !songRegistry[songId]) return
      const { song, artist } = songRegistry[songId]
      if (isPlay) {
        e.stopPropagation()
        playSearchRow(row)
        return
      }
      highlight(row)
      printObj.song(song.slug, artist)
      const url = songPath(artist, song.slug)
      history.pushState({ "url": url }, song.slug, baseURL + "/" + url)
      return
    }

    const playlistId = row.getAttribute("data-playlist-id")
    if (!playlistId) return
    if (isPlay) {
      e.stopPropagation()
      playFirstPlaylistTrack(playlistId)
      return
    }
    highlight(row)
    printObj.playlist(playlistId)
    const url = "playlists/" + playlistId
    history.pushState({ "url": url }, "Playlist", baseURL + "/" + url)
  }

  c2.ondblclick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const row = target.closest(".row") as HTMLElement | null
    if (!row) return
    const type = row.getAttribute("data-search-type")
    if (!type) return
    e.preventDefault()
    e.stopPropagation()

    if (type === "artist") {
      playFirstArtistSong(row.getAttribute("data-artist-slug") || "")
    } else if (type === "song") {
      playSearchRow(row)
    } else {
      const playlistId = row.getAttribute("data-playlist-id")
      if (playlistId) playFirstPlaylistTrack(playlistId)
    }
  }

  updatePlayingMarkers()
}

// Helper function to play a song - centralized to improve reliability
function playSong(
  song: Song,
  artistName: string,
  updateUrl: boolean = false,
  autoplay: boolean = true,
): void {
  if (!song || song.src === "") {
    console.error("No source available for the song")
    return
  }

  // Stop any currently playing audio (its "pause" event resets store.playState,
  // which the effects mirror onto the button and row markers).
  if (audio && !audio.paused) {
    audio.pause()
  }

  try {
    // Create a new Audio object with the song source
    const newAudio = new Audio(song.src)

    // Wire the fresh audio to the store + player UI (play/pause/ended drive
    // store.playState and auto-advance) before swapping it in.
    attachAudioListeners(newAudio)

    // Set the volume to match the current volume
    newAudio.volume = audio.volume

    // Now replace the global audio instance
    audio = newAudio

    // Remember which track is loaded so row markers can find it. Setting this
    // triggers the store effect that (re)applies the .playing markers; they
    // only show once playback actually starts (store.playState === "playing").
    store.currentlyPlaying = { artistSlug: artistName, songSlug: song.slug }

    // Record play history for shuffle's recent-repeat avoidance. Only count
    // tracks that actually start playing, not ones merely pre-loaded (the
    // landing-page random preload passes autoplay = false).
    if (autoplay) {
      rememberPlayed(songKey(artistName, song.slug))
    }

    // Enable transport buttons now that a song is loaded
    for (const id of ["previous", "play", "next"]) {
      const el = document.getElementById(id)
      if (el) el.removeAttribute("disabled")
    }

    // Update UI and optionally start playing
    if (autoplay) {
      playpause()
    }
    // Player info is Artist - Title, both taken from the audio file's
    // embedded tags (track_artist / title). The artist name is a link to the
    // artist's page; clicking elsewhere on the info (the title) still opens
    // the song detail via the #playerInfo handler. Build with textContent so
    // tag values containing HTML-special characters render as text.
    const playerInfoEl = $("playerInfo")
    playerInfoEl.innerHTML = ""
    const artistLink = document.createElement("a")
    artistLink.className = "playerArtist"
    artistLink.textContent = song.track_artist || ""
    artistLink.addEventListener("click", (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      const url = artistPath(artistName)
      history.pushState({ "url": url }, artistName, baseURL + "/" + url)
      route(url)
    })
    playerInfoEl.appendChild(artistLink)
    playerInfoEl.appendChild(document.createTextNode(" - " + song.title))

    // Populating MediaSession metadata is what makes macOS route the
    // next/previous media keys to this tab. Without it, only play/pause
    // (handled by the audio element directly) reaches the page.
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.track_artist || "",
      })
    }

    // Update URL only if explicitly requested
    if (updateUrl && song.slug) {
      const url = songPath(artistName, song.slug)
      history.pushState({"url": url}, song.title, baseURL + "/" + url)
    }
  } catch (e) {
    console.error("Error playing song:", e)
  }
}

// Play the song adjacent to the currently playing one. `direction` is +1
// for next, -1 for previous. The source list depends on the active tab:
// in the Artists tab we step through the current artist's songs; in the
// Songs tab we step through the flat, alphabetical all-songs list. No-op
// if nothing is playing, or if there is no neighbour in that direction.
function playAdjacentSong(direction: 1 | -1): void {
  if (!store.currentlyPlaying) return

  // In shuffle mode the direction is irrelevant: prev, next, and
  // auto-advance all jump to a random track in the active context.
  if (store.shuffleEnabled) {
    playRandomInContext()
    return
  }

  const {
    artistSlug, songSlug, playlistId, playlistIndex, searchIndex, genreSlug,
  } = store.currentlyPlaying

  // Search context overrides store.currentTab, like the playlist context does:
  // prev/next step through the snapshotted search results (store.searchQueue),
  // even if the query has since changed or the search view was left.
  if (searchIndex !== undefined && store.searchQueue) {
    const targetIdx = neighbourIndex(
      searchIndex, direction, store.searchQueue.length
    )
    if (targetIdx === null) return
    const target = playSearchSong(targetIdx)
    if (!target) return
    // If the search view is still shown, keep its highlight in sync.
    const row = $("c2").querySelector(
      `.row[data-search-index="${targetIdx}"]`
    ) as HTMLElement | null
    if (row) {
      highlight(row)
      row.scrollIntoView({ block: "nearest" })
    }
    const url = songPath(target.artist_slug || "", target.slug)
    history.pushState({ "url": url }, target.slug, baseURL + "/" + url)
    return
  }

  // Playlist context overrides store.currentTab: even if the user has navigated
  // away from the Playlists tab while a song plays, prev/next still walks
  // the playlist that started playback.
  if (playlistId !== undefined && playlistIndex !== undefined) {
    ajax<Playlist>(`/playlists/${playlistId}`, (playlist) => {
      const targetIdx = neighbourIndex(
        playlistIndex, direction, playlist.tracks.length
      )
      if (targetIdx === null) return
      const target = playlist.tracks[targetIdx]
      if (!target || !target.available) return
      playPlaylistTrack(playlist.id, targetIdx, target)

      // If we're still viewing this playlist in c3, sync the highlight and
      // detail view so the UI reflects what's playing.
      if (store.currentPlaylistId === playlist.id) {
        const row = $("c3").querySelector(
          `.row[data-playlist-index="${targetIdx}"]`
        ) as HTMLElement | null
        if (row) {
          highlight(row)
          row.scrollIntoView({ block: "nearest" })
        }
      }
      printObj.song(target.slug, target.artist_slug)
      const url = `playlists/${playlist.id}/${targetIdx}`
      history.pushState({ "url": url }, target.slug, baseURL + "/" + url)
    })
    return
  }

  // Genre context likewise overrides store.currentTab: prev/next step through
  // the (alphabetical) song list of the genre playback started from.
  if (genreSlug !== undefined) {
    ajax<Song[]>(`/genres/${genreSlug}/songs`, (songs) => {
      const idx = songs.findIndex((s) =>
        s.slug === songSlug && (s.artist_slug || "") === artistSlug
      )
      if (idx === -1) return
      const targetIdx = neighbourIndex(idx, direction, songs.length)
      if (targetIdx === null) return
      const target = songs[targetIdx]
      playGenreSong(genreSlug, target)
      highlightGenreRow(target)
      printObj.song(target.slug, target.artist_slug || "")
      const url = songPath(target.artist_slug || "", target.slug)
      history.pushState({ "url": url }, target.slug, baseURL + "/" + url)
    })
    return
  }

  if (store.currentTab === "songs") {
    ajax<Song[]>("/songs", (songs) => {
      const idx = songs.findIndex((s) =>
        s.slug === songSlug && (s.artist_slug || "") === artistSlug
      )
      if (idx === -1) return
      const targetIdx = neighbourIndex(idx, direction, songs.length)
      if (targetIdx === null) return
      const target = songs[targetIdx]
      const targetArtistSlug = target.artist_slug || ""
      playSong(target, targetArtistSlug, false)

      // Mirror the Songs-tab click behaviour: highlight the new row in c2,
      // render its detail in c4, and update the URL so the page reflects
      // whatever is currently playing.
      const newRow = $("c2").querySelector(
        `.row[data-artist-slug="${CSS.escape(targetArtistSlug)}"]`
        + `[data-song-slug="${CSS.escape(target.slug)}"]`
      ) as HTMLElement | null
      if (newRow) {
        highlight(newRow)
        newRow.scrollIntoView({ block: "nearest" })
      }
      printObj.song(target.slug, targetArtistSlug)
      const url = songPath(targetArtistSlug, target.slug)
      history.pushState({"url": url}, target.slug, baseURL + "/" + url)
    })
    return
  }

  ajax<Song[]>(`/artists/${artistSlug}/songs`, (songs) => {
    const idx = songs.findIndex((s) => s.slug === songSlug)
    if (idx === -1) return
    const targetIdx = neighbourIndex(idx, direction, songs.length)
    if (targetIdx === null) return
    const target = songs[targetIdx]
    playSong(target, artistSlug, false)
  })
}

// Resolve the index of the sequential neighbour of `idx` in a list of
// `length` items. Returns null when stepping past either end, except in
// repeat-all mode, where it wraps around to the opposite end.
function neighbourIndex(
  idx: number, direction: 1 | -1, length: number
): number | null {
  const next = idx + direction
  if (next >= 0 && next < length) return next
  if (store.repeatMode === "all" && length > 0) return (next + length) % length
  return null
}

// Stable identity for a track across contexts (artist tab, songs tab,
// playlists), used to track play history and de-duplicate shuffle picks.
function songKey(artistSlug: string, songSlug: string): string {
  return artistSlug + "/" + songSlug
}

// The visible row label for a track: "Artist — Title", falling back to
// just the title when no artist credit is known.
function songLabel(trackArtist: string | undefined, title: string): string {
  return trackArtist ? trackArtist + " — " + title : title
}

// Client-side route paths (without baseURL or a leading slash) — the value
// stored in history state and passed to route(). Artist and song views live
// under /artists so they never collide with the root-level static-asset and
// audio-streaming routes the server serves at the path root.
function artistPath(artistSlug: string): string {
  return "artists/" + artistSlug
}
function songPath(artistSlug: string, songSlug: string): string {
  return "artists/" + artistSlug + "/songs/" + songSlug
}

// Record a track as just played, keeping the most recent RECENT_LIMIT keys.
// Re-playing a track moves it to the front of the window rather than keeping
// a stale position, so the window always reflects true recency.
function rememberPlayed(key: string): void {
  const existing = recentlyPlayed.indexOf(key)
  if (existing !== -1) recentlyPlayed.splice(existing, 1)
  recentlyPlayed.push(key)
  while (recentlyPlayed.length > RECENT_LIMIT) recentlyPlayed.shift()
}

// Pick a random index into `keys` (one key per candidate track), avoiding any
// track played recently. When every candidate is in the recent window (the
// list is smaller than the window), fall back to the full list but still
// avoid an immediate repeat of `currentKey` when there's an alternative.
function randomFreshIndex(keys: string[], currentKey: string): number {
  const recent = new Set(recentlyPlayed)
  const fresh: number[] = []
  for (let i = 0; i < keys.length; i++) {
    if (!recent.has(keys[i])) fresh.push(i)
  }
  let pool = fresh
  if (!pool.length) {
    pool = []
    for (let i = 0; i < keys.length; i++) {
      if (keys.length === 1 || keys[i] !== currentKey) pool.push(i)
    }
  }
  return pool[Math.floor(Math.random() * pool.length)]
}

// Play a random track from whatever context is currently driving playback,
// mirroring the per-context highlight/URL bookkeeping of playAdjacentSong.
// Used by prev/next and auto-advance while shuffle is enabled.
function playRandomInContext(): void {
  if (!store.currentlyPlaying) return
  const {
    artistSlug, songSlug, playlistId, playlistIndex, searchIndex, genreSlug,
  } = store.currentlyPlaying

  // Search context: shuffle picks a random track from the search queue.
  if (searchIndex !== undefined && store.searchQueue) {
    const queue = store.searchQueue
    if (!queue.length) return
    const keys = queue.map((s) => songKey(s.artist_slug || "", s.slug))
    const pickIdx = randomFreshIndex(keys, songKey(artistSlug, songSlug))
    const target = playSearchSong(pickIdx)
    if (!target) return
    const row = $("c2").querySelector(
      `.row[data-search-index="${pickIdx}"]`
    ) as HTMLElement | null
    if (row) {
      highlight(row)
      row.scrollIntoView({ block: "nearest" })
    }
    const url = songPath(target.artist_slug || "", target.slug)
    history.pushState({ "url": url }, target.slug, baseURL + "/" + url)
    return
  }

  if (playlistId !== undefined && playlistIndex !== undefined) {
    ajax<Playlist>(`/playlists/${playlistId}`, (playlist) => {
      const playable = playlist.tracks
        .map((track, index) => ({ track, index }))
        .filter((entry) => entry.track.available)
      if (!playable.length) return
      const keys = playable.map((e) =>
        songKey(e.track.artist_slug, e.track.slug)
      )
      const pick = playable[
        randomFreshIndex(keys, songKey(artistSlug, songSlug))
      ]
      playPlaylistTrack(playlist.id, pick.index, pick.track)

      if (store.currentPlaylistId === playlist.id) {
        const row = $("c3").querySelector(
          `.row[data-playlist-index="${pick.index}"]`
        ) as HTMLElement | null
        if (row) {
          highlight(row)
          row.scrollIntoView({ block: "nearest" })
        }
      }
      printObj.song(pick.track.slug, pick.track.artist_slug)
      const url = `playlists/${playlist.id}/${pick.index}`
      history.pushState({ "url": url }, pick.track.slug, baseURL + "/" + url)
    })
    return
  }

  // Genre context: shuffle picks a random not-recently-played track from the
  // genre's song list.
  if (genreSlug !== undefined) {
    ajax<Song[]>(`/genres/${genreSlug}/songs`, (songs) => {
      if (!songs.length) return
      const keys = songs.map((s) => songKey(s.artist_slug || "", s.slug))
      const target = songs[
        randomFreshIndex(keys, songKey(artistSlug, songSlug))
      ]
      playGenreSong(genreSlug, target)
      highlightGenreRow(target)
      printObj.song(target.slug, target.artist_slug || "")
      const url = songPath(target.artist_slug || "", target.slug)
      history.pushState({ "url": url }, target.slug, baseURL + "/" + url)
    })
    return
  }

  if (store.currentTab === "songs") {
    ajax<Song[]>("/songs", (songs) => {
      if (!songs.length) return
      const keys = songs.map((s) => songKey(s.artist_slug || "", s.slug))
      const target = songs[
        randomFreshIndex(keys, songKey(artistSlug, songSlug))
      ]
      const targetArtistSlug = target.artist_slug || ""
      playSong(target, targetArtistSlug, false)

      const newRow = $("c2").querySelector(
        `.row[data-artist-slug="${CSS.escape(targetArtistSlug)}"]`
        + `[data-song-slug="${CSS.escape(target.slug)}"]`
      ) as HTMLElement | null
      if (newRow) {
        highlight(newRow)
        newRow.scrollIntoView({ block: "nearest" })
      }
      printObj.song(target.slug, targetArtistSlug)
      const url = songPath(targetArtistSlug, target.slug)
      history.pushState({"url": url}, target.slug, baseURL + "/" + url)
    })
    return
  }

  ajax<Song[]>(`/artists/${artistSlug}/songs`, (songs) => {
    if (!songs.length) return
    const keys = songs.map((s) => songKey(artistSlug, s.slug))
    const target = songs[
      randomFreshIndex(keys, songKey(artistSlug, songSlug))
    ]
    playSong(target, artistSlug, false)
  })
}

// Pick a random artist and a random song from that artist, then pre-load
// it in the player without starting playback. Retries with a different
// artist if the picked one has no listable songs.
function loadRandomSong(): void {
  ajax<Artist[]>("/artists", (artists) => {
    tryRandomArtist(artists.slice())
  })
}

function tryRandomArtist(remaining: Artist[]): void {
  if (!remaining.length) return
  const idx = Math.floor(Math.random() * remaining.length)
  const artist = remaining[idx]
  ajax<Song[]>(`/artists/${artist.slug}/songs`, (songs) => {
    if (songs.length) {
      const song = songs[Math.floor(Math.random() * songs.length)]
      playSong(song, artist.slug, false, false)
    } else {
      remaining.splice(idx, 1)
      tryRandomArtist(remaining)
    }
  })
}

// Wrap playSong with playlist-context tracking so prev/next can walk the
// playlist. We patch `store.currentlyPlaying` after `playSong` sets it because
// playSong itself has no notion of playlists.
function playPlaylistTrack(
  playlistId: string,
  index: number,
  track: PlaylistTrack,
): void {
  if (!track.available) return
  playSong(track as unknown as Song, track.artist_slug, false)
  if (store.currentlyPlaying) {
    store.currentlyPlaying.playlistId = playlistId
    store.currentlyPlaying.playlistIndex = index
  }
}

// Wrap playSong with genre-context tracking so prev/next, shuffle, and
// auto-advance walk the genre's song list. Patched after `playSong` sets
// store.currentlyPlaying because playSong itself has no notion of genres.
function playGenreSong(genreSlug: string, song: Song): void {
  playSong(song, song.artist_slug || "", false)
  if (store.currentlyPlaying) {
    store.currentlyPlaying.genreSlug = genreSlug
  }
}

// If a genre's song list is still shown in c3, keep its highlight in sync
// with what's playing. Genre rows are identified by their registry-id prefix,
// so rows from the artist or playlist views (which carry the same slug
// attributes) never match.
function highlightGenreRow(song: Song): void {
  const row = $("c3").querySelector(
    `.row[data-song-id^="genre-song-"]`
    + `[data-artist-slug="${CSS.escape(song.artist_slug || "")}"]`
    + `[data-song-slug="${CSS.escape(song.slug)}"]`
  ) as HTMLElement | null
  if (row) {
    highlight(row)
    row.scrollIntoView({ block: "nearest" })
  }
}

// Play the song at `index` in the current search queue (store.searchQueue) and
// tag it with searchIndex so prev/next keep walking the search results. The
// caller sets store.searchQueue before the first play; prev/next reuse it.
// Returns the played song (or null if the index is out of range) so callers
// can sync the search view.
function playSearchSong(index: number): Song | null {
  const queue = store.searchQueue
  if (!queue || index < 0 || index >= queue.length) return null
  const song = queue[index]
  playSong(song, song.artist_slug || "", false)
  if (store.currentlyPlaying) {
    store.currentlyPlaying.searchIndex = index
  }
  return song
}

interface ScanStatus {
  scanning: boolean
  track_count: number
  processed: number
  total: number
}

// Whether the previous poll observed a scan in progress, so we can detect the
// transition to "finished" and re-render the catalog exactly once.
let scanWasActive = false
// Active polling timer handle, so overlapping starts don't stack loops.
let scanPollTimer: number | null = null

// Human-readable progress string shared by the global banner and the settings
// modal label. total is 0 until the server finishes collecting paths, so fall
// back to an indeterminate message until a percentage is known.
function scanProgressText(status: ScanStatus): string {
  if (status.total > 0) {
    const pct = Math.min(
      100, Math.round((status.processed / status.total) * 100)
    )
    return `Scanning ${status.processed} / ${status.total} files (${pct}%)`
  }
  return "Scanning library…"
}

// Reflect an in-progress scan in both the always-visible nav banner and the
// settings-modal progress bar. Called on every poll while scanning.
function renderScanUI(status: ScanStatus): void {
  const wrapper = document.getElementById("wrapper")
  const bannerLabel = document.getElementById("scanBannerLabel")
  const progress = document.getElementById("scanProgress")
  const bar = document.getElementById("scanProgressBar")
  const label = document.getElementById("scanProgressLabel")
  const button = document.getElementById("reload") as HTMLButtonElement | null

  const text = scanProgressText(status)

  if (wrapper) wrapper.classList.add("scanning")
  if (bannerLabel) bannerLabel.textContent = text

  if (progress) progress.style.display = "block"
  if (status.total > 0) {
    const pct = Math.min(
      100, Math.round((status.processed / status.total) * 100)
    )
    if (bar) {
      bar.classList.remove("indeterminate")
      bar.style.width = pct + "%"
    }
  } else if (bar) {
    bar.classList.add("indeterminate")
  }
  if (label) label.textContent = text
  if (button) {
    button.classList.add("spinning")
    button.disabled = true
  }
}

// Tear down the scan UI once a scan finishes: hide the banner, complete the
// bar, then re-render the current view against the refreshed catalog. The
// currently playing audio is left untouched.
function finishScanUI(): void {
  const wrapper = document.getElementById("wrapper")
  const progress = document.getElementById("scanProgress")
  const bar = document.getElementById("scanProgressBar")
  const label = document.getElementById("scanProgressLabel")
  const button = document.getElementById("reload") as HTMLButtonElement | null

  if (wrapper) wrapper.classList.remove("scanning")
  if (button) {
    button.classList.remove("spinning")
    button.disabled = false
  }
  if (bar) {
    bar.classList.remove("indeterminate")
    bar.style.width = "100%"
  }
  if (label) label.textContent = "Scan complete"
  // The catalog changed, so any cached search data is stale.
  invalidateSearchCatalog()
  // Leave the completed bar visible briefly, then hide it and re-render the
  // current view against the refreshed catalog.
  window.setTimeout(() => {
    if (progress) progress.style.display = "none"
    if (label) label.textContent = ""
    const path = location.pathname.slice(
      baseURL.length + 1, location.pathname.length
    )
    route(path)
  }, 600)
}

// Poll /scan-status and schedule the next poll. A scan can be started by this
// client (the rescan button), by the server on startup, or by a LaunchAgent
// restart, so we poll continuously: quickly while a scan runs (to animate the
// bar), slowly when idle (to notice a scan that began elsewhere). Started once
// from framework() and self-perpetuating thereafter.
function pollScanStatus(): void {
  if (scanPollTimer !== null) {
    window.clearTimeout(scanPollTimer)
    scanPollTimer = null
  }
  ajax<ScanStatus>("/scan-status", (status) => {
    if (status.scanning) {
      renderScanUI(status)
      scanWasActive = true
      scanPollTimer = window.setTimeout(pollScanStatus, 500)
    } else {
      if (scanWasActive) {
        scanWasActive = false
        finishScanUI()
      }
      scanPollTimer = window.setTimeout(pollScanStatus, 10000)
    }
  })
}

// Trigger a rescan from the settings modal. The server scans in the background
// and the POST returns immediately, so we hand off to the shared poller to
// drive the banner / progress bar and re-render once the scan completes.
function reloadCatalog(): void {
  const button = document.getElementById("reload") as HTMLButtonElement | null
  const progress = document.getElementById("scanProgress")
  const bar = document.getElementById("scanProgressBar")
  const label = document.getElementById("scanProgressLabel")

  if (button) {
    button.classList.add("spinning")
    button.disabled = true
  }
  if (progress) progress.style.display = "block"
  if (bar) bar.style.width = "0%"
  if (label) label.textContent = "Starting scan…"

  ajaxMutate<{ track_count: number }>(
    "POST",
    "/reload",
    null,
    () => {
      // Mark active up front so the first poll re-renders on completion even
      // if the scan finishes between this POST and the next status check.
      scanWasActive = true
      pollScanStatus()
    },
    (status) => {
      if (button) {
        button.classList.remove("spinning")
        button.disabled = false
      }
      if (progress) progress.style.display = "none"
      throw new Error(`Reload failed: ${status}`)
    }
  )
}

// Download all playlists as a JSON backup. The server returns the same shape
// as the legacy `playlists.json`, so the file round-trips back through import.
// Filename scheme: `2026-07-11t1017_tunediver_playlists.json` (local time).
function exportPlaylists(): void {
  const button =
    document.getElementById("exportPlaylists") as HTMLButtonElement | null
  if (button) button.disabled = true

  const reenable = (): void => {
    if (button) button.disabled = false
  }

  const now = new Date()
  const pad = (n: number): string => (n < 10 ? "0" + n : String(n))
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `t${pad(now.getHours())}${pad(now.getMinutes())}`

  fetch(baseURL + "/api/playlists/export")
    .then((response) => {
      if (!response.ok) throw new Error(`Export failed: ${response.status}`)
      return response.blob()
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = `${stamp}_tunediver_playlists.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      reenable()
    })
    .catch((error) => {
      console.error(error)
      window.alert("Could not export playlists.")
      reenable()
    })
}

// Prompt for a name, POST, then refresh the list and open the new playlist.
function createPlaylistFlow(): void {
  const name = prompt("Playlist name")
  if (name === null) return
  const trimmed = name.trim()
  if (!trimmed) return
  ajaxMutate<Playlist>(
    "POST",
    "/playlists",
    { name: trimmed },
    (created) => {
      invalidateSearchCatalog()
      printObj.playlists()
      if (created) printObj.playlist(created.id)
    }
  )
}

function renamePlaylistFlow(id: string, current: string): void {
  const name = prompt("Rename playlist", current)
  if (name === null) return
  const trimmed = name.trim()
  if (!trimmed || trimmed === current) return
  ajaxMutate<Playlist>(
    "PATCH",
    `/playlists/${id}`,
    { name: trimmed },
    () => {
      invalidateSearchCatalog()
      printObj.playlist(id)
      // If the list is visible in c2, refresh its labels.
      if (store.currentTab === "playlists") {
        const c2Playlists = $("c2").querySelectorAll(`.row[data-playlist-id]`)
        c2Playlists.forEach((r) => {
          const el = r as HTMLElement
          if (el.getAttribute("data-playlist-id") === id) {
            const a = el.querySelector("a")
            if (a) a.textContent = trimmed
            el.setAttribute("title", trimmed)
          }
        })
      }
    }
  )
}

function deletePlaylistFlow(id: string, name: string): void {
  if (!confirm(`Delete playlist "${name}"?`)) return
  ajaxMutate<void>(
    "DELETE",
    `/playlists/${id}`,
    null,
    () => {
      invalidateSearchCatalog()
      if (store.currentlyPlaying && store.currentlyPlaying.playlistId === id) {
        store.currentlyPlaying.playlistId = undefined
        store.currentlyPlaying.playlistIndex = undefined
      }
      store.currentPlaylistId = null
      printObj.playlists()
      history.pushState(
        { "url": "playlists" }, "Playlists", baseURL + "/playlists"
      )
    }
  )
}

// Open a bubble popover anchored to `anchor` (typically the song detail's
// Add button) listing every playlist and a "+ New playlist…" entry.
// Clicking an entry adds the song; clicking the entry for a new playlist
// creates one and then adds the song to it.
function showAddToPlaylistBubble(song: Song, anchor: HTMLElement): void {
  const bubble = $("addToPlaylistBubble")

  // Close any other open bubbles since we stopped propagation on the click
  // that opened this one (so the wrapper-level click handler didn't fire).
  const bubbles = document.getElementsByClassName("bubble")
  for (let i = 0; i < bubbles.length; i++) {
    const el = bubbles[i] as HTMLElement
    if (el.id !== "addToPlaylistBubble") el.style.display = "none"
  }

  bubble.innerHTML = ""

  // Use fixed positioning so the bubble lands predictably right under the
  // anchor regardless of the wrapper's offset-parent quirks.
  const rect = anchor.getBoundingClientRect()
  bubble.style.position = "fixed"
  bubble.style.left = rect.left + "px"
  bubble.style.top = (rect.bottom + 8) + "px"
  bubble.style.width = "200px"
  bubble.style.maxHeight = "240px"
  bubble.style.overflowY = "auto"
  bubble.style.padding = "6px 0"

  // Query with artist+title so the response marks playlists that already
  // contain this song — those rows are rendered non-clickable.
  const artistParam = encodeURIComponent(song.track_artist || "")
  const titleParam = encodeURIComponent(song.title || "")
  const listUrl = `/playlists?artist=${artistParam}&title=${titleParam}`

  ajax<PlaylistSummary[]>(listUrl, (playlists) => {
    const newRow = shaven(
      ["div#.row.newPlaylist", ["a", "+ New playlist…"]]
    ).rootElement
    newRow.addEventListener("click", (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      const name = prompt("Playlist name")
      if (name === null) return
      const trimmed = name.trim()
      if (!trimmed) return
      ajaxMutate<Playlist>(
        "POST",
        "/playlists",
        { name: trimmed },
        (created) => {
          if (created) addSongToPlaylist(created.id, song, anchor)
        }
      )
    })
    bubble.appendChild(newRow)

    playlists
      .slice()
      .sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
      )
      .forEach((pl) => {
        const alreadyAdded = pl.contains_song === true
        const row = shaven(
          ["div#.row", { "data-playlist-id": pl.id },
            ["a", pl.name]
          ]
        ).rootElement
        if (alreadyAdded) {
          row.classList.add("alreadyAdded")
          row.setAttribute("title", `Already in "${pl.name}"`)
        } else {
          row.addEventListener("click", (e: Event) => {
            e.preventDefault()
            e.stopPropagation()
            addSongToPlaylist(pl.id, song, anchor)
          })
        }
        bubble.appendChild(row)
      })

    bubble.style.display = "block"
  })
}

function addSongToPlaylist(
  playlistId: string,
  song: Song,
  anchor: HTMLElement,
): void {
  const artist = song.track_artist || ""
  const title = song.title || ""
  if (!artist || !title) return

  const flashAnchor = (text: string): void => {
    $("addToPlaylistBubble").style.display = "none"
    const original = anchor.textContent || "Add"
    anchor.textContent = text
    window.setTimeout(() => {
      anchor.textContent = original
    }, 1500)
  }

  ajaxMutate<Playlist>(
    "POST",
    `/playlists/${playlistId}/tracks`,
    { artist, title },
    () => {
      invalidateSearchCatalog()
      flashAnchor("Added!")
    },
    (status) => {
      // 409: the song is already in the playlist. The bubble normally
      // disables those rows up front, but a stale list (another tab/window
      // added the song since the bubble opened) can land us here.
      if (status === 409) {
        flashAnchor("Already added")
        return
      }
      throw new Error(`Add to playlist failed: ${status}`)
    }
  )
}

function removePlaylistTrack(playlistId: string, index: number): void {
  ajaxMutate<Playlist>(
    "DELETE",
    `/playlists/${playlistId}/tracks/${index}`,
    null,
    () => {
      invalidateSearchCatalog()
      // The played track's index might shift; re-render and update markers.
      if (
        store.currentlyPlaying &&
        store.currentlyPlaying.playlistId === playlistId &&
        store.currentlyPlaying.playlistIndex !== undefined
      ) {
        if (store.currentlyPlaying.playlistIndex === index) {
          store.currentlyPlaying.playlistId = undefined
          store.currentlyPlaying.playlistIndex = undefined
        } else if (store.currentlyPlaying.playlistIndex > index) {
          store.currentlyPlaying.playlistIndex -= 1
        }
      }
      printObj.playlist(playlistId)
    }
  )
}

function highlight(element: HTMLElement): void {
  const containerEl = element.parentElement
  if (!containerEl) return
  const rows = containerEl.getElementsByClassName("row")
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.remove("highlight")
  }
  element.classList.add("highlight")
}

// Move the highlight in c3 (preferred) or c2 by `direction` (+1 or -1) and
// trigger a click on the new row's link so the existing handlers run
// (loading songs / song details). Returns true if navigation happened.
function navigateList(direction: 1 | -1): boolean {
  let highlighted = $("c3").querySelector(".row.highlight") as HTMLElement | null
  if (!highlighted) {
    highlighted = $("c2").querySelector(".row.highlight") as HTMLElement | null
  }
  if (!highlighted) return false

  let sibling = (direction > 0
    ? highlighted.nextElementSibling
    : highlighted.previousElementSibling) as HTMLElement | null
  // Skip non-row siblings and rows hidden by search filtering
  while (sibling && (
    !sibling.classList.contains("row") || sibling.style.display === "none"
  )) {
    sibling = (direction > 0
      ? sibling.nextElementSibling
      : sibling.previousElementSibling) as HTMLElement | null
  }
  if (!sibling) return false

  const link = sibling.querySelector("a") as HTMLElement | null
  if (link) link.click()
  sibling.scrollIntoView({ block: "nearest" })
  return true
}

function ajax<T>(
  url: string,
  func: (data: T) => void
): void {
  // GET responses are expected to carry a `data` body, but ajaxRequest's
  // signature allows undefined (for 204 No Content). Narrow here.
  ajaxRequest<T>("GET", url, null, (data) => {
    if (data !== undefined) func(data)
  })
}

// Non-GET equivalent of `ajax`. Body is JSON-serialised. Success callback
// receives the response `data` (may be undefined for 204 responses, in
// which case `func` is still invoked with `undefined` so callers can react
// to the success without needing a body).
function ajaxMutate<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body: unknown,
  func: (data: T | undefined) => void,
  onError?: (status: number) => void
): void {
  ajaxRequest<T>(method, url, body, func, onError)
}

function ajaxRequest<T>(
  method: string,
  url: string,
  body: unknown,
  func: (data: T | undefined) => void,
  onError?: (status: number) => void
): void {
  const base = "/api"
  const x = new XMLHttpRequest()
  const path = base + url

  // Show loading spinner only if the request takes noticeable time,
  // to avoid a flash on fast responses
  const spinnerEl = $("spinner")
  const spinnerTimeout = window.setTimeout(() => {
    spinnerEl.style.display = "inline-block"
  }, 200)

  x.open(method, path, true)
  if (body !== null && body !== undefined) {
    x.setRequestHeader("Content-Type", "application/json")
  }

  x.onreadystatechange = function(): void {
    if (x.readyState !== 4) return
    window.clearTimeout(spinnerTimeout)
    spinnerEl.style.display = "none"

    // 2xx — success. 204 (No Content) has no body, so skip parsing.
    if (x.status >= 200 && x.status < 300) {
      if (x.status === 204 || !x.responseText) {
        func(undefined)
        return
      }
      let res: ApiResponse<T>
      try {
        res = JSON.parse(x.responseText)
      } catch (_e) {
        throw new Error(`Could not parse JSON response from ${path}`)
      }
      if (res.error) {
        alert(`This Error occurred: ${res.error}`)
        return
      }
      func(res.data as T | undefined)
      return
    }

    if (onError) {
      onError(x.status)
      return
    }
    throw new Error(
      `Http error ${x.status} occurred during an ${method} request to ${path}`
    )
  }

  x.send(body === null || body === undefined ? null : JSON.stringify(body))
}

// --- Song metadata formatting helpers ------------------------------------

// mm:ss, or h:mm:ss for hour-plus tracks, from a whole-second duration.
function formatDuration(totalSeconds: number): string {
  const s = Math.floor(totalSeconds % 60)
  const m = Math.floor((totalSeconds / 60) % 60)
  const h = Math.floor(totalSeconds / 3600)
  const ss = s < 10 ? "0" + s : String(s)
  if (h > 0) {
    const mm = m < 10 ? "0" + m : String(m)
    return `${h}:${mm}:${ss}`
  }
  return `${m}:${ss}`
}

// Human-readable byte size, e.g. "8.2 MB".
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`
}

// Sample rate in kHz, dropping a redundant ".0" (44100 → "44.1 kHz",
// 48000 → "48 kHz").
function formatSampleRate(hz: number): string {
  const khz = hz / 1000
  const text = Number.isInteger(khz) ? String(khz) : khz.toFixed(1)
  return `${text} kHz`
}

// Channel count as a listener-facing label.
function formatChannels(channels: number): string {
  if (channels === 1) return "Mono"
  if (channels === 2) return "Stereo"
  return `${channels} channels`
}

// Build the shaven node for the technical-metadata definition list. Each field
// is included only when the server supplied it, so unknown values are omitted
// rather than shown blank. Returns a `<dl>` node (possibly empty, which the
// `:empty` CSS rule hides).
function songMetaNode(song: Song): any[] {
  const rows: [string, string][] = []
  if (song.duration_secs != null) {
    rows.push(["Length", formatDuration(song.duration_secs)])
  }
  if (song.format) {
    rows.push(["Format", song.format])
  }
  if (song.bitrate_kbps != null) {
    rows.push(["Bitrate", `${song.bitrate_kbps} kbps`])
  }
  if (song.sample_rate_hz != null) {
    rows.push(["Sample rate", formatSampleRate(song.sample_rate_hz)])
  }
  if (song.bit_depth != null) {
    rows.push(["Bit depth", `${song.bit_depth}-bit`])
  }
  if (song.channels != null) {
    rows.push(["Channels", formatChannels(song.channels)])
  }
  if (song.file_size != null) {
    rows.push(["File size", formatFileSize(song.file_size)])
  }

  const node: any[] = ["dl#songMeta"]
  for (const [label, value] of rows) {
    node.push(["dt", label], ["dd", value])
  }
  return node
}

// A single line of time-synced ("LRC") lyrics: its start time in seconds and
// the text with all timestamp tags stripped.
interface SyncedLyricLine {
  time: number
  text: string
}

// Parse LRC-style time-synced lyrics (lines beginning with `[mm:ss.xx]`).
// Returns null when the text carries no timestamp tags at all, i.e. it's
// plain, unsynced lyrics that should be shown verbatim. A line may carry more
// than one leading timestamp (e.g. a repeated chorus); each becomes its own
// entry. Lines without a leading timestamp (blank lines, `[ar:…]`/`[ti:…]`
// metadata headers) are dropped. The result is sorted by time.
function parseSyncedLyrics(raw: string): SyncedLyricLine[] | null {
  const tagRe = /\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]/g
  const lines: SyncedLyricLine[] = []
  let sawTag = false

  for (const rawLine of raw.split(/\r?\n/)) {
    tagRe.lastIndex = 0
    const times: number[] = []
    let match: RegExpExecArray | null
    let lastEnd = 0

    // Collect only consecutive leading timestamp tags; stop at the first
    // non-tag (ignoring whitespace between tags) so tags embedded mid-line
    // aren't treated as line starts.
    while ((match = tagRe.exec(rawLine)) !== null) {
      if (rawLine.slice(lastEnd, match.index).trim() !== "") break
      const mins = parseInt(match[1], 10)
      const secs = parseFloat(match[2].replace(":", "."))
      times.push(mins * 60 + secs)
      lastEnd = tagRe.lastIndex
    }

    if (times.length === 0) continue
    sawTag = true
    const text = rawLine.slice(lastEnd).trim()
    for (const time of times) {
      lines.push({ time, text })
    }
  }

  if (!sawTag) return null
  lines.sort((a, b) => a.time - b.time)
  return lines
}

// Build the shaven node for a song's lyrics. Plain lyrics render as a single
// `<pre>` as before. Time-synced lyrics render as a `<div id="lyrics">` of
// per-line `<div class="lyricLine">` elements (timestamps stripped, start
// time kept in `data-time`); `updateSyncedLyrics` in player.ts highlights the
// active line as playback progresses. The artist/song slugs are stamped on
// the container so highlighting only runs when the detail view matches the
// track that's actually playing.
function lyricsNode(song: Song, artistSlug: string): any[] {
  const raw = song.lyrics || ""
  const synced = parseSyncedLyrics(raw)
  if (!synced) {
    return ["pre#lyrics", raw]
  }

  const node: any[] = ["div#lyrics.synced", {
    "data-artist-slug": artistSlug,
    "data-song-slug": song.slug,
  }]
  synced.forEach((line, i) => {
    node.push(["div.lyricLine", {
      "data-time": String(line.time),
      "data-index": String(i),
    }, line.text || " "])
  })
  return node
}

// Build the song-detail artist credit as one link per credited artist,
// separated by ", ". Each link routes to that artist's page. Falls back to a
// single link built from the URL's artist slug when the server didn't supply
// the per-artist list (e.g. an older response or the not-found placeholder).
function trackArtistNode(song: Song, fallbackSlug: string): any[] {
  const node: any[] = ["p#trackArtist"]
  const hasList = !!(song.track_artists && song.track_artists.length)
  const names = hasList
    ? (song.track_artists as string[])
    : [song.track_artist || ""]
  names.forEach((name, i) => {
    const slug = hasList ? encodeURIComponent(name) : fallbackSlug
    // Separators must be wrapped in an element: shaven treats a bare string
    // child as "set text content", wiping the links already appended before
    // it, so a plain ", " would leave only the last artist visible.
    if (i > 0) node.push(["span.artistSep", ", "])
    node.push(["a.trackArtistLink", {
      "href": baseURL + "/" + artistPath(slug),
      "data-artist-slug": slug,
    }, name])
  })
  return node
}

// Print namespace/object with rendering functions
const printObj = {
  artists(): void {
    store.currentTab = "artists"
    setActiveTab("artists")
    $("wrapper").classList.remove("searchActive")
    $("wrapper").classList.remove("songsActive")
    $("wrapper").classList.remove("playlistActive")
    $("c2").style.display = "inline-block"
    // Restore c3 in case the "Songs" tab had hidden it, and clear it: the
    // Artists tab lands with an empty song column (it fills only when an
    // artist is selected), so drop any tracks left over from a previous
    // playlist/artist view along with the playlist-only gutter class.
    $("c3").style.display = ""
    $("c3").innerHTML = ""
    $("c3").classList.remove("hasAddedDates")
    $("c4").innerHTML = ""

    ajax<Artist[]>("/artists", (artists) => {
      $("c2").innerHTML = ""

      artists
        .sort((artistA, artistB) => {
          const nameA = artistA.name.toLowerCase()
          const nameB = artistB.name.toLowerCase()
          if (nameA < nameB) return -1
          if (nameA > nameB) return 1
          return 0
        })
        .forEach((artist) => {
        const link = shaven(["a", artist.name]).rootElement

        link.addEventListener("click", (e: Event) => {
          e.preventDefault()
          const parentElement = link.parentNode as HTMLElement
          if (parentElement) {
            highlight(parentElement)
          }

          printObj.songs(artist.slug)
          printObj.artist(artist.slug)

          const url = artistPath(artist.slug)
          history.pushState({"url": url}, artist.slug, baseURL + "/" + url)
        })

        link.addEventListener("dblclick", (e: Event) => {
          e.preventDefault()
          e.stopPropagation()
          playFirstArtistSong(artist.slug)
        })

        const container = shaven(
          ["div#.row", {
            "title": artist.name,
            "data-artist-slug": artist.slug},
            [link],
            ["button", ""]
          ]
        ).rootElement

        $("c2").appendChild(container)
      })

      updatePlayingMarkers()
    })
  },

  artist(slug: string): void {
    // Portrait
    ajax<Artist>(`/artists/${slug}`, (artist) => {
      $("c4").innerHTML = ""

      shaven(
        [$("c4"),
          ["div#artist",
            ["img", {
              src: baseURL + "/img/cover-placeholder.svg",
              alt: "Image of " + artist.name}
            ],
            ["nav#artistNav",
              ["h2#heading", artist.name],
              ...(artist.country ? [["p#country", artist.country]] : []),
              // Best-effort guess of the artist's Wikipedia article URL from
              // the name (spaces → underscores). Not guaranteed to resolve.
              ["p#wikipedia",
                ["a", {
                  href: "https://en.wikipedia.org/wiki/" +
                    encodeURIComponent(artist.name.replace(/ /g, "_")),
                  target: "_blank",
                  rel: "noopener"},
                  "Wikipedia"
                ]
              ]
            ],
            ["div#bio", artist.bio || ""]
          ]
        ]
      )
    })
  },

  songs(artistSlug: string): void {
    ajax<Song[]>(`/artists/${artistSlug}/songs`, (songs) => {
      // Clear the container first
      $("c3").innerHTML = ""
      // Restore c3 in case the "Songs" tab had hidden it, and drop the
      // widened-c2 layout since c3 is now showing the artist's tracks.
      $("c3").style.display = ""
      $("wrapper").classList.remove("songsActive")
      $("wrapper").classList.remove("playlistActive")

      // Render each song
      songs.forEach((song, index) => {
        // Create a unique ID for each song that we can use to look it up later
        const songId = `song-${artistSlug}-${index}-${song.id || 0}`

        // Store the song in our registry with the ID as the key
        songRegistry[songId] = {
          song: song,
          artist: artistSlug
        }

        const link = shaven(["a", song.title]).rootElement
        const play = shaven(["button#.play"]).rootElement
        const add = shaven(["button#.add"]).rootElement

        // Create the song element with the data-id attribute
        shaven(
          [$("c3"),
            ["div#.row", {
              "data-song-id": songId,
              "data-artist-slug": artistSlug,
              "data-song-slug": song.slug,
            },
              [play],
              [link]
            ]
          ]
        )
      })

      updatePlayingMarkers()

      // Use event delegation on the container instead of individual handlers.
      // Property-assigned so every render replaces the previous handler
      // instead of stacking another one on the container.
      const container = $("c3")

      // Handle double-clicks on song divs
      container.ondblclick = (e) => {
        let target = e.target as HTMLElement
        const songDiv = target.closest(".row") as HTMLElement

        if (songDiv) {
          e.preventDefault()
          e.stopPropagation()

          const songId = songDiv.getAttribute("data-song-id")
          if (songId && songRegistry[songId]) {
            const { song, artist } = songRegistry[songId]
            playSong(song, artist, false)
          }
          return false
        }
      }

      // Handle clicks on play buttons
      container.onclick = (e) => {
        let target = e.target as HTMLElement
        if (target.classList.contains("play")) {
          e.preventDefault()
          e.stopPropagation()

          // Find the parent song div
          const songDiv = target.closest(".row") as HTMLElement
          if (songDiv) {
            // Get the song ID from the data attribute
            const songId = songDiv.getAttribute("data-song-id")
            if (songId && songRegistry[songId]) {
              const { song, artist } = songRegistry[songId]
              console.log("Play button clicked for:", song.title)
              playSong(song, artist, false)
            }
          }
          return false
        }

        // Handle clicks on song links
        if (target.tagName.toLowerCase() === "a" && target.closest(".row")) {
          e.preventDefault()

          // Find the parent song div
          const songDiv = target.closest(".row") as HTMLElement
          if (songDiv) {
            highlight(songDiv)
            // Get the song ID from the data attribute
            const songId = songDiv.getAttribute("data-song-id")
            if (songId && songRegistry[songId]) {
              const { song, artist } = songRegistry[songId]
              printObj.song(song.slug, artist)

              // Save in history object
              const url = songPath(artist, song.slug)
              history.pushState({"url": url}, song.slug, baseURL + "/" + url)
            }
          }
          return false
        }
      }
    })
  },

  song(songSlug: string, artistSlug: string): void {
    ajax<Song>(`/artists/${artistSlug}/songs/${songSlug}`, (songData) => {
      $("c4").innerHTML = ""

      // Store the song in our registry
      const detailSongId = `song-detail-${artistSlug}-${songSlug}`


      // Store song data in registry
      songRegistry[detailSongId] = {
        song: songData,
        artist: artistSlug
      }

      // Create song detail view with data-id attribute
      const coverUrl = baseURL + "/api/artists/" + artistSlug
        + "/songs/" + songData.slug + "/cover"
      const songDetailDiv = shaven(
        [$("c4"),
          ["div#song", {"data-song-id": detailSongId},
            ["button#playSong", "Play"],
            ["button#addSong", "Add"],
            ["button#shareSong", "Share"],
            ["button#copyFilepath", {title: songData.file_path || ""}, "Copy Filepath"],
            ["img#songCover", {
              "src": coverUrl,
              "alt": "Image of " + (songData.track_artist || ""),
            }],
            ["nav#songNav",
              trackArtistNode(songData, artistSlug),
              ["h2#heading", songData.title],
              ["p#dateAdded",
                songData.date_added
                  ? "Added " + songData.date_added
                  : "",
              ],
              songMetaNode(songData),
            ],
            lyricsNode(songData, artistSlug),
          ]
        ]
      ).rootElement

      // Fall back to placeholder if no embedded cover art
      const coverImg = document.getElementById("songCover") as HTMLImageElement
      if (coverImg) {
        coverImg.onerror = () => {
          coverImg.onerror = null
          coverImg.src = baseURL + "/img/cover-placeholder.svg"
        }
      }

      // Use event delegation for detail view too. Use onclick (property
      // assignment) so repeat visits replace the prior handler — otherwise
      // each Add click would call showAddToPlaylistBubble N times and
      // duplicate entries in the popover.
      const container = $("c4")

      container.onclick = (e: MouseEvent) => {
        let target = e.target as HTMLElement

        // Each artist name links to that artist's page; route in-app rather
        // than following the anchor's href so it stays a single-page
        // navigation. The clicked link carries its own slug so a multi-artist
        // credit routes to whichever name was clicked.
        if (target.classList.contains("trackArtistLink")) {
          e.preventDefault()
          e.stopPropagation()
          const slug = target.getAttribute("data-artist-slug") || artistSlug
          const url = artistPath(slug)
          history.pushState({ "url": url }, slug, baseURL + "/" + url)
          route(url)
          return false
        }

        if (target.id === "playSong") {
          e.preventDefault()
          e.stopPropagation()

          const songDiv = document.getElementById("song")
          if (songDiv) {
            const songId = songDiv.getAttribute("data-song-id")
            if (songId && songRegistry[songId]) {
              const { song, artist } = songRegistry[songId]
              console.log("Detail play button clicked:", song.title)
              playSong(song, artist, false)
            }
          }
          return false
        }

        if (target.id === "addSong") {
          e.stopPropagation()
          const songDiv = document.getElementById("song")
          if (songDiv) {
            const songId = songDiv.getAttribute("data-song-id")
            if (songId && songRegistry[songId]) {
              showAddToPlaylistBubble(
                songRegistry[songId].song,
                target,
              )
            }
          }
        }

        if (target.id === "copyFilepath") {
          const songDiv = document.getElementById("song")
          if (songDiv) {
            const songId = songDiv.getAttribute("data-song-id")
            if (songId && songRegistry[songId]) {
              const filePath = songRegistry[songId].song.file_path
              if (filePath) {
                navigator.clipboard.writeText(filePath)
                target.textContent = "Copied!"
                setTimeout(() => {
                  target.textContent = "Copy Filepath"
                }, 2000)
              }
            }
          }
        }
      }
    })
  },

  startpage(): void {
    shaven(
      [$("c4"),
        ["h2", "Welcome to Tunediver"]
      ]
    )
  },

  // Flat, alphabetical list of every song in the catalog, rendered into
  // c2. c3 is hidden because this view has no "second column" — clicking
  // a song jumps straight to its detail in c4, double-clicking plays it.
  allSongs(): void {
    store.currentTab = "songs"
    setActiveTab("songs")
    $("wrapper").classList.remove("searchActive")
    $("wrapper").classList.remove("playlistActive")
    // Give the flat song list an equal share of the width (like search
    // results): the rows now carry longer "Artist — Title" labels and c3 is
    // hidden here, so let c2 spread into the space c3 would occupy.
    $("wrapper").classList.add("songsActive")
    $("c2").innerHTML = ""
    $("c3").innerHTML = ""
    $("c4").innerHTML = ""
    $("c2").style.display = "inline-block"
    $("c3").style.display = "none"

    ajax<Song[]>("/songs", (songs) => {
      songs.forEach((song, index) => {
        const artistSlug = song.artist_slug || ""
        const songId = `allsong-${index}-${song.id || 0}`

        songRegistry[songId] = {
          song: song,
          artist: artistSlug,
        }

        const link = shaven(
          ["a", songLabel(song.track_artist, song.title)]
        ).rootElement
        const play = shaven(["button#.play"]).rootElement

        shaven(
          [$("c2"),
            ["div#.row", {
              "title": (song.track_artist || "") + " \u2014 " + song.title,
              "data-song-id": songId,
              "data-artist-slug": artistSlug,
              "data-song-slug": song.slug,
            },
              [play],
              [link],
            ],
          ]
        )
      })

      updatePlayingMarkers()

      // Property-assigned so every render replaces the previous handler
      // instead of stacking another one on the container (the search view
      // assigns its own delegated handlers to c2 the same way).
      const container = $("c2")

      container.ondblclick = (e) => {
        const target = e.target as HTMLElement
        const songDiv = target.closest(".row") as HTMLElement | null
        if (!songDiv || !songDiv.hasAttribute("data-song-id")) return
        e.preventDefault()
        e.stopPropagation()
        const songId = songDiv.getAttribute("data-song-id")
        if (songId && songRegistry[songId]) {
          const { song, artist } = songRegistry[songId]
          playSong(song, artist, false)
        }
      }

      container.onclick = (e) => {
        const target = e.target as HTMLElement

        if (target.classList.contains("play")) {
          const songDiv = target.closest(".row") as HTMLElement | null
          if (!songDiv || !songDiv.hasAttribute("data-song-id")) return
          e.preventDefault()
          e.stopPropagation()
          const songId = songDiv.getAttribute("data-song-id")
          if (songId && songRegistry[songId]) {
            const { song, artist } = songRegistry[songId]
            playSong(song, artist, false)
          }
          return
        }

        if (target.tagName.toLowerCase() === "a") {
          const songDiv = target.closest(".row") as HTMLElement | null
          if (!songDiv || !songDiv.hasAttribute("data-song-id")) return
          e.preventDefault()
          highlight(songDiv)
          const songId = songDiv.getAttribute("data-song-id")
          if (songId && songRegistry[songId]) {
            const { song, artist } = songRegistry[songId]
            printObj.song(song.slug, artist)
            const url = songPath(artist, song.slug)
            history.pushState({"url": url}, song.slug, baseURL + "/" + url)
          }
        }
      }
    })
  },

  // List view in c2: all playlists, with a "+ New playlist" row at the top
  // that prompts for a name and creates the playlist via POST.
  playlists(): void {
    store.currentTab = "playlists"
    store.currentPlaylistId = null
    setActiveTab("playlists")
    $("wrapper").classList.remove("searchActive")
    $("wrapper").classList.remove("songsActive")
    // The list view has no open playlist yet; printObj.playlist re-adds this
    // when one is selected.
    $("wrapper").classList.remove("playlistActive")
    $("c2").innerHTML = ""
    $("c3").innerHTML = ""
    $("c4").innerHTML = ""
    $("c2").style.display = "inline-block"
    $("c3").style.display = ""

    // Build standalone and appendChild — shaven's parent-syntax returns the
    // parent as rootElement, so attaching the handler to that would bind it
    // to c2 itself and fire on every click that bubbles through it.
    const newRow = shaven(
      ["div#.row.newPlaylist",
        ["a", "+ New playlist"]
      ]
    ).rootElement
    newRow.addEventListener("click", (e: Event) => {
      e.preventDefault()
      createPlaylistFlow()
    })
    $("c2").appendChild(newRow)

    ajax<PlaylistSummary[]>("/playlists", (playlists) => {
      playlists
        .slice()
        .sort((a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        )
        .forEach((playlist) => {
          const link = shaven(["a", playlist.name]).rootElement
          link.addEventListener("click", (e: Event) => {
            e.preventDefault()
            const parent = link.parentNode as HTMLElement | null
            if (parent) highlight(parent)
            printObj.playlist(playlist.id)
            history.pushState(
              { "url": "playlists/" + playlist.id },
              playlist.name,
              baseURL + "/playlists/" + playlist.id
            )
          })
          link.addEventListener("dblclick", (e: Event) => {
            e.preventDefault()
            e.stopPropagation()
            playFirstPlaylistTrack(playlist.id)
          })
          shaven(
            [$("c2"),
              ["div#.row", {
                "title": playlist.name,
                "data-playlist-id": playlist.id,
              },
                [link]
              ]
            ]
          )
        })

      updatePlayingMarkers()
    })
  },

  // Detail of a single playlist: tracks in c3, metadata/rename/delete in c4.
  playlist(id: string): void {
    ajax<Playlist>(`/playlists/${id}`, (playlist) => {
      store.currentPlaylistId = playlist.id
      $("c3").style.display = ""
      // Widen c3 so the tracks' "Artist — Title" rows aren't clipped by the
      // 300px cap. Skip it when opened from a search result: c2 is still
      // showing the results there and keeps the searchActive layout.
      if (!$("wrapper").classList.contains("searchActive")) {
        $("wrapper").classList.remove("songsActive")
        $("wrapper").classList.add("playlistActive")
      }

      // "2016-08-19T20:09:09Z" → "2016-08-19"; empty when unknown.
      const formatAdded = (iso?: string): string => (iso ? iso.slice(0, 10) : "")

      // Track entries paired with their original playlist index, reordered for
      // display per `playlistSort`. The index is preserved so the row's
      // data-playlist-index still maps back to `playlist.tracks`.
      const sortedEntries = (): { track: PlaylistTrack; index: number }[] => {
        const entries = playlist.tracks.map((track, index) => ({ track, index }))
        if (store.playlistSort === "index") return entries
        const dir = store.playlistSort === "added-asc" ? 1 : -1
        return entries.sort((a, b) => {
          const av = a.track.added_at || ""
          const bv = b.track.added_at || ""
          // Tracks with no timestamp always sink to the bottom; equal times
          // keep their stored order.
          if (!av && !bv) return a.index - b.index
          if (!av) return 1
          if (!bv) return -1
          if (av === bv) return a.index - b.index
          return av < bv ? -dir : dir
        })
      }

      const renderTracks = (): void => {
        $("c3").innerHTML = ""
        // Only reserve the wide right-hand gutter for the "Added At" column when
        // at least one track actually has a date; otherwise rows fall back to
        // the base padding (just enough for the hover remove button).
        $("c3").classList.toggle(
          "hasAddedDates",
          playlist.tracks.some((t) => Boolean(t.added_at))
        )
        sortedEntries().forEach(({ track, index }) => {
          const link = shaven(
            ["a", songLabel(track.track_artist, track.title)]
          ).rootElement
          const play = shaven(["button#.play"]).rootElement
          const remove = shaven(["button#.remove"]).rootElement
          const added = shaven(
            ["span#.added", { "title": track.added_at || "" },
              formatAdded(track.added_at)]
          ).rootElement

          const row = shaven(
            ["div#.row.playlistRow", {
              "title": (track.track_artist || "") + " — " + track.title,
              "data-playlist-index": String(index),
              "data-artist-slug": track.artist_slug,
              "data-song-slug": track.slug,
            },
              [play],
              [link],
              [added],
              [remove],
            ]
          ).rootElement

          if (!track.available) row.classList.add("unavailable")
          $("c3").appendChild(row)
        })
        updatePlayingMarkers()
      }

      renderTracks()

      $("c3").onclick = (e: MouseEvent) => {
        const target = e.target as HTMLElement
        const row = target.closest(".row") as HTMLElement | null
        if (!row) return
        const idxAttr = row.getAttribute("data-playlist-index")
        if (idxAttr === null) return
        const idx = parseInt(idxAttr, 10)
        const track = playlist.tracks[idx]
        if (!track) return

        if (target.classList.contains("play")) {
          e.preventDefault()
          e.stopPropagation()
          if (track.available) playPlaylistTrack(playlist.id, idx, track)
          return
        }
        if (target.classList.contains("remove")) {
          e.preventDefault()
          e.stopPropagation()
          removePlaylistTrack(playlist.id, idx)
          return
        }
        if (target.tagName.toLowerCase() === "a") {
          e.preventDefault()
          highlight(row)
          if (track.available) {
            printObj.song(track.slug, track.artist_slug)
            const url = `playlists/${playlist.id}/${idx}`
            history.pushState({ "url": url }, track.slug, baseURL + "/" + url)
          }
        }
      }

      $("c3").ondblclick = (e: MouseEvent) => {
        const target = e.target as HTMLElement
        const row = target.closest(".row") as HTMLElement | null
        if (!row) return
        const idxAttr = row.getAttribute("data-playlist-index")
        if (idxAttr === null) return
        const idx = parseInt(idxAttr, 10)
        const track = playlist.tracks[idx]
        if (!track || !track.available) return
        e.preventDefault()
        e.stopPropagation()
        playPlaylistTrack(playlist.id, idx, track)
      }

      // Detail view: name (with rename) + delete + track count.
      $("c4").innerHTML = ""
      shaven(
        [$("c4"),
          ["div#playlistDetail",
            ["button#renamePlaylist", "Rename"],
            ["button#deletePlaylist", "Delete"],
            ["nav#playlistNav",
              ["h2#heading", playlist.name],
              ["p#playlistCount",
                playlist.tracks.length === 1
                  ? "1 track"
                  : playlist.tracks.length + " tracks"
              ],
              ["div#playlistSort",
                ["span#sortLabel", "Sort:"],
                ["button#.sortBtn", { "data-sort": "index" }, "Order"],
                ["button#.sortBtn", { "data-sort": "added-asc" }, "Added ↑"],
                ["button#.sortBtn", { "data-sort": "added-desc" }, "Added ↓"],
              ],
            ],
          ]
        ]
      )

      // Reflect the active sort on the buttons and re-render the track list
      // when a different mode is chosen.
      const sortControls = $("c4").querySelectorAll(
        ".sortBtn"
      ) as NodeListOf<HTMLElement>
      const markActiveSort = (): void => {
        sortControls.forEach((btn) => {
          btn.classList.toggle(
            "active",
            btn.getAttribute("data-sort") === store.playlistSort
          )
        })
      }
      sortControls.forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.getAttribute("data-sort") as PlaylistSort | null
          if (!mode || mode === store.playlistSort) return
          store.playlistSort = mode
          markActiveSort()
          renderTracks()
        })
      })
      markActiveSort()

      const renameEl = document.getElementById("renamePlaylist")
      if (renameEl) {
        renameEl.addEventListener("click", () => {
          renamePlaylistFlow(playlist.id, playlist.name)
        })
      }
      const deleteEl = document.getElementById("deletePlaylist")
      if (deleteEl) {
        deleteEl.addEventListener("click", () => {
          deletePlaylistFlow(playlist.id, playlist.name)
        })
      }

      updatePlayingMarkers()
    })
  },

  // List view in c2: every genre found in the catalog's tags. Clicking a
  // genre lists its songs in c3; double-clicking plays the genre's first song.
  genres(): void {
    store.currentTab = "genres"
    setActiveTab("genres")
    $("wrapper").classList.remove("searchActive")
    $("wrapper").classList.remove("songsActive")
    // The list view has no open genre yet; printObj.genreSongs re-adds the
    // wide-c3 layout when one is selected.
    $("wrapper").classList.remove("playlistActive")
    $("c2").style.display = "inline-block"
    $("c3").style.display = ""
    $("c3").innerHTML = ""
    $("c3").classList.remove("hasAddedDates")
    $("c4").innerHTML = ""

    ajax<Genre[]>("/genres", (genres) => {
      $("c2").innerHTML = ""

      genres
        .sort((genreA, genreB) =>
          genreA.name.toLowerCase().localeCompare(genreB.name.toLowerCase())
        )
        .forEach((genre) => {
          const link = shaven(["a", genre.name]).rootElement

          link.addEventListener("click", (e: Event) => {
            e.preventDefault()
            const parentElement = link.parentNode as HTMLElement
            if (parentElement) highlight(parentElement)

            printObj.genreSongs(genre.slug)

            const url = "genres/" + genre.slug
            history.pushState({ "url": url }, genre.name, baseURL + "/" + url)
          })

          link.addEventListener("dblclick", (e: Event) => {
            e.preventDefault()
            e.stopPropagation()
            playFirstGenreSong(genre.slug)
          })

          const container = shaven(
            ["div#.row", {
              "title": genre.name,
              "data-genre-slug": genre.slug},
              [link]
            ]
          ).rootElement

          $("c2").appendChild(container)
        })

      updatePlayingMarkers()
    })
  },

  // Songs of a single genre in c3 (labelled "Artist — Title" since a genre
  // spans many artists), with the genre's name and track count in c4.
  genreSongs(genreSlug: string): void {
    ajax<Song[]>(`/genres/${genreSlug}/songs`, (songs) => {
      $("c3").innerHTML = ""
      $("c3").style.display = ""
      // Widen c3 past the 300px cap for the long "Artist — Title" rows,
      // exactly like an open playlist's track list.
      $("wrapper").classList.remove("songsActive")
      $("wrapper").classList.add("playlistActive")

      songs.forEach((song, index) => {
        const artistSlug = song.artist_slug || ""
        const songId = `genre-song-${genreSlug}-${index}-${song.id || 0}`

        songRegistry[songId] = {
          song: song,
          artist: artistSlug,
        }

        const link = shaven(
          ["a", songLabel(song.track_artist, song.title)]
        ).rootElement
        const play = shaven(["button#.play"]).rootElement

        shaven(
          [$("c3"),
            ["div#.row", {
              "title": (song.track_artist || "") + " — " + song.title,
              "data-song-id": songId,
              "data-artist-slug": artistSlug,
              "data-song-slug": song.slug,
            },
              [play],
              [link],
            ]
          ]
        )
      })

      updatePlayingMarkers()

      // Same delegated handlers as the artist tab's song list (printObj.songs),
      // but playback goes through playGenreSong so prev/next, shuffle, and
      // auto-advance stay inside this genre. Property-assigned so re-renders
      // replace rather than stack them.
      const container = $("c3")

      container.ondblclick = (e) => {
        const target = e.target as HTMLElement
        const songDiv = target.closest(".row") as HTMLElement | null
        if (!songDiv || !songDiv.hasAttribute("data-song-id")) return
        e.preventDefault()
        e.stopPropagation()
        const songId = songDiv.getAttribute("data-song-id")
        if (songId && songRegistry[songId]) {
          playGenreSong(genreSlug, songRegistry[songId].song)
        }
      }

      container.onclick = (e) => {
        const target = e.target as HTMLElement
        const songDiv = target.closest(".row") as HTMLElement | null
        if (!songDiv || !songDiv.hasAttribute("data-song-id")) return

        if (target.classList.contains("play")) {
          e.preventDefault()
          e.stopPropagation()
          const songId = songDiv.getAttribute("data-song-id")
          if (songId && songRegistry[songId]) {
            playGenreSong(genreSlug, songRegistry[songId].song)
          }
          return
        }

        if (target.tagName.toLowerCase() === "a") {
          e.preventDefault()
          highlight(songDiv)
          const songId = songDiv.getAttribute("data-song-id")
          if (songId && songRegistry[songId]) {
            const { song, artist } = songRegistry[songId]
            printObj.song(song.slug, artist)
            // A song has one canonical URL (under its artist), so the genre
            // view links there rather than minting a genre-scoped variant.
            const url = songPath(artist, song.slug)
            history.pushState({ "url": url }, song.slug, baseURL + "/" + url)
          }
        }
      }

      // Detail column: genre name + track count (replaced by the song detail
      // once a song is clicked, like the artist portrait is).
      $("c4").innerHTML = ""
      shaven(
        [$("c4"),
          ["div#genreDetail",
            ["nav#genreNav",
              ["h2#heading", decodeURIComponent(genreSlug)],
              ["p#genreCount",
                songs.length === 1 ? "1 track" : songs.length + " tracks"
              ],
            ],
          ]
        ]
      )
    })
  },
}

function viewController(): Record<string, Function> {
  return {
    framework(): void {
      function openSettings(): void {
        $("settingsModal").style.display = "flex"
      }

      function closeSettings(): void {
        $("settingsModal").style.display = "none"
      }

      shaven(
        [document.body,
          ["div#wrapper",
            ["nav#nav",
              ["h1#logo", "Tunediver",
                ["img#spinner", {
                  "src": "data:image/svg+xml,%3C?xml%20version=%221.0%22%20encoding=%22utf-8%22?%3E%3Csvg%20width=%2220%22%20height=%2220%22%20xmlns=%22http://www.w3.org/2000/svg%22%20xmlns:xlink=%22http://www.w3.org/1999/xlink%22%3E%3Cdefs%3E%3Crect%20id=%22l%22%20x=%222%22%20y=%22-1%22%20rx=%221%22%20ry=%221%22%20width=%228%22%20height=%222%22%20fill=%22%23fff%22%3E%3C/rect%3E%3C/defs%3E%3Cg%20transform=%22translate(10,%2010)%22%3E%3CanimateTransform%20attributeName=%22transform%22%20calcMode=%22discrete%22%20type=%22rotate%22%20values=%220;30;60;90;120;150;180;210;240;270;300;330;360%22%20additive=%22sum%22%20dur=%221000ms%22%20repeatDur=%22indefinite%22%3E%3C/animateTransform%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(0)%22%20opacity=%220%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(30)%22%20opacity=%220.08%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(60)%22%20opacity=%220.17%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(90)%22%20opacity=%220.25%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(120)%22%20opacity=%220.33%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(150)%22%20opacity=%220.42%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(180)%22%20opacity=%220.5%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(210)%22%20opacity=%220.58%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(240)%22%20opacity=%220.67%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(270)%22%20opacity=%220.75%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(300)%22%20opacity=%220.83%22%3E%3C/use%3E%3Cuse%20xlink:href=%22%23l%22%20transform=%22rotate(330)%22%20opacity=%220.92%22%3E%3C/use%3E%3C/g%3E%3C/svg%3E",
                  "style": "display:none"}
                ]
              ],
              ["div#controls"],
              ["button#settings", { "title": "Settings" }]
            ],
            ["div#scanBanner", { "role": "status", "aria-live": "polite" },
              ["span#scanBannerDot"],
              ["span#scanBannerLabel", "Scanning library…"]
            ],
            ["div#c1",
              ["input#search", {type: "search", placeholder: "search"}],
              ["button#artists", "Artists"],
              ["button#songs", "Songs"],
              ["button#playlists", "Playlists"],
              ["button#genres", "Genres"]
            ],
            ["div#c2"],
            ["div#c3"],
            ["div#c4"],
            ["div#Bubble.bubble", {style: "display:none"}],
            ["div#addToPlaylistBubble.bubble", {style: "display:none"}],
            ["div#settingsModal", {style: "display:none"},
              ["div#settingsDialog.modalDialog",
                ["div.modalHeader",
                  ["h2", "Settings"],
                  ["button#settingsClose",
                    { "title": "Close", "aria-label": "Close" }, "×"]
                ],
                ["div.modalBody",
                  ["section.settingsSection",
                    ["h3", "Music library"],
                    ["p.settingsHint",
                      "Rescan the music folder to pick up files added, " +
                      "removed, or retagged on disk."],
                    ["button#reload", { "title": "Rescan music folder" },
                      "Rescan library"],
                    ["div#scanProgress", { "style": "display:none" },
                      ["div#scanProgressBar"]
                    ],
                    ["p#scanProgressLabel"]
                  ],
                  ["section.settingsSection",
                    ["h3", "Playlists"],
                    ["p.settingsHint",
                      "Download all playlists as a JSON file you can keep " +
                      "as a backup or re-import later."],
                    ["button#exportPlaylists",
                      { "title": "Export playlists to a JSON file" },
                      "Export playlists"]
                  ]
                ]
              ]
            ]
          ]
        ]
      )

      const wrapperEl = $("wrapper")
      wrapperEl.addEventListener("click", () => {
        const bubbles = document.getElementsByClassName("bubble")

        for (let a = 0; a < bubbles.length; a++) {
          const element = bubbles[a] as HTMLElement
          element.style.display = "none"

          element.addEventListener("click", (e: Event) => {
            e.stopPropagation()
          })
        }
      })

      $("search").addEventListener("keyup", (e: Event) => {
        e.stopPropagation()
        handleSearchInput()
      })

      // Also handle clearing via the "x" button on type="search" inputs
      $("search").addEventListener("search", () => {
        handleSearchInput()
      })

      $("logo").addEventListener("click", () => {
        history.pushState({"url": ""}, "", baseURL + "/")
        route("")
      })

      $("artists").addEventListener("click", () => {
        clearSearch()
        printObj.artists()
        history.pushState(
          { "url": "artists" }, "Artists", baseURL + "/artists"
        )
      })

      $("songs").addEventListener("click", () => {
        clearSearch()
        printObj.allSongs()
        history.pushState({ "url": "songs" }, "Songs", baseURL + "/songs")
      })

      $("playlists").addEventListener("click", () => {
        clearSearch()
        printObj.playlists()
        history.pushState(
          { "url": "playlists" }, "Playlists", baseURL + "/playlists"
        )
      })

      $("genres").addEventListener("click", () => {
        clearSearch()
        printObj.genres()
        history.pushState(
          { "url": "genres" }, "Genres", baseURL + "/genres"
        )
      })

      $("reload").addEventListener("click", (e: Event) => {
        e.stopPropagation()
        reloadCatalog()
      })

      $("exportPlaylists").addEventListener("click", (e: Event) => {
        e.stopPropagation()
        exportPlaylists()
      })

      $("settings").addEventListener("click", (e: Event) => {
        openSettings()
        e.stopPropagation()
      })

      $("settingsClose").addEventListener("click", (e: Event) => {
        e.stopPropagation()
        closeSettings()
      })

      // Click on the dim backdrop (outside the dialog) closes the modal;
      // clicks inside the dialog must not bubble up to trigger that.
      $("settingsModal").addEventListener("click", () => closeSettings())
      $("settingsDialog").addEventListener("click", (e: Event) => {
        e.stopPropagation()
      })

      document.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape" &&
            $("settingsModal").style.display !== "none") {
          closeSettings()
        }
      })

      // Start watching for scans (one may already be running on startup, e.g.
      // after a LaunchAgent restart). Self-perpetuating from here on.
      pollScanStatus()
    },

    index(): void {
      this.framework()
      initPlayer()
      wireStoreEffects()
      printObj.startpage()
    },

    artist(dir: string): void {
      printObj.artists()
      printObj.songs(dir)
      printObj.artist(dir)
    },

    artists(): void {
      printObj.artists()
    },

    songs(): void {
      printObj.allSongs()
    },

    song(artistSlug: string, songSlug: string): void {
      printObj.artists()
      printObj.songs(artistSlug)
      printObj.song(songSlug, artistSlug)
    },

    playlists(): void {
      printObj.playlists()
    },

    genres(): void {
      printObj.genres()
    },

    genre(slug: string): void {
      printObj.genres()
      printObj.genreSongs(slug)
    },

    playlist(id: string): void {
      printObj.playlists()
      printObj.playlist(id)
    },

    playlistTrack(id: string, indexStr: string): void {
      printObj.playlists()
      printObj.playlist(id)
      // After the playlist renders, highlight + open the indexed track.
      // printObj.playlist completes inside an ajax callback, so defer.
      ajax<Playlist>(`/playlists/${id}`, (playlist) => {
        const idx = parseInt(indexStr, 10)
        const track = playlist.tracks[idx]
        if (!track || !track.available) return
        printObj.song(track.slug, track.artist_slug)
        const row = $("c3").querySelector(
          `.row[data-playlist-index="${idx}"]`
        ) as HTMLElement | null
        if (row) highlight(row)
      })
    },
  }
}

function route(state: string | { url?: string }): void {
  // Check if first call
  const logoEl = document.getElementById("logo")
  if (!logoEl) viewController().index()

  // History object or URL
  if (typeof(state) === "object") {
    if (state.url) {
      fromURL(state.url)
    }
    else {
      throw new Error(
        "History Object does not contain an URL: " + String(state.url)
      )
    }
  }
  else if (typeof(state) === "string") {
    fromURL(state)
  }
  else {
    throw new Error(
      "The variable passed to route() is not an object or a string: " + String(state)
    )
  }

  function fromURL(url: string): void {
    const dirs = url.split("/")
    const view = viewController()

    if (dirs[0] === "playlists") {
      if (dirs.length === 1) view.playlists()
      else if (dirs.length === 2) view.playlist(dirs[1])
      else if (dirs.length === 3) view.playlistTrack(dirs[1], dirs[2])
      else {
        alert("This website is not available")
        throw new Error("Can not route the URL " + url)
      }
      return
    }

    //   /genres         → genres tab
    //   /genres/<genre> → one genre's song list
    if (dirs[0] === "genres") {
      if (dirs.length === 1) view.genres()
      else if (dirs.length === 2) view.genre(dirs[1])
      else {
        alert("This website is not available")
        throw new Error("Can not route the URL " + url)
      }
      return
    }

    // Artist and song views live under /artists:
    //   /artists                       → artists tab
    //   /artists/<artist>              → one artist's page
    //   /artists/<artist>/songs/<song> → a song's detail view
    if (dirs[0] === "artists") {
      if (dirs.length === 1) view.artists()
      else if (dirs.length === 2) view.artist(dirs[1])
      else if (dirs.length === 4 && dirs[2] === "songs") view.song(dirs[1], dirs[3])
      else {
        alert("This website is not available")
        throw new Error("Can not route the URL " + url)
      }
      return
    }

    if (dirs.length === 1 && dirs[0] === "songs") { view.songs(); return }

    if (url === "") {
      printObj.artists()
      printObj.startpage()
    }
    else {
      alert("This website is not available")
      throw new Error("Can not route the URL " + url)
    }
  }
}

// Keyboard shortcuts
function setShortcuts(): void {
  window.addEventListener("keyup", (e: KeyboardEvent) => {
    switch (e.keyCode) {
      case 32: //spacebar
        e.preventDefault()
        if (audio.src) playpause()
        break
        case 37: //left
        break
        case 39: //right
        break
        case 76: //l
        setVolume(1)
        break
        case 77: //m
        mute()
        break
      }
  })

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    // Don't hijack arrows while typing in an input/textarea
    const active = document.activeElement
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      return
    }

    // Handle up/down/enter when a tab button in c1 is focused
    const tabButtons = Array.from(
      $("c1").querySelectorAll("button")
    ) as HTMLElement[]
    const focusedTab = tabButtons.find((b) => b === active)
    if (focusedTab) {
      const idx = tabButtons.indexOf(focusedTab)
      switch (e.keyCode) {
        case 38: // up
          e.preventDefault()
          if (idx > 0) tabButtons[idx - 1].focus()
          break
        case 40: // down
          e.preventDefault()
          if (idx < tabButtons.length - 1) tabButtons[idx + 1].focus()
          break
        case 13: // enter
          e.preventDefault()
          focusedTab.click()
          break
        case 39: // right — move into the list
          e.preventDefault()
          focusedTab.blur()
          {
            const firstRow = $("c2").querySelector(".row") as HTMLElement | null
            if (firstRow) {
              const link = firstRow.querySelector("a") as HTMLElement | null
              if (link) link.click()
              firstRow.scrollIntoView({ block: "nearest" })
            }
          }
          break
      }
      return
    }

    switch (e.keyCode) {
      case 37: //left
        {
          const songHighlight = $("c3").querySelector(".row.highlight")
          if (songHighlight) {
            songHighlight.classList.remove("highlight")
            const artistHighlight = $("c2").querySelector(".row.highlight")
            if (artistHighlight) {
              artistHighlight.scrollIntoView({ block: "nearest" })
            }
          } else {
            // From c2 (or no highlight): focus the active tab button
            const activeTab = $("c1").querySelector("button.active") as HTMLElement | null
            if (activeTab) activeTab.focus()
          }
        }
        break
        case 39: //right
        {
          const artistHighlight = $("c2").querySelector(".row.highlight")
          if (artistHighlight) {
            const firstSongRow = $("c3").querySelector(".row") as HTMLElement | null
            if (firstSongRow) {
              const link = firstSongRow.querySelector("a") as HTMLElement | null
              if (link) link.click()
              firstSongRow.scrollIntoView({ block: "nearest" })
            }
          }
        }
        break
        case 38: //up
        e.preventDefault()
        if (!navigateList(-1)) setVolume(0.05, true)
        break
        case 40: //down
        e.preventDefault()
        if (!navigateList(1)) setVolume(-0.05, true)
        break
        case 13: //enter
        {
          // Check c3 first (artist tab's song list), then c2 (songs tab)
          let songHighlight = $("c3").querySelector(".row.highlight") as HTMLElement | null
          if (!songHighlight) {
            songHighlight = $("c2").querySelector(".row.highlight") as HTMLElement | null
          }
          if (songHighlight) {
            const songId = songHighlight.getAttribute("data-song-id")
            if (songId && songRegistry[songId]) {
              const { song, artist } = songRegistry[songId]
              playSong(song, artist, false)
            }
          }
        }
        break
      }
  })
}

const path = location.pathname.slice(baseURL.length + 1, location.pathname.length)

// Set initial history state with URL path
// This ensures page reloads will have state available
history.replaceState({"url": path}, path, baseURL + "/" + path)

// Apply initial routing
route(path)
setShortcuts()

// Pre-load a random song when landing on the root URL so the user can
// start listening with a single play click.
if (path === "") {
  loadRandomSong()
}

//Popstate
window.addEventListener("popstate", (event: PopStateEvent) => {
  if (event.state != null) {
    route(event.state)
  }
  else {
    // Handle page reload when state is null
    const path = location.pathname.slice(baseURL.length + 1, location.pathname.length)
    route(path)
  }
})
