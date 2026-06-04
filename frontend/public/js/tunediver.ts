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

// Tracks which song is currently loaded in the player so that matching rows
// in the artist (c2) and song (c3) columns can be marked as playing. When
// playback was started from a playlist, `playlistId` + `playlistIndex` are
// set so prev/next can step through that playlist rather than guessing
// from `currentTab`.
let currentlyPlaying: {
  artistSlug: string
  songSlug: string
  playlistId?: string
  playlistIndex?: number
} | null = null

// Which top-level tab is currently active. Drives neighbour navigation
// (prev/next buttons and auto-advance when a song ends) when no playlist
// context is set on `currentlyPlaying`:
//   "artists"   → neighbour is the prev/next song by the same artist
//   "songs"     → neighbour is the prev/next entry in the flat songs list
//   "playlists" → neighbour comes from the active playlist (via context)
let currentTab: "artists" | "songs" | "playlists" = "artists"

// The playlist currently rendered in c3 (when the Playlists tab is active),
// so the play/remove handlers in the playlist's song rows can reference it.
let currentPlaylistId: string | null = null

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
// currently playing track is visually highlighted in the columns.
// Called whenever the playback state or the rendered lists change.
function updatePlayingMarkers(): void {
  document.querySelectorAll(".row.playing").forEach((r) => {
    r.classList.remove("playing")
  })

  if (!currentlyPlaying || audio.paused) return

  const artistSlug = currentlyPlaying.artistSlug
  const songSlug = currentlyPlaying.songSlug

  const artistRow = document.querySelector(
    `#c2 .row[data-artist-slug="${CSS.escape(artistSlug)}"]`
  )
  if (artistRow) artistRow.classList.add("playing")

  const songRow = document.querySelector(
    `#c3 .row[data-artist-slug="${CSS.escape(artistSlug)}"]`
    + `[data-song-slug="${CSS.escape(songSlug)}"]`
  )
  if (songRow) songRow.classList.add("playing")
}

// Simple fuzzy match: checks whether all characters of the query appear
// in order within the target string (case-insensitive).
function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }
  return qi === q.length
}

// Filter visible rows in c2 and c3 based on the current search query.
// Each row is matched against its text content and relevant data attributes.
function filterRows(query: string): void {
  const q = query.trim()

  const filter = (container: HTMLElement) => {
    const rows = container.querySelectorAll(".row")
    rows.forEach((row) => {
      const el = row as HTMLElement
      if (!q) {
        el.style.display = ""
        return
      }
      // Match against visible text, title attribute, and data attributes
      const text = (el.textContent || "")
        + " " + (el.getAttribute("title") || "")
        + " " + (el.getAttribute("data-artist-slug") || "")
        + " " + (el.getAttribute("data-song-slug") || "")
      el.style.display = fuzzyMatch(q, text) ? "" : "none"
    })
  }

  filter($("c2"))
  if ($("c3").style.display !== "none") {
    filter($("c3"))
  }
}

