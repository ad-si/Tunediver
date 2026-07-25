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


// --- Waveform ---------------------------------------------------------------
//
// The seek bar is backed by the track's waveform. The server hands out one
// 0-255 amplitude value per horizontal slice of the track (GET .../waveform,
// computed by decoding the file once and cached in its DB), and those values
// become an SVG mask over a two-colour gradient.
//
// A mask rather than a canvas, because it keeps everything else free: progress
// is the gradient's hard stop, so advancing playback only writes --progress and
// never redraws the shape; the theme colours stay in CSS; and the shape
// stretches to whatever width the elastic transport happens to have. The
// fallback shape — a flat bar, for a track whose waveform is still loading or
// can't be decoded — is the default value of --waveform-mask in player.css, so
// clearing the property here restores it.

// Incremented per request so a slow waveform response for a track the user has
// already skipped past can't overwrite the current one.
let waveformRequestId: number = 0

// Paint `peaks` (0-255, one per slice) behind the seek bar, or restore the flat
// bar when passed null.
function setWaveform(peaks: number[] | null): void {
  const waveformEl = document.getElementById("waveform")
  if (!waveformEl) return

  if (!peaks || peaks.length < 2) {
    waveformEl.style.removeProperty("--waveform-mask")
    return
  }
  waveformEl.style.setProperty("--waveform-mask", waveformMask(peaks))
}

// Build the mask: one filled shape mirrored around the vertical centre of a
// 100-unit-tall viewBox, traced along the top edge and back along the bottom.
// preserveAspectRatio="none" lets it stretch to the element's box, so the same
// mask serves every window width. Black fill is deliberate — a CSS mask taken
// from an image uses its alpha channel, and the colour is irrelevant.
function waveformMask(peaks: number[]): string {
  const width = peaks.length - 1
  const top: string[] = []
  const bottom: string[] = []

  for (let i = 0; i < peaks.length; i++) {
    // Half-height of the shape at this slice. The 1-unit floor keeps silent
    // passages visible as a hairline instead of a gap in the bar.
    const amplitude = Math.max(1, (peaks[i] / 255) * 50)
    top.push(i + " " + (50 - amplitude).toFixed(1))
    bottom.push(i + " " + (50 + amplitude).toFixed(1))
  }
  bottom.reverse()

  const path = "M" + top.join("L") + "L" + bottom.join("L") + "Z"
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 " + width + " 100'"
    + " preserveAspectRatio='none'><path d='" + path + "'/></svg>"

  return 'url("data:image/svg+xml,' + svg + '")'
}

// Fetch and paint the waveform for a track, falling back to the flat bar if the
// server has none (a codec it can't decode, or a track it hasn't cached yet).
function loadWaveform(artistSlug: string, songSlug: string): void {
  const requestId = ++waveformRequestId
  // Clear immediately so the previous track's shape isn't left standing while
  // this one is computed — a first-time decode can take a few seconds.
  setWaveform(null)

  // Slugs arrive from the API already URL-encoded, as in the cover art URLs.
  const url = baseURL + "/api/artists/" + artistSlug
    + "/songs/" + songSlug + "/waveform"

  fetch(url)
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (requestId !== waveformRequestId) return
      setWaveform(data && data.peaks ? data.peaks : null)
    })
    .catch(() => {
      if (requestId === waveformRequestId) setWaveform(null)
    })
}

// --- Time ruler -------------------------------------------------------------
//
// The waveform shows where the loud parts are; the ruler says when they happen.
// Labelled gridlines cross the waveform at round intervals, with unlabelled
// minor ticks subdividing them, so a glance reads out position without having
// to interpolate between the elapsed and remaining counters.

// Candidate intervals between labelled ticks, in seconds. The first one whose
// labels won't crowd each other at the transport's current width wins, so the
// ruler coarsens as the window narrows or the track lengthens instead of
// collapsing into an unreadable comb.
const TICK_INTERVALS: number[] =
  [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]

// Horizontal room a label needs before the next one starts crowding it.
const MIN_LABEL_SPACING: number = 52

// Horizontal room between minor ticks before they stop reading as separate
// marks.
const MIN_MINOR_SPACING: number = 8

// Distance from either end within which a label would be clipped by the
// transport's edge. Those ticks keep their gridline but lose their label.
const LABEL_EDGE_MARGIN: number = 24

// The finest subdivision of `major` that is itself a round number of seconds
// and still leaves its marks far enough apart to count. Splitting the major
// interval by a fixed number of parts instead would land on times nobody reads
// as a scale — fifths of half a minute is a tick every six seconds. Candidates
// have to divide the major interval exactly, so every labelled tick still lands
// on a minor one. Returns 0 when nothing subdivides it readably.
function chooseMinorInterval(
  major: number,
  duration: number,
  width: number,
): number {
  for (let i = 0; i < TICK_INTERVALS.length; i++) {
    const candidate = TICK_INTERVALS[i]
    if (candidate >= major) break
    if (major % candidate !== 0) continue
    if ((candidate / duration) * width >= MIN_MINOR_SPACING) return candidate
  }
  return 0
}

