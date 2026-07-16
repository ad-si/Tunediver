let audio = new Audio()
audio.volume = 0.5

let tempVolume: number = 0.5

// True only while the user is actively dragging the progress bar (pointer
// is down). Using focus for this was too aggressive: after a click the
// input stays focused, which would freeze the progress indicator.
let isSeekingProgress: boolean = false


// Copy text to the clipboard. navigator.clipboard is only available in secure
// contexts (HTTPS / localhost); Tunediver is usually served over plain HTTP on
// a LAN, where it is undefined. Fall back to a hidden textarea + execCommand.
function copyToClipboard (text: string): void {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
  }
  else {
    fallbackCopy(text)
  }
}

function fallbackCopy (text: string): void {
  const textarea = document.createElement("textarea")
  textarea.value = text
  // Keep it out of view and non-scrolling while still selectable.
  textarea.style.position = "fixed"
  textarea.style.top = "-9999px"
  textarea.setAttribute("readonly", "")
  document.body.appendChild(textarea)
  textarea.select()
  try {
    document.execCommand("copy")
  }
  finally {
    document.body.removeChild(textarea)
  }
}


// Shared interval handle: a 250 ms fallback that keeps the progress UI moving
// even when `timeupdate` events are sparse. Only one audio plays at a time, so
// a single handle suffices; it is cleared whenever any audio pauses or ends.
let playerUpdateInterval: number | null = null

// Wire an <audio> element to the store and player UI. playSong builds a fresh
// Audio per track, so this runs once per track; the initial placeholder audio
// is wired the same way from initPlayer. All playback UI (the play/pause
// button, row markers, media-session state) follows from store.playState,
// which these events drive — so nothing here touches the DOM directly.
function attachAudioListeners(a: HTMLAudioElement): void {
  a.addEventListener("timeupdate", () => playerUpdater())
  a.addEventListener("loadedmetadata", () => playerUpdater())

  a.addEventListener("play", () => {
    store.playState = "playing"
    playerUpdater()
    if (playerUpdateInterval !== null) window.clearInterval(playerUpdateInterval)
    playerUpdateInterval = window.setInterval(() => {
      if (!audio.paused) playerUpdater()
    }, 250)
  })

  a.addEventListener("pause", () => {
    store.playState = "paused"
    if (playerUpdateInterval !== null) {
      window.clearInterval(playerUpdateInterval)
      playerUpdateInterval = null
    }
  })

  a.addEventListener("ended", () => {
    if (playerUpdateInterval !== null) {
      window.clearInterval(playerUpdateInterval)
      playerUpdateInterval = null
    }
    a.currentTime = 0
    store.playState = "paused"
    playerUpdater()
    // Repeat-one replays the current track; otherwise auto-advance to the next
    // neighbour in the active list (a no-op if nothing follows, unless
    // repeat-all wraps back to the start).
    if (store.repeatMode === "one") {
      setPlayingState("playing")
      return
    }
    playAdjacentSong(1)
  })
}

