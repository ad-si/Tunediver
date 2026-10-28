// A playlist track whose file has no lyrics yet
export interface Track {
  path: string,
  title: string,
  artists: string[],
  durationSecs: number,
}

export type LookupStatus = "synced" | "plain" | "instrumental" | "none"

export interface Lookup {
  status: LookupStatus,
  source: string,
  // "Artist - Title (duration)" or a URL, for auditing matches
  match?: string,
  lyrics?: string,
}

export interface LyricsSource {
  name: string,
  find(track: Track): Promise<Lookup>,
  close?(): Promise<void>,
}
