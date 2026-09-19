import type { TorrentSummary } from "./domain.ts"
import { createMagnetUri } from "./magnet.ts"
import { sanitizeSingleLine } from "./text.ts"

export const exportColumns = ["id", "name", "seeders", "leechers", "size", "fileCount", "category", "username", "status", "addedAt"] as const

export function delimitedResults(torrents: readonly TorrentSummary[], format: "csv" | "tsv", includeMagnet = false, trackers?: readonly string[]): string {
  const delimiter = format === "csv" ? "," : "\t"
  const columns = [...exportColumns, ...(includeMagnet ? ["magnet"] : [])]
  const rows = torrents.map((torrent) => {
    const values = exportColumns.map((column) => torrent[column])
    return [...values, ...(includeMagnet ? [createMagnetUri(torrent, trackers)] : [])]
  })
  return [columns, ...rows].map((row) => row.map((value) => {
    if (value instanceof Date) return value.toISOString()
    if (typeof value === "number") return String(value)
    let text = sanitizeSingleLine(String(value))
    // Prevent spreadsheet formula execution when exported metadata is opened.
    if (/^\s*[=+@-]/u.test(text)) text = `'${text}`
    if (text.includes(delimiter) || /["\r\n]/u.test(text)) return `"${text.replaceAll('"', '""')}"`
    return text
  }).join(delimiter)).join("\n")
}
