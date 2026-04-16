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
// in the artist (c2) and song (c3) columns can be marked as playing.
let currentlyPlaying: { artistSlug: string, songSlug: string } | null = null

// Which top-level tab is currently active. Drives neighbour navigation
// (prev/next buttons and auto-advance when a song ends):
//   "artists" → neighbour is the prev/next song by the same artist
//   "songs"   → neighbour is the prev/next entry in the flat songs list
let currentTab: "artists" | "songs" = "artists"

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
    setFavicon(false)
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
      setFavicon(false)
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

    // Update UI and optionally start playing
    if (autoplay) {
      playpause()
    }
    // Player info is Artist - Title, both taken from the audio file's
    // embedded tags (track_artist / title). Use textContent so tag values
    // that happen to contain HTML-special characters are rendered as text.
    $("playerInfo").textContent = (song.track_artist || "") + " - " + song.title

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
  const { artistSlug, songSlug } = currentlyPlaying

  if (currentTab === "songs") {
    ajax<Song[]>("/songs", (songs) => {
      const idx = songs.findIndex((s) =>
        s.slug === songSlug && (s.artist_slug || "") === artistSlug
      )
      if (idx === -1) return
      const target = songs[idx + direction]
      if (!target) return
      playSong(target, target.artist_slug || "", false)
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

function highlight(element: HTMLElement): void {
  const containerEl = element.parentElement
  if (!containerEl) return
  const rows = containerEl.getElementsByClassName("row")
  for (let i = 0; i < rows.length; i++) {
    rows[i].className = "row"
  }
  element.className = "highlight row"
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
  // Skip non-row siblings just in case
  while (sibling && !sibling.classList.contains("row")) {
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
  const base = "/api"
  const x = new XMLHttpRequest()
  let str = ""
  let res: ApiResponse<T>
  let path: string

  // Show loading spinner only if the request takes noticeable time,
  // to avoid a flash on fast responses
  const spinnerEl = $("spinner")
  const spinnerTimeout = window.setTimeout(() => {
    spinnerEl.style.display = "inline-block"
  }, 200)

  path = base + url + (str ? "?" + str : "")

  x.open("get", path, true)
  x.send(null)
  x.onreadystatechange = function(): void {
    if (x.readyState === 4) {
      window.clearTimeout(spinnerTimeout)
      spinnerEl.style.display = "none"

      if (x.status === 200) {
        res = JSON.parse(x.responseText)

        if (!res.error) {
          if (res.data) {
            func(res.data as T)
          }
          else {
            throw new Error(`No data available for ${path}`)
          }
        }
        else {
          alert(`This Error occurred: ${res.error}`)
        }
      }
      else {
        throw new Error(
          `Http error ${x.status} occurred during an ajax request to ${path}`
        )
      }
    }
  }
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
              alt: "Image of" + artist.name}
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
        // Find the closest song div to the clicked element
        let target = e.target as HTMLElement
        const songDiv = target.closest(".row") as HTMLElement

        if (songDiv) {
          e.preventDefault()
          e.stopPropagation()

          // Get the song ID from the data attribute
          const songId = songDiv.getAttribute("data-song-id")
          if (songId && songRegistry[songId]) {
            const { song, artist } = songRegistry[songId]
            console.log("Double-clicked song:", song.title)
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
      const songDetailDiv = shaven(
        [$("c4"),
          ["div#song", {"data-song-id": detailSongId},
            ["button#playSong", "Play"],
            ["button#addSong", "Add"],
            ["button#shareSong", "Share"],
            ["img", {
              "src": baseURL + "/img/cover-placeholder.svg",
              "alt": "Image of" + (songData.track_artist || ""),
            }],
            ["nav#songNav",
              ["h2#heading", songData.title],
              ["p#trackArtist", songData.track_artist || ""],
              ["p#fileName", songData.file_name || ""],
            ],
            ["pre#lyrics", songData.lyrics || ""],
          ]
        ]
      ).rootElement

      // Use event delegation for detail view too
      const container = $("c4")

      container.addEventListener("dblclick", (e) => {
        let target = e.target as HTMLElement
        const songDiv = target.closest("#song") as HTMLElement

        if (songDiv) {
          e.preventDefault()
          e.stopPropagation()

          const songId = songDiv.getAttribute("data-song-id")
          if (songId && songRegistry[songId]) {
            const { song, artist } = songRegistry[songId]
            console.log("Song detail double-clicked:", song.title)
            playSong(song, artist, false)
          }
          return false
        }
      })

      container.addEventListener("click", (e) => {
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
          const songDiv = document.getElementById("song")
          if (songDiv) {
            const songId = songDiv.getAttribute("data-song-id")
            if (songId && songRegistry[songId]) {
              playlist.push(songRegistry[songId].song)
            }
          }
        }
      })
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
              ["button#settings"]
            ],
            ["div#c1",
              ["input#search", {type: "search", placeholder: "search"}],
              ["button#artists", "Artists"],
              ["button#songs", "Songs"],
              ["button#info", "Infos"],
              ["button#charts", "Charts"],
              ["button#playlists", "Playlists"]
            ],
            ["div#c2"],
            ["div#c3"],
            ["div#c4"],
            ["div#Bubble.bubble", {style: "display:none"}]
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
      })

      $("logo").addEventListener("click", () => {
        window.location.href = baseURL + "/"
      })

      $("charts").addEventListener("click", () => {
        printObj.songs("")
      })

      $("artists").addEventListener("click", () => {
        printObj.artists()
      })

      $("songs").addEventListener("click", () => {
        printObj.allSongs()
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
    }
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

    if (dirs.length === 1 && dirs[0] !== "") view.artist(dirs[0])
      else if (dirs.length === 2) view.song(dirs)
      else if (url === "") {
      // Empty URL, do nothing
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
        playpause()
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
    switch (e.keyCode) {
      case 37: //left
        break
        case 39: //right
        break
        case 38: //up
        e.preventDefault()
        if (!navigateList(-1)) setVolume(0.05, true)
        break
        case 40: //down
        e.preventDefault()
        if (!navigateList(1)) setVolume(-0.05, true)
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