// Utility functions
function toggle(id: string): void {
  const element = $(id)
  if (element.style.display === "none") {
    element.style.display = "block"
  }
  else {
    element.style.display = "none"
  }
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

  // Stop any currently playing audio
  if (audio && !audio.paused) {
    audio.pause()
    const playEl = document.getElementById("play")
    if (playEl) {
      playEl.className = "paused"
    }
  }

  try {
    // Create a new Audio object with the song source
    const newAudio = new Audio(song.src)

    // First set up all event listeners before replacing the global audio reference
    // This ensures no event listeners are lost during transition

    // Re-initialize all event listeners on the new audio object
    newAudio.addEventListener("timeupdate", () => playerUpdater())
    newAudio.addEventListener("loadedmetadata", () => playerUpdater())
    newAudio.addEventListener("play", () => {
      playerUpdater()
      updatePlayingMarkers()
    })
    newAudio.addEventListener("pause", () => updatePlayingMarkers())

    newAudio.addEventListener("ended", () => {
      const playEl = document.getElementById("play")
      if (playEl) {
        playEl.className = "paused"
      }
      newAudio.currentTime = 0
      playerUpdater()
      updatePlayingMarkers()
      // Auto-advance to the next neighbour in the active tab's list.
      // No-op if nothing is queued after the current song.
      playAdjacentSong(1)
    }, false)

    // Set the volume to match the current volume
    newAudio.volume = audio.volume

    // Now replace the global audio instance
    audio = newAudio

    // Remember which track is loaded so row markers can find it. Markers
    // are applied on the "play" event (or removed on "pause"/"ended"),
    // so pre-loaded tracks that aren't autoplaying stay unmarked.
    currentlyPlaying = { artistSlug: artistName, songSlug: song.slug }

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
    // embedded tags (track_artist / title). Use textContent so tag values
    // that happen to contain HTML-special characters are rendered as text.
    $("playerInfo").textContent = (song.track_artist || "") + " - " + song.title

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
      const url = artistName + "/" + song.slug
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
  if (!currentlyPlaying) return
  const { artistSlug, songSlug, playlistId, playlistIndex } = currentlyPlaying

  // Playlist context overrides currentTab: even if the user has navigated
  // away from the Playlists tab while a song plays, prev/next still walks
  // the playlist that started playback.
  if (playlistId !== undefined && playlistIndex !== undefined) {
    ajax<Playlist>(`/playlists/${playlistId}`, (playlist) => {
      const targetIdx = playlistIndex + direction
      const target = playlist.tracks[targetIdx]
      if (!target || !target.available) return
      playPlaylistTrack(playlist.id, targetIdx, target)

      // If we're still viewing this playlist in c3, sync the highlight and
      // detail view so the UI reflects what's playing.
      if (currentPlaylistId === playlist.id) {
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

  if (currentTab === "songs") {
    ajax<Song[]>("/songs", (songs) => {
      const idx = songs.findIndex((s) =>
        s.slug === songSlug && (s.artist_slug || "") === artistSlug
      )
      if (idx === -1) return
      const target = songs[idx + direction]
      if (!target) return
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
      const url = targetArtistSlug + "/" + target.slug
      history.pushState({"url": url}, target.slug, baseURL + "/" + url)
    })
    return
  }

  ajax<Song[]>(`/artists/${artistSlug}/songs`, (songs) => {
    const idx = songs.findIndex((s) => s.slug === songSlug)
    if (idx === -1) return
    const target = songs[idx + direction]
    if (!target) return
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
// playlist. We patch `currentlyPlaying` after `playSong` sets it because
// playSong itself has no notion of playlists.
function playPlaylistTrack(
  playlistId: string,
  index: number,
  track: PlaylistTrack,
): void {
  if (!track.available) return
  playSong(track as unknown as Song, track.artist_slug, false)
  if (currentlyPlaying) {
    currentlyPlaying.playlistId = playlistId
    currentlyPlaying.playlistIndex = index
  }
}

// Rescan the music folder on the server, then re-render whatever view is
// currently showing so newly added (or removed) tracks appear. The currently
// playing audio is left untouched.
//
// The server scans in the background and the POST returns immediately, so the
// button keeps spinning while we poll /scan-status, and we re-render only once
// the scan has finished (so the refreshed view reflects the new catalog).
function reloadCatalog(): void {
  const button = document.getElementById("reload")
  if (button) button.classList.add("spinning")

  const stopAndRender = (): void => {
    if (button) button.classList.remove("spinning")
    const path = location.pathname.slice(
      baseURL.length + 1, location.pathname.length
    )
    route(path)
  }

  const poll = (): void => {
    ajax<{ scanning: boolean; track_count: number }>(
      "/scan-status",
      (status) => {
        if (status.scanning) {
          window.setTimeout(poll, 1000)
        } else {
          stopAndRender()
        }
      }
    )
  }

  ajaxMutate<{ track_count: number }>(
    "POST",
    "/reload",
    null,
    () => poll(),
    (status) => {
      if (button) button.classList.remove("spinning")
      throw new Error(`Reload failed: ${status}`)
    }
  )
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
      printObj.playlist(id)
      // If the list is visible in c2, refresh its labels.
      if (currentTab === "playlists") {
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
      if (currentlyPlaying && currentlyPlaying.playlistId === id) {
        currentlyPlaying.playlistId = undefined
        currentlyPlaying.playlistIndex = undefined
      }
      currentPlaylistId = null
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
    () => flashAnchor("Added!"),
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
      // The played track's index might shift; re-render and update markers.
      if (
        currentlyPlaying &&
        currentlyPlaying.playlistId === playlistId &&
        currentlyPlaying.playlistIndex !== undefined
      ) {
        if (currentlyPlaying.playlistIndex === index) {
          currentlyPlaying.playlistId = undefined
          currentlyPlaying.playlistIndex = undefined
        } else if (currentlyPlaying.playlistIndex > index) {
          currentlyPlaying.playlistIndex -= 1
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

// Print namespace/object with rendering functions
const printObj = {
  artists(): void {
    currentTab = "artists"
    setActiveTab("artists")
    $("c2").style.display = "inline-block"
    // Restore c3 in case the "Songs" tab had hidden it
    $("c3").style.display = ""
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

          history.pushState({"url": artist.slug}, artist.slug, baseURL + "/" + artist.slug)
        })

        link.addEventListener("dblclick", (e: Event) => {
          e.preventDefault()
          e.stopPropagation()
          ajax<Song[]>(`/artists/${artist.slug}/songs`, (songs) => {
            if (songs.length) {
              playSong(songs[0], artist.slug, false)
            }
          })
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
              ["p#country", artist.country || "Niemandsland"]
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
      // Restore c3 in case the "Songs" tab had hidden it
      $("c3").style.display = ""

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

      // Use event delegation on the container instead of individual handlers
      const container = $("c3")

      // Handle double-clicks on song divs
      container.addEventListener("dblclick", (e) => {
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
      })

      // Handle clicks on play buttons
      container.addEventListener("click", (e) => {
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
              const url = artist + "/" + song.slug
              history.pushState({"url": url}, song.slug, baseURL + "/" + url)
            }
          }
          return false
        }
      })
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
            ["button#copyFilepath", "Copy Filepath"],
            ["img#songCover", {
              "src": coverUrl,
              "alt": "Image of " + (songData.track_artist || ""),
            }],
            ["nav#songNav",
              ["h2#heading", songData.title],
              ["p#trackArtist", songData.track_artist || ""],
              ["p#dateAdded",
                songData.date_added
                  ? "Added " + songData.date_added
                  : "",
              ],
            ],
            ["pre#lyrics", songData.lyrics || ""],
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
    currentTab = "songs"
    setActiveTab("songs")
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

        const link = shaven(["a", song.title]).rootElement
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

      const container = $("c2")

      container.addEventListener("dblclick", (e) => {
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
      })

      container.addEventListener("click", (e) => {
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
            const url = artist + "/" + song.slug
            history.pushState({"url": url}, song.slug, baseURL + "/" + url)
          }
        }
      })
    })
  },

  // List view in c2: all playlists, with a "+ New playlist" row at the top
  // that prompts for a name and creates the playlist via POST.
  playlists(): void {
    currentTab = "playlists"
    currentPlaylistId = null
    setActiveTab("playlists")
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
            ajax<Playlist>(`/playlists/${playlist.id}`, (full) => {
              const idx = full.tracks.findIndex((t) => t.available)
              if (idx === -1) return
              playPlaylistTrack(full.id, idx, full.tracks[idx])
            })
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
      currentPlaylistId = playlist.id
      $("c3").innerHTML = ""
      $("c3").style.display = ""

      playlist.tracks.forEach((track, index) => {
        const link = shaven(["a", track.title]).rootElement
        const play = shaven(["button#.play"]).rootElement
        const remove = shaven(["button#.remove"]).rootElement

        const row = shaven(
          ["div#.row", {
            "title": (track.track_artist || "") + " — " + track.title,
            "data-playlist-index": String(index),
            "data-artist-slug": track.artist_slug,
            "data-song-slug": track.slug,
          },
            [play],
            [link],
            [remove],
          ]
        ).rootElement

        if (!track.available) row.classList.add("unavailable")
        $("c3").appendChild(row)
      })

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
            ],
          ]
        ]
      )

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
}

function viewController(): Record<string, Function> {
  return {
    framework(): void {
      function showSettings(): void {
        toggle("settingsBubble")
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
              ["button#reload", { "title": "Rescan music folder" }],
              ["button#settings"]
            ],
            ["div#c1",
              ["input#search", {type: "search", placeholder: "search"}],
              ["button#artists", "Artists"],
              ["button#songs", "Songs"],
              ["button#playlists", "Playlists"]
            ],
            ["div#c2"],
            ["div#c3"],
            ["div#c4"],
            ["div#Bubble.bubble", {style: "display:none"}],
            ["div#addToPlaylistBubble.bubble", {style: "display:none"}]
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
        filterRows((e.target as HTMLInputElement).value)
      })

      // Also handle clearing via the "x" button on type="search" inputs
      $("search").addEventListener("search", (e: Event) => {
        filterRows((e.target as HTMLInputElement).value)
      })

      $("logo").addEventListener("click", () => {
        history.pushState({"url": ""}, "", baseURL + "/")
        route("")
      })

      $("artists").addEventListener("click", () => {
        ;($("search") as HTMLInputElement).value = ""
        printObj.artists()
      })

      $("songs").addEventListener("click", () => {
        ;($("search") as HTMLInputElement).value = ""
        printObj.allSongs()
      })

      $("playlists").addEventListener("click", () => {
        ;($("search") as HTMLInputElement).value = ""
        printObj.playlists()
        history.pushState(
          { "url": "playlists" }, "Playlists", baseURL + "/playlists"
        )
      })

      $("reload").addEventListener("click", (e: Event) => {
        e.stopPropagation()
        reloadCatalog()
      })

      $("settings").addEventListener("click", (e: Event) => {
        showSettings()
        e.stopPropagation()
      })
    },

    index(): void {
      this.framework()
      initPlayer()
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

    song(dirs: string[] | [string, string]): void {
      printObj.artists()
      printObj.songs(dirs[0])
      printObj.song(dirs[1], dirs[0])
    },

    playlists(): void {
      printObj.playlists()
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

    if (dirs.length === 1 && dirs[0] !== "") view.artist(dirs[0])
      else if (dirs.length === 2) view.song(dirs)
      else if (url === "") {
      printObj.artists()
      printObj.startpage()
    }
    else if (url !== "") {
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
