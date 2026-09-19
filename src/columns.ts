import { categoryLabel, formatBytes, formatDate, type TorrentSummary } from "./domain.ts"
import { displayWidth, fitToWidth, sanitizeSingleLine } from "./text.ts"

export const tableColumns = ["id", "name", "seeders", "leechers", "size", "files", "category", "uploader", "status", "date", "hash"] as const
export type TableColumn = typeof tableColumns[number]

export function parseColumns(value: string): TableColumn[] {
  const columns = value.split(",").map((column) => column.trim().toLowerCase())
  if (columns.some((column) => !(tableColumns as readonly string[]).includes(column))) {
    throw new Error(`Unknown table column. Choose from: ${tableColumns.join(", ")}.`)
  }
  if (new Set(columns).size !== columns.length) throw new Error("Table columns must not contain duplicates.")
  return columns as TableColumn[]
}

export function customTable(torrents: readonly TorrentSummary[], columns: readonly TableColumn[], width: number): string {
  const rows = torrents.map((torrent) => columns.map((column) => {
    const values: Record<TableColumn, string | number> = {
      id: torrent.id, name: torrent.name, seeders: torrent.seeders, leechers: torrent.leechers,
      size: formatBytes(torrent.size), files: torrent.fileCount, category: categoryLabel(torrent.category),
      uploader: torrent.username, status: torrent.status, date: formatDate(torrent.addedAt), hash: torrent.infoHash,
    }
    return sanitizeSingleLine(String(values[column]))
  }))
  const widths = columns.map((column, index) => Math.min(column === "name" ? 60 : 40,
    Math.max(column.length, ...rows.map((row) => displayWidth(row[index]!)))))
  const budget = Math.max(columns.length, width - (columns.length - 1) * 2)
  while (widths.reduce((total, value) => total + value, 0) > budget) {
    const largest = widths.indexOf(Math.max(...widths))
    widths[largest] = widths[largest]! - 1
  }
  return [columns, ...rows].map((row) => row.map((cell, index) => fitToWidth(cell, widths[index]!)).join("  ")).join("\n")
}
