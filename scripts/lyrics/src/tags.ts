// Write lyrics into audio file tags: MP4 `©lyr`, Vorbis `LYRICS`
// (FLAC, Ogg, Opus), ID3v2 `USLT` (MP3). These are the keys the server reads.

import taglib from "node-taglib-sharp"

const { File, TagTypes } = taglib

export function writeLyrics(path: string, lyrics: string): void {
  const file = File.createFromPath(path)
  try {
    const onDisk = file.tagTypesOnDisk
    // Setting lyrics on the combined tag lands in the tag that can hold them
    // (ID3v2 for MP3s, creating it if needed; ID3v1 has no lyrics field)
    file.tag.lyrics = lyrics
    // taglib-sharp also creates an ID3v1 tag on MP3s; don't add one
    if (!(onDisk & TagTypes.Id3v1)) {
      file.removeTags(TagTypes.Id3v1)
    }
    file.save()
  }
  finally {
    file.dispose()
  }
}