// Duration and width the ruler was last built for. Rebuilding is only DOM
// churn when neither changed, and playerUpdater calls this several times a
// second.
let renderedRuler: string = ""

function renderTimeRuler(): void {
  const ticksEl = document.getElementById("waveformTicks")
  const axisEl = document.getElementById("waveformAxis")
  const progressEl = document.getElementById("progress")
  if (!ticksEl || !axisEl || !progressEl) return

  const duration = audio ? audio.duration : NaN
  const width = progressEl.clientWidth
  const signature = duration + "@" + width
  if (signature === renderedRuler) return
  renderedRuler = signature

  ticksEl.innerHTML = ""
  axisEl.innerHTML = ""
  if (!isFinite(duration) || duration <= 0 || width <= 0) return

  // Fall back to the coarsest interval when even that one crowds — better a
  // sparse ruler than a solid block of overlapping labels.
  let interval = TICK_INTERVALS[TICK_INTERVALS.length - 1]
  for (let i = 0; i < TICK_INTERVALS.length; i++) {
    if ((TICK_INTERVALS[i] / duration) * width >= MIN_LABEL_SPACING) {
      interval = TICK_INTERVALS[i]
      break
    }
  }

  // Walk in minor steps when the interval subdivides readably, in major steps
  // when it doesn't. Either way a labelled tick is one whose time is a whole
  // multiple of the labelled interval.
  const minorInterval = chooseMinorInterval(interval, duration, width)
  const step = minorInterval || interval

  // From 0, so the scale starts at the track's own beginning rather than at its
  // first whole interval.
  for (let i = 0; i * step < duration; i++) {
    const seconds = i * step
    const isMajor = seconds % interval === 0
    const atStart = seconds === 0
    const position = (seconds / duration) * 100

    // The mark itself goes in the strip below the bar, where nothing overlaps
    // it. Marks drawn inside the bar disappeared into the waveform exactly
    // where it was busiest, which is where a scale is most wanted.
    const tick = document.createElement("div")
    tick.className = isMajor ? "tick major" : "tick"
    tick.style.left = position + "%"
    axisEl.appendChild(tick)

    if (!isMajor) continue

    // Labelled intervals also get a gridline up the bar, so a time can be read
    // straight from the label to the part of the waveform above it. Not at
    // 0:00, where the line would land on the bar's own left edge.
    if (!atStart) {
      const gridline = document.createElement("div")
      gridline.className = "gridline"
      gridline.style.left = position + "%"
      ticksEl.appendChild(gridline)
    }

    // 0:00 is exempt from the edge test: rather than being dropped for sitting
    // at the very edge, it anchors its left side to the tick instead of
    // centring on it (see .atStart), so it reads fully inside the bar.
    const x = (position / 100) * width
    if (!atStart && (x < LABEL_EDGE_MARGIN || x > width - LABEL_EDGE_MARGIN)) {
      continue
    }
    const label = document.createElement("span")
    label.className = atStart ? "tickLabel atStart" : "tickLabel"
    label.style.left = position + "%"
    label.textContent = formatTime(seconds)
    axisEl.appendChild(label)
  }
}

// --- Pointer position -------------------------------------------------------

// The playback position a pointer at `clientX` refers to, in seconds, or null
// when there's nothing to point at (no track loaded, or a zero-width bar).
// Measured against the whole seek bar including the ruler strip, so pointing at
// a tick label means the same time as pointing at the waveform above it.
function positionAt(clientX: number): number | null {
  const progressEl = document.getElementById("progress")
  if (!progressEl) return null

  const rect = progressEl.getBoundingClientRect()
  const duration = audio ? audio.duration : NaN
  if (!rect.width || !isFinite(duration) || duration <= 0) return null

  const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  return fraction * duration
}

// --- Hover ghost ------------------------------------------------------------

// Show where a click would land and what time it corresponds to, without
// seeking there. Driven by pointermove on the whole seek bar, so it also
// tracks a drag in progress.
function updateGhost(clientX: number): void {
  const progressEl = document.getElementById("progress")
  const ghostEl = document.getElementById("waveformGhost")
  const ghostTimeEl = document.getElementById("waveformGhostTime")
  if (!progressEl || !ghostEl || !ghostTimeEl) return

  const seconds = positionAt(clientX)
  // Nothing loaded means no time to report, so there's nothing to show.
  if (seconds === null) {
    hideGhost()
    return
  }

  const fraction = seconds / audio.duration
  progressEl.classList.add("hovering")
  ghostEl.style.left = fraction * 100 + "%"
  ghostTimeEl.textContent = formatTime(seconds)
  // Near the right edge the readout would spill past the transport, so it
  // swaps to the other side of the line.
  ghostEl.classList.toggle("flipped", fraction > 0.85)
}

