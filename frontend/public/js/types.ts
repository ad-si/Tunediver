// Type definitions
type Song = {
  id?: number
  title: string
  slug: string
  src: string
  track_artist?: string
  artist_slug?: string
  lyrics?: string
  file_name?: string
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