function initPlayer () {
  attachAudioListeners(audio)

  const controlsEl = document.getElementById("controls")
  if (controlsEl) {
    shaven(
      [controlsEl,
        ["button#previous", {"disabled": "disabled"}],
        ["button#play", {"class": "paused", "disabled": "disabled"}],
        ["button#next", {"disabled": "disabled"}],
        ["button#shuffle"],
        ["button#repeat"],
        ["span#time", "0:00"],
        ["div",
          ["p#playerInfo", ""],
          ["input#progressInput",
            {type: "range", min: "0", max: "100", value: "0", step: "0.1"}
          ]
        ],
        ["span#duration", "- 0:00"],
        ["button#mute"],
        ["input#volume", {type: "range", min: "0", max: "1", step: "0.01", value: "0.5"}],
        ["button#loud"],
        ["button#copy"]
      ]
    )

    const playEl = document.getElementById("play")
    if (playEl) {
      playEl.addEventListener("click", () => playpause(), false)
    }

    const previousEl = document.getElementById("previous")
    if (previousEl) {
      previousEl.addEventListener("click", () => playAdjacentSong(-1), false)
    }

    const nextEl = document.getElementById("next")
    if (nextEl) {
      nextEl.addEventListener("click", () => playAdjacentSong(1), false)
    }

    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => {
        if (audio.src) setPlayingState("playing")
      })
      navigator.mediaSession.setActionHandler("pause", () => {
        setPlayingState("paused")
      })
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        playAdjacentSong(-1)
      })
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        playAdjacentSong(1)
      })
    }

    const progressInputEl = document.getElementById("progressInput") as HTMLInputElement

    if (progressInputEl) {
      // Mark seeking only while the pointer is held down. Listen for
      // pointerup / pointercancel on window so drags that end off the
      // slider still clear the flag.
      progressInputEl.addEventListener("pointerdown", () => {
        isSeekingProgress = true
      })
      const endSeek = (): void => { isSeekingProgress = false }
      window.addEventListener("pointerup", endSeek)
      window.addEventListener("pointercancel", endSeek)

      // Handle when user is dragging the slider
      progressInputEl.addEventListener("input", () => {
        if (audio && audio.src && !isNaN(audio.duration)) {
          const percentage = parseFloat(progressInputEl.value) / 100
          const newTime = audio.duration * percentage
          const safeTime = Math.max(0.1, newTime)

          // Update displays immediately without waiting for timeupdate event
          audio.currentTime = safeTime
          playerUpdater()
        }
      })

      // Handle when user finishes dragging the slider
      progressInputEl.addEventListener("change", () => {
        if (audio && audio.src && !isNaN(audio.duration)) {
          // Force an update after seeking completes
          playerUpdater()
        }
      })
    }

    const shuffleEl = document.getElementById("shuffle")
    if (shuffleEl) {
      shuffleEl.addEventListener("click", (e: Event) => {
        e.stopPropagation()
        // The button's .active class and title follow store.shuffleEnabled via
        // the effect in wireStoreEffects; here we only flip the state.
        store.shuffleEnabled = !store.shuffleEnabled
      })
    }

    const repeatEl = document.getElementById("repeat")
    if (repeatEl) {
      repeatEl.addEventListener("click", (e: Event) => {
        e.stopPropagation()
        // Cycle off → all → one → off. The button's .active/.one classes and
        // title follow store.repeatMode via the effect in wireStoreEffects.
        store.repeatMode = store.repeatMode === "off"
          ? "all"
          : store.repeatMode === "all" ? "one" : "off"
      })
    }

    const muteEl = document.getElementById("mute")
    if (muteEl) {
      muteEl.addEventListener("click", () => mute(), false)
    }

    const volumeEl = document.getElementById("volume") as HTMLInputElement
    if (volumeEl) {
      // Paint the track fill to match the initial slider position.
      volumeEl.style.setProperty("--volume", (parseFloat(volumeEl.value) * 100) + "%")

      volumeEl.addEventListener("input", () => {
        if (audio) {
          audio.volume = parseFloat(volumeEl.value)
        }
        volumeEl.style.setProperty("--volume", (parseFloat(volumeEl.value) * 100) + "%")
      })
    }

    const loudEl = document.getElementById("loud")
    if (loudEl) {
      loudEl.addEventListener("click", () => setVolume(1), false)
    }

    const playerInfoEl = document.getElementById("playerInfo")
    if (playerInfoEl) {
      playerInfoEl.addEventListener("click", () => {
        const playing = store.currentlyPlaying
        if (!playing) return
        // Must match route()'s song URL shape (artists/<artist>/songs/<song>);
        // a bare "<artist>/<song>" hits the catch-all and alerts an error.
        const url = songPath(playing.artistSlug, playing.songSlug)
        history.pushState({"url": url}, playing.songSlug, baseURL + "/" + url)
        route(url)
      })
    }

    const copyEl = document.getElementById("copy")
    if (copyEl) {
      copyEl.addEventListener("click", () => {
        const playerInfoEl = document.getElementById("playerInfo")
        if (playerInfoEl && playerInfoEl.textContent) {
          copyToClipboard(playerInfoEl.textContent)
        }
      })
    }
  }
}

// Start or stop playback. The button class and media-session state are not set
// here: the audio element's play/pause events update store.playState, and the
// reactive effect in wireStoreEffects mirrors that onto the UI. This keeps a
// single path for play state no matter what triggered the change (button,
// keyboard, media keys, or a track ending).
function setPlayingState(state: PlayState): void {
  if (state === "playing") {
    audio.play()
  }
  else if (state === "paused") {
    audio.pause()
  }
  else {
    throw new Error("Unknown playing state:" + state)
  }
}

