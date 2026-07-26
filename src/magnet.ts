import type { TorrentSummary } from "./domain.ts"
import { sanitizeSingleLine } from "./text.ts"

const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
]

export function createMagnetUri(
  torrent: Pick<TorrentSummary, "infoHash" | "name">,
  trackers: readonly string[] = DEFAULT_TRACKERS,
): string {
  const infoHash = torrent.infoHash.trim().toUpperCase()
  if (!/^[A-F0-9]{40}$/.test(infoHash)) throw new Error("A magnet link requires a 40-character hexadecimal info hash.")

  const name = sanitizeSingleLine(torrent.name)
  const parameters = [
    `xt=urn:btih:${infoHash}`,
    `dn=${encodeURIComponent(name)}`,
    ...[...new Set(trackers)]
      .map((tracker) => sanitizeSingleLine(tracker))
      .filter(Boolean)
      .map((tracker) => `tr=${encodeURIComponent(tracker)}`),
  ]
  return `magnet:?${parameters.join("&")}`
}

export function isMagnetUri(value: string): boolean {
  return /^magnet:\?xt=urn:btih:[a-f0-9]{40}(?:&|$)/i.test(value)
}
