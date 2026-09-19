export const categories = {
  all: 0,
  audio: 100,
  video: 200,
  movies: [201, 202, 207, 209],
  tv: [205, 208],
  applications: 300,
  app: 300,
  games: 400,
  other: 600,
} as const

export type CategoryName = keyof typeof categories
export type CategoryFilter = number | readonly number[]
export interface CategoryGroup {
  name: Exclude<CategoryName, "app">
  filter: CategoryFilter
  description: string
}
export const categoryGroups: readonly CategoryGroup[] = [
  { name: "all", filter: categories.all, description: "Every supported category" },
  { name: "audio", filter: categories.audio, description: "All audio categories" },
  { name: "movies", filter: categories.movies, description: "Movies, DVD, HD movies, and 3D movies" },
  { name: "tv", filter: categories.tv, description: "TV shows and HD TV shows" },
  { name: "video", filter: categories.video, description: "All video categories, including movies and TV" },
  { name: "applications", filter: categories.applications, description: "All application categories (alias: app)" },
  { name: "games", filter: categories.games, description: "All game categories" },
  { name: "other", filter: categories.other, description: "Books, comics, pictures, and other categories" },
]
export type SortOrder = "category" | "seeders" | "leechers" | "date" | "size" | "name"
export type SortDirection = "asc" | "desc"
export type TopPeriod = "day" | "week" | "all"

export interface TorrentSummary {
  id: string
  name: string
  infoHash: string
  leechers: number
  seeders: number
  size: number
  fileCount: number
  username: string
  addedAt: Date
  status: string
  category: number
  imdbId?: string
}

export interface TorrentDetails extends TorrentSummary {
  description: string
  language?: number
  textLanguage?: number
}

export interface SearchOptions {
  query: string
  category?: CategoryFilter
  sort?: SortOrder
  reverse?: boolean
  limit?: number
  signal?: AbortSignal
}

export interface SearchResponse {
  endpoint: string
  results: TorrentSummary[]
  /** Results available from the fetched API feeds before applying the caller's limit. */
  availableResults?: number
  /** Number fetched before CLI result filters, when filters are active. */
  unfilteredResults?: number
  partial?: boolean
  failedSources?: number
}

export interface TopOptions {
  period: TopPeriod
  category?: CategoryFilter
  sort?: SortOrder
  reverse?: boolean
  limit?: number
  signal?: AbortSignal
  refresh?: boolean
}

export interface DetailsResponse {
  endpoint: string
  torrent: TorrentDetails
}

export interface EndpointHealth {
  url: string
  ok: boolean
  latencyMs: number
  error?: string
}

export interface TorrentDataSource {
  readonly endpoints: readonly string[]
  search(options: SearchOptions): Promise<SearchResponse>
  top(options: TopOptions): Promise<SearchResponse>
  details(id: string, signal?: AbortSignal): Promise<DetailsResponse>
  health(): Promise<EndpointHealth[]>
}

export function parseCategory(value: string | undefined): CategoryFilter {
  if (!value) return categories.all

  const normalized = value.trim().toLowerCase()
  if (normalized.includes(",")) {
    const parts = normalized.split(",")
    if (parts.some((part) => !part.trim())) throw new Error("Category lists cannot contain empty entries.")
    const ids = [...new Set(parts.flatMap((part) => {
      const parsed = parseCategory(part)
      return typeof parsed === "number" ? [parsed] : [...parsed]
    }))]
    return ids.includes(0) ? 0 : ids
  }
  if (normalized in categories) return categories[normalized as CategoryName]

  if (/^\d{1,3}$/.test(normalized)) {
    const numeric = Number(normalized)
    if (numeric <= 999) return numeric
  }

  throw new Error(`Unknown category "${value}". Use all, audio, video, movies, tv, applications, app, games, other, or a numeric Pirate Bay category.`)
}

export function parseSort(value: string | undefined): SortOrder {
  switch (value?.trim().toLowerCase()) {
    case undefined:
    case "s":
    case "seed":
    case "seeds":
    case "seeders":
      return "seeders"
    case "l":
    case "leech":
    case "leeches":
    case "leechers":
      return "leechers"
    case "date":
    case "added":
      return "date"
    case "size":
      return "size"
    case "name":
      return "name"
    case "category":
    case "type":
      return "category"
    default:
      throw new Error(`Unknown sort order "${value}". Use category, seeders, leechers, date, size, or name.`)
  }
}

export function parseTopPeriod(value: string | undefined): TopPeriod {
  switch (value?.trim().toLowerCase()) {
    case undefined:
    case "day":
    case "daily":
    case "24h":
      return "day"
    case "week":
    case "weekly":
    case "7d":
      return "week"
    case "all":
      return "all"
    default:
      throw new Error(`Unknown top period "${value}". Use day or 24h, week or 7d, or all.`)
  }
}

export function sortTorrents(results: readonly TorrentSummary[], sort: SortOrder, reverse = false): TorrentSummary[] {
  const sorted = [...results].sort((left, right) => {
    switch (sort) {
      case "seeders":
        return right.seeders - left.seeders
      case "leechers":
        return right.leechers - left.leechers
      case "date":
        return right.addedAt.getTime() - left.addedAt.getTime()
      case "size":
        return right.size - left.size
      case "name":
        return left.name.localeCompare(right.name)
      case "category":
        return left.category - right.category || left.name.localeCompare(right.name)
    }
  })
  return reverse ? sorted.reverse() : sorted
}

export function sortDirection(sort: SortOrder, reverse = false): SortDirection {
  const defaultAscending = sort === "name" || sort === "category"
  return (reverse ? !defaultAscending : defaultAscending) ? "asc" : "desc"
}

export function reverseForSortDirection(sort: SortOrder, direction: SortDirection): boolean {
  return sortDirection(sort) !== direction
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

export function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return "unknown"
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${month}/${day}/${date.getFullYear()}`
}

export function categoryLabel(category: number): string {
  if ([201, 202, 207, 209].includes(category)) return "Movie"
  if ([205, 208].includes(category)) return "TV"
  if (category === 203) return "Music"
  if (category === 204) return "Clips"
  const group = Math.floor(category / 100) * 100
  return group === 100
    ? "Audio"
    : group === 200
      ? "Video"
      : group === 300
        ? "Apps"
        : group === 400
          ? "Games"
          : group === 600
            ? "Other"
            : "Any"
}
