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


function initPlayer () {
  // Set up interval for continuous updates (as a fallback)
  let updateInterval: number | null = null;

  function startUpdateInterval() {
    // Clear any existing interval first
    if (updateInterval !== null) {
      window.clearInterval(updateInterval);
    }
    // Update every 250ms while playing
    updateInterval = window.setInterval(() => {
      if (!audio.paused) {
        playerUpdater();
      }
    }, 250);
  }

  // Start interval when audio begins playing
  audio.addEventListener("play", () => {
    playerUpdater();
    startUpdateInterval();
  });

  // Clear interval when audio pauses
  audio.addEventListener("pause", () => {
    if (updateInterval !== null) {
      window.clearInterval(updateInterval);
      updateInterval = null;
    }
    playerUpdater();
  });

  // Standard timeupdate event (still useful as a backup)
  audio.addEventListener("timeupdate", () => {
    playerUpdater();
  });

  // Also update when audio is loaded/metadata available
  audio.addEventListener("loadedmetadata", () => {
    playerUpdater();
  });

  audio.addEventListener("ended", () => {
    const playEl = document.getElementById("play")
    if (playEl) {
      playEl.className = "paused"
    }
    audio.currentTime = 0;
    playerUpdater();

    if (updateInterval !== null) {
      window.clearInterval(updateInterval);
      updateInterval = null;
    }
  });

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
        shuffleEnabled = !shuffleEnabled
        shuffleEl.classList.toggle("active", shuffleEnabled)
        shuffleEl.setAttribute(
          "title", shuffleEnabled ? "Shuffle: on" : "Shuffle: off"
        )
      })
    }

    const repeatEl = document.getElementById("repeat")
    if (repeatEl) {
      repeatEl.addEventListener("click", (e: Event) => {
        e.stopPropagation()
        // Cycle off → all → one → off.
        repeatMode = repeatMode === "off"
          ? "all"
          : repeatMode === "all" ? "one" : "off"
        // `.active` lights the icon for both repeat modes; `.one` adds the
        // "1" badge that distinguishes repeat-one from repeat-all.
        repeatEl.classList.toggle("active", repeatMode !== "off")
        repeatEl.classList.toggle("one", repeatMode === "one")
        repeatEl.setAttribute("title", "Repeat: " + repeatMode)
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
        if (!currentlyPlaying) return
        const url = currentlyPlaying.artistSlug + "/" + currentlyPlaying.songSlug
        history.pushState({"url": url}, currentlyPlaying.songSlug, baseURL + "/" + url)
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

function setPlayingState(state: "playing" | "paused"): void {
  const playEl = document.getElementById("play")
  if (!playEl) {
    throw new Error("Play element not found")
  }

  if (state === "playing") {
    audio.play()
    playEl.className = "playing"
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "playing"
    }
  }
  else if (state === "paused") {
    audio.pause()
    playEl.className = "paused"
    if ("mediaSession" in navigator) {
      navigator.mediaSession.playbackState = "paused"
    }
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

  const matches =
    currentlyPlaying !== null &&
    container.getAttribute("data-artist-slug") === currentlyPlaying.artistSlug &&
    container.getAttribute("data-song-slug") === currentlyPlaying.songSlug

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
