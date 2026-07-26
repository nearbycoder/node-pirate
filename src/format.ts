import { categoryLabel, formatBytes, formatDate, sortDirection, type SortOrder, type TorrentSummary } from "./domain.ts"
import { fitToWidth, sanitizeSingleLine } from "./text.ts"

interface ResultColumn {
  key: SortOrder
  label: string
  width: number
}

export function truncate(value: string, width: number): string {
  return fitToWidth(value, width)
}

export function formatResultLine(torrent: TorrentSummary, width = 96): string {
  const seeders = String(torrent.seeders).padStart(5)
  const leechers = String(torrent.leechers).padStart(5)
  const size = formatBytes(torrent.size).padStart(9)
  const date = formatDate(torrent.addedAt)
  const category = categoryLabel(torrent.category).padEnd(5)
  return joinColumns(resultColumns(width), {
    category,
    name: torrent.name,
    seeders: `S ${seeders}`,
    leechers: `L ${leechers}`,
    size,
    date,
  })
}

export function formatResultHeader(
  width: number,
  activeSort: SortOrder,
  reversed = false,
): string {
  const arrow = sortDirection(activeSort, reversed) === "asc" ? "↑" : "↓"
  const values: Record<SortOrder, string> = {
    category: "Type",
    name: "Name",
    seeders: "Seeds",
    leechers: "Leech",
    size: "Size",
    date: "Date",
  }
  values[activeSort] = `${values[activeSort]}${arrow}`
  return joinColumns(resultColumns(width), values)
}

export function resultSortAtColumn(x: number, width: number): SortOrder | undefined {
  let offset = 0
  for (const column of resultColumns(width)) {
    if (x >= offset && x < offset + column.width) return column.key
    offset += column.width + 2
  }
  return undefined
}

export function resultSortColumns(width: number): SortOrder[] {
  return resultColumns(width).map((column) => column.key)
}

function resultColumns(width: number): ResultColumn[] {
  const safeWidth = Math.max(24, width)
  const columns: ResultColumn[] = []
  const add = (key: SortOrder, label: string, columnWidth: number): void => {
    columns.push({ key, label, width: columnWidth })
  }

  if (safeWidth >= 42) add("category", "Type", 5)
  const fixedWidths = safeWidth >= 80
    ? [7, 7, 9, 10]
    : safeWidth >= 58
      ? [7, 9, 10]
      : [7, 10]
  const fixedKeys: Array<[SortOrder, string]> = safeWidth >= 80
    ? [["seeders", "Seeds"], ["leechers", "Leech"], ["size", "Size"], ["date", "Date"]]
    : safeWidth >= 58
      ? [["seeders", "Seeds"], ["size", "Size"], ["date", "Date"]]
      : [["seeders", "Seeds"], ["date", "Date"]]
  const separators = (columns.length + fixedKeys.length) * 2
  const occupied = columns.reduce((sum, column) => sum + column.width, 0) + fixedWidths.reduce((sum, value) => sum + value, 0) + separators
  add("name", "Name", Math.max(1, safeWidth - occupied))
  fixedKeys.forEach(([key, label], index) => add(key, label, fixedWidths[index] ?? 1))
  return columns
}

function joinColumns(columns: readonly ResultColumn[], values: Record<SortOrder, string>): string {
  return columns.map((column) => truncate(values[column.key], column.width)).join("  ")
}

export function formatDetails(torrent: TorrentSummary): string {
  const id = sanitizeSingleLine(torrent.id)
  const infoHash = sanitizeSingleLine(torrent.infoHash)
  const name = sanitizeSingleLine(torrent.name)
  const status = sanitizeSingleLine(torrent.status)
  const username = sanitizeSingleLine(torrent.username)
  return [
    name,
    `ID ${id}  •  ${formatBytes(torrent.size)}  •  ${torrent.fileCount} file${torrent.fileCount === 1 ? "" : "s"}`,
    `Seeders ${torrent.seeders}  •  Leechers ${torrent.leechers}  •  Added ${formatDate(torrent.addedAt)}`,
    `Uploader ${username || "anonymous"}  •  Status ${status || "unknown"}`,
    `Hash ${infoHash}`,
  ].join("\n")
}
