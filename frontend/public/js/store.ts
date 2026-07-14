// A tiny reactive store.
//
// The app used to keep its playback and view state in a dozen free-floating
// `let`s, and every mutation had to remember to call the right DOM-sync
// function afterwards (updatePlayingMarkers, the #play button class, the
// shuffle/repeat button state, the media-session state, …). That "mutate
// here, re-sync over there" split was the main source of the spaghetti.
//
// Here state lives in one object. Writing a field notifies whatever effects
// subscribed to that field, so the DOM re-syncs itself. This is deliberately
// coarse (an effect re-runs a whole update function, it doesn't patch a single
// node) — for an app this size that's plenty, and it needs no build-step or
// dependency change: the file is a plain global script like the others.

type PlayState = "playing" | "paused"
type RepeatMode = "off" | "all" | "one"
type Tab = "artists" | "songs" | "playlists"

// How an open playlist's tracks are ordered for display. "index" keeps the
// stored playlist order; the "added-*" modes sort by the per-track Added At
// timestamp. Sorting only affects rendering — each row still carries its
// original playlist index so play/remove target the correct backend position.
type PlaylistSort = "index" | "added-asc" | "added-desc"

// Which track is loaded in the player, so matching artist (c2) and song (c3)
// rows can be marked as playing. When playback started from a playlist,
// `playlistId` + `playlistIndex` are set so prev/next can step through that
// playlist rather than guessing from `currentTab`.
interface PlayingRef {
  artistSlug: string
  songSlug: string
  playlistId?: string
  playlistIndex?: number
}

// Catalog data backing the global search, fetched once when a search session
// starts and reused while the user types.
interface SearchCatalog {
  artists: Artist[]
  songs: Song[]
  playlists: PlaylistSummary[]
}

interface AppState {
  // --- Playback (reactive: effects mirror these onto the player UI) --------

  currentlyPlaying: PlayingRef | null
  // Mirrors the <audio> element's play/pause so UI can react to it. Driven by
  // the audio "play"/"pause"/"ended" events (see attachAudioListeners); the
  // #play button, media-session state, and row markers subscribe to it.
  playState: PlayState
  // When true, prev/next and auto-advance pick a random track from the active
  // context instead of the sequential neighbour.
  shuffleEnabled: boolean
  // "off" stops at the end of the list; "all" wraps; "one" replays the track.
  repeatMode: RepeatMode

  // --- View / navigation ---------------------------------------------------

  // Drives neighbour navigation when no playlist context is set on
  // currentlyPlaying: "artists" steps the current artist's songs, "songs" the
  // flat all-songs list, "playlists" the active playlist.
  currentTab: Tab
  // The playlist currently rendered in c3, so its row handlers can reference it.
  currentPlaylistId: string | null
  playlistSort: PlaylistSort

  // --- Global search session ----------------------------------------------

  // null when no search is active or the cached data was invalidated (query
  // cleared, a scan finished, or playlists mutated).
  searchCatalog: SearchCatalog | null
  searchCatalogLoading: boolean
  // Last query handleSearchInput acted on, so keyups that didn't change the
  // value (arrow keys, modifiers) don't re-render or re-route.
  lastSearchQuery: string
}

type StoreListener = () => void

// Per-key subscriptions over a plain state object. A write through the proxy
// runs every listener registered for the written key, but only when the value
// actually changes — so idempotent writes (setting playState to what it
// already is) are free and won't loop.
function createStore<T extends object>(initial: T): {
  state: T
  subscribe: (keys: (keyof T)[], fn: StoreListener) => void
} {
  const subs = new Map<keyof T, Set<StoreListener>>()

  const state = new Proxy(initial, {
    set(target: T, key: string | symbol, value: unknown): boolean {
      const prev = (target as Record<string | symbol, unknown>)[key]
      ;(target as Record<string | symbol, unknown>)[key] = value
      if (prev !== value) {
        const listeners = subs.get(key as keyof T)
        if (listeners) listeners.forEach((fn) => fn())
      }
      return true
    },
  })

  const subscribe = (keys: (keyof T)[], fn: StoreListener): void => {
    keys.forEach((key) => {
      let listeners = subs.get(key)
      if (!listeners) {
        listeners = new Set<StoreListener>()
        subs.set(key, listeners)
      }
      listeners.add(fn)
    })
  }

  return { state, subscribe }
}

const _store = createStore<AppState>({
  currentlyPlaying: null,
  playState: "paused",
  shuffleEnabled: false,
  repeatMode: "off",
  currentTab: "artists",
  currentPlaylistId: null,
  playlistSort: "added-desc",
  searchCatalog: null,
  searchCatalogLoading: false,
  lastSearchQuery: "",
})

// The single source of truth. Read fields off it, and assign to a field to
// trigger the effects subscribed to that field: `store.playState = "playing"`.
const store = _store.state

// Register a reactive effect: run `fn` now, and again whenever any of `keys`
// changes. Note that `fn` reads current values off `store` itself — the keys
// only declare what the effect depends on, they aren't passed in.
function effect(keys: (keyof AppState)[], fn: StoreListener): void {
  _store.subscribe(keys, fn)
  fn()
}