function hideGhost(): void {
  const progressEl = document.getElementById("progress")
  if (progressEl) progressEl.classList.remove("hovering")
}

// Seek to the pointer's position and play from there. Bound to double-click:
// a single click already seeks (that's the native range input), but leaves a
// paused track paused, so auditioning a spot otherwise means clicking the bar
// and then reaching for the play button. The second click is the "and go".
function playFrom(clientX: number): void {
  const seconds = positionAt(clientX)
  if (seconds === null || !audio.src) return

  // The 0.1s floor matches the drag handler: some browsers treat a seek to
  // exactly 0 as "not seeked yet" and ignore it.
  audio.currentTime = Math.max(0.1, seconds)
  playerUpdater()
  if (audio.paused) setPlayingState("playing")
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
          // The seek bar is the range input; the waveform is a sibling layer
          // painted behind it (see setWaveform and #waveform in player.css).
          // Keeping the native input means dragging, clicking and keyboard
          // seeking all keep working without being reimplemented.
          ["div#progress",
            ["div#waveform"],
            // Time ruler: gridlines over the waveform, labels in the strip
            // below it. Both are rebuilt by renderTimeRuler whenever the
            // duration or the available width changes.
            ["div#waveformTicks"],
            ["div#waveformAxis"],
            // Follows the pointer, reading out the time under it without
            // committing to a seek.
            ["div#waveformGhost", ["span#waveformGhostTime", ""]],
            ["input#progressInput",
              {type: "range", min: "0", max: "100", value: "0", step: "0.1",
               title: "Seek"}
            ]
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

    const progressEl = document.getElementById("progress")
    if (progressEl) {
      // Listening on the container rather than the input: pointer events over
      // the input bubble up here, and this way the ruler strip below the
      // waveform reports a time too.
      progressEl.addEventListener("pointermove", (event) => {
        updateGhost((event as PointerEvent).clientX)
      })
      progressEl.addEventListener("pointerleave", () => hideGhost())

      // Double-click anywhere on the bar starts playback from that point.
      progressEl.addEventListener("dblclick", (event) => {
        playFrom((event as MouseEvent).clientX)
      })
    }

    // The ruler's tick interval depends on how much room the transport has, so
    // it has to be rebuilt whenever the bar's width changes. Observing the bar
    // itself rather than the window catches every cause of that — the window
    // resizing, controls dropping out at a breakpoint, and the initial layout
    // settling after the transport is first built, which otherwise left the
    // ruler stuck at whatever interval suited the transient width. Playback
    // updates cover the other trigger (a new track's duration).
    if (progressEl && typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => renderTimeRuler()).observe(progressEl)
    }
    else {
      window.addEventListener("resize", () => renderTimeRuler())
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
  const progressEl = document.getElementById("progress")
  const progressInputEl = document.getElementById("progressInput") as HTMLInputElement

  if (!timeEl || !durationEl || !progressEl || !progressInputEl) {
    console.error("Player UI elements not found");
    return;
  }

  try {
    // Force update to ensure values are current
    timeEl.textContent = timeElapsed()
    durationEl.textContent = timeLeft()

    // --progress goes on the shared container so both layers see it: it is the
    // hard stop between the played and unplayed halves of the waveform's
    // gradient, and it positions the playhead.
    if (audio && !isNaN(audio.duration) && audio.duration > 0) {
      // Calculate normalized progress as percentage (0-100)
      const progress = Math.min(100, Math.max(0, (audio.currentTime / audio.duration) * 100))

      // Don't update slider if user is currently dragging it
      if (!isSeekingProgress) {
        progressInputEl.value = progress.toString()
      }
      progressEl.style.setProperty("--progress", progress + "%")

      // Debug information to help verify updates
      console.debug(`Player update: ${audio.currentTime.toFixed(1)}/${audio.duration.toFixed(1)}s (${progress.toFixed(1)}%)`)
    } else {
      // Reset progress bar if no valid audio
      progressInputEl.value = "0"
      progressEl.style.setProperty("--progress", "0%")
    }

    // Cheap when nothing changed: the ruler only rebuilds once a track's
    // duration is known, and again if the transport is resized.
    renderTimeRuler()
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

// m:ss for a number of seconds, flooring to whole seconds so the readout never
// runs ahead of the audio. Shared by the transport counters, the ruler's tick
// labels and the hover readout, so those can't drift into different formats.
// Anything unusable (no track loaded yet, a negative remainder) reads as 0:00.
function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) {
    return "0:00"
  }
  const s = Math.floor(seconds % 60)
  const m = Math.floor(seconds / 60)
  return (s < 10) ? (m + ":0" + s) : (m + ":" + s)
}

function timeLeft(): string {
  if (isNaN(audio.duration) || audio.duration === 0) {
    return "- 0:00"
  }
  return "- " + formatTime(Math.max(0, audio.duration - audio.currentTime))
}

function timeElapsed(): string {
  return formatTime(audio.currentTime)
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