function playerUpdater(): void {
  // Get DOM elements
  const timeEl = document.getElementById("time")
  const durationEl = document.getElementById("duration")
  const progressInputEl = document.getElementById("progressInput") as HTMLInputElement

  if (!timeEl || !durationEl || !progressInputEl) {
    console.error("Player UI elements not found");
    return;
  }

  try {
    // Force update to ensure values are current
    timeEl.textContent = timeElapsed()
    durationEl.textContent = timeLeft()

    // Only update progress if audio is valid and has duration
    if (audio && !isNaN(audio.duration) && audio.duration > 0) {
      // Calculate normalized progress as percentage (0-100)
      const progress = Math.min(100, Math.max(0, (audio.currentTime / audio.duration) * 100))

      // Don't update slider if user is currently dragging it
      if (!isSeekingProgress) {
        progressInputEl.value = progress.toString()
      }
      progressInputEl.style.setProperty("--progress", progress + "%")

      // Debug information to help verify updates
      console.debug(`Player update: ${audio.currentTime.toFixed(1)}/${audio.duration.toFixed(1)}s (${progress.toFixed(1)}%)`)
    } else {
      // Reset progress bar if no valid audio
      progressInputEl.value = "0"
      progressInputEl.style.setProperty("--progress", "0%")
    }

    updateSyncedLyrics()
  } catch (e) {
    console.error("Error in playerUpdater:", e)
  }
}

// Highlight the current line of time-synced lyrics as playback progresses.
// No-op unless the detail view currently shows time-synced lyrics
// (`#lyrics.synced`, produced by `lyricsNode`) for the track that's actually
// playing; otherwise any stale highlight is cleared. The active line is the
// last one whose `data-time` is at or before the current playback position.
function updateSyncedLyrics(): void {
  const container = document.getElementById("lyrics")
  if (!container || !container.classList.contains("synced")) return

  const lines = container.querySelectorAll<HTMLElement>(".lyricLine")

  const playing = store.currentlyPlaying
  const matches =
    playing !== null &&
    container.getAttribute("data-artist-slug") === playing.artistSlug &&
    container.getAttribute("data-song-slug") === playing.songSlug

  if (!matches || !audio || isNaN(audio.currentTime)) {
    lines.forEach((line) => line.classList.remove("active"))
    return
  }

  const t = audio.currentTime
  let activeIndex = -1
  lines.forEach((line, i) => {
    const time = parseFloat(line.getAttribute("data-time") || "")
    if (!isNaN(time) && time <= t) activeIndex = i
  })

  lines.forEach((line, i) => {
    if (i === activeIndex) {
      // Scroll only when the active line changes, so smooth scrolling isn't
      // retriggered on every timeupdate tick.
      if (!line.classList.contains("active")) {
        line.classList.add("active")
        line.scrollIntoView({ block: "center", behavior: "smooth" })
      }
    } else {
      line.classList.remove("active")
    }
  })
}

function timeLeft(): string {
  if (isNaN(audio.duration) || audio.duration === 0) {
    return "- 0:00";
  }

  const dur = audio.duration
  const currentTime = audio.currentTime
  const timeLeft = Math.max(0, dur - currentTime)

  // Format with fixed precision to avoid floating point issues
  const s = Math.floor(timeLeft % 60)
  const m = Math.floor(timeLeft / 60)

  return (s < 10) ? ("- " + m + ":0" + s) : ("- " + m + ":" + s)
}

function timeElapsed(): string {
  if (isNaN(audio.currentTime)) {
    return "0:00";
  }

  // Format with fixed precision to avoid floating point issues
  const s = Math.floor(audio.currentTime % 60)
  const m = Math.floor(audio.currentTime / 60)

  return (s < 10) ? (m + ":0" + s) : (m + ":" + s)
}

function mute(): void {
  if (audio.volume === 0) {
    setVolume(true)
  }
  else {
    setVolume(false)
  }
}

function setVolume(n: number | boolean, relative?: boolean): void {
  const volumeEl = document.getElementById("volume") as HTMLInputElement
  if (!volumeEl) {
    throw new Error("Volume element not found")
  }

  relative = relative || false

  if (typeof(n) === "number") {
    if (relative) {
      volumeEl.value = String(Number(volumeEl.value) + n)
      audio.volume = parseFloat(volumeEl.value)
    }
    else {
      audio.volume = parseFloat(volumeEl.value = String(n))
    }
  }
  else if (n === true) {
    audio.volume = parseFloat(volumeEl.value = String(tempVolume))
  }
  else if (n === false) {
    tempVolume = audio.volume
    audio.volume = parseFloat(volumeEl.value = "0")
  }
  else {
    throw new Error(String(n) + " is not a valid value for the volume.")
  }

  // Keep the track fill in sync after programmatic changes (mute, loud, etc.).
  volumeEl.style.setProperty("--volume", (parseFloat(volumeEl.value) * 100) + "%")
}

function playpause(): void {
  if (audio.paused && audio.src) {
    setPlayingState("playing")
  }
  else if (!audio.paused) {
    setPlayingState("paused")
  }
  else {
    throw new Error("No song loaded.")
  }
}
