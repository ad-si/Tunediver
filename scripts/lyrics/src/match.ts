// Fuzzy comparison of titles and artist names across catalogs

// Lowercase ASCII letters and digits only, without bracketed parts,
// " - Suffix" parts, and "feat." credits
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\s-\s.*$/, "")
    .replace(/\b(feat|ft)\.?\s.*$/, "")
    .replace(/[^a-z0-9]/g, "")
}

// Title without bracketed parts or " - Remix"-style suffixes, for searching
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[([][^)\]]*[)\]]/g, "")
    .replace(/\s+-\s+.*$/, "")
    .trim()
}

export function titlesMatch(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}

// True if any of our artists appears in the candidate's (possibly combined)
// artist credit, or the credit is contained in one of our artists
export function artistsMatch(ours: string[], theirs: string): boolean {
  const credit = normalize(theirs)
  if (!credit) return false
  return ours
    .map(normalize)
    .filter(Boolean)
    .some(artist => credit.includes(artist) || artist.includes(credit))
}

export function stripTimestamps(lrc: string): string {
  return lrc.replace(/^\[\d+:\d+(?:\.\d+)?\] ?/gm, "")
}
