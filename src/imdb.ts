import type { TorrentSummary } from "./domain.ts"

export function createImdbSearchUrl(torrent: Pick<TorrentSummary, "name">): string {
  return `https://www.imdb.com/find/?q=${encodeURIComponent(torrent.name)}&s=tt`
}

export function createImdbUrl(torrent: Pick<TorrentSummary, "name" | "imdbId">): string {
  const imdbId = torrent.imdbId?.trim()
  if (imdbId && /^tt\d+$/i.test(imdbId)) return `https://www.imdb.com/title/${imdbId.toLowerCase()}/`
  return createImdbSearchUrl(torrent)
}
