// Type definitions
type Song = {
  id?: number
  title: string
  slug: string
  src: string
  // A single, display-ready credit line ("A, B, C").
  track_artist?: string
  // The individual credited artists, for rendering one link per artist.
  track_artists?: string[]
  artist_slug?: string
  lyrics?: string
  file_name?: string
  file_path?: string
  date_added?: string
  // Technical audio properties, present only on the single-song detail
  // response and only when known (the server omits unknown fields).
  duration_secs?: number
  bitrate_kbps?: number
  sample_rate_hz?: number
  bit_depth?: number
  channels?: number
  format?: string
  file_size?: number
}

type Artist = {
  name: string
  slug: string
  country?: string
  bio?: string
}

type ApiResponse<T> = {
  error?: boolean
  data?: T
}

// Song registry type
type SongRegistryEntry = {
  song: Song,
  artist: string
}

// A reference to a track inside a playlist, by (artist, title). The pair is
// stable across catalog rescans; tracks whose pair no longer matches a
// catalog entry come back with `available: false` and empty `src`/`slug`.
type TrackRef = {
  artist: string
  title: string
}

type PlaylistSummary = {
  id: string
  name: string
  track_count: number
  created_at: number
  updated_at: number
  // Present only when /playlists is queried with ?artist=&title= — lets the
  // add-to-playlist bubble disable playlists that already contain the song.
  contains_song?: boolean
}

type PlaylistTrack = {
  artist: string
  title: string
  available: boolean
  slug: string
  src: string
  artist_slug: string
  track_artist: string
  // The individual credited artists, for rendering one link per artist.
  track_artists?: string[]
  // ISO 8601 timestamp of when the track was added to the playlist, if known.
  added_at?: string
}

type Playlist = {
  id: string
  name: string
  created_at: number
  updated_at: number
  tracks: PlaylistTrack[]
}
