import { matchesCategory, parseCategory, type CategoryFilter, type SearchResponse, type TorrentSummary } from "./domain.ts"

export interface ResultFilters {
  newerThan?: string
  excludeCategory?: CategoryFilter
  includeAny?: string[]
  include?: string[]
  exclude?: string[]
  minSeeders?: number
  minSize?: number
  maxSize?: number
  excludeUploader?: string[]
  uploader?: string
  trusted?: boolean
  after?: string
  before?: string
}

export interface FilterOptions {
  maxAge?: string
  excludeCategory?: string
  includeAny?: string[]
  include?: string[]
  exclude?: string[]
  minSeeders?: string
  minSize?: string
  maxSize?: string
  excludeUploader?: string[]
  uploader?: string
  trusted?: boolean
  after?: string
  before?: string
}

export function parseSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|[KMGT]i?B)?$/i.exec(value.trim())
  if (!match) throw new Error(`Invalid size "${value}". Use bytes or a unit such as 500MB, 1.5GB, or 2GiB.`)
  const unit = (match[2] ?? "B").toUpperCase()
  const power = unit === "B" ? 0 : "KMGT".indexOf(unit[0]!) + 1
  const bytes = Number(match[1]) * (unit.includes("I") ? 1024 : 1000) ** power
  if (!Number.isFinite(bytes) || bytes > Number.MAX_SAFE_INTEGER) throw new Error("Size is too large.")
  return Math.ceil(bytes)
}

function parseDate(value: string, label: string): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid date in YYYY-MM-DD format.`)
  }
  return value
}

export function parseFilters(options: FilterOptions, now = Date.now()): ResultFilters {
  const filters: ResultFilters = {}
  if (options.maxAge !== undefined) {
    const match = /^(\d+(?:\.\d+)?)(h|d|w)$/i.exec(options.maxAge.trim())
    const multiplier = match ? { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]!.toLowerCase()]! : 0
    const age = match ? Number(match[1]) * multiplier : 0
    if (!Number.isFinite(age) || age <= 0 || !Number.isFinite(new Date(now - age).getTime())) {
      throw new Error("--max-age must be a positive duration such as 12h, 7d, or 2w.")
    }
    filters.newerThan = new Date(now - age).toISOString()
  }
  if (options.excludeCategory !== undefined) filters.excludeCategory = parseCategory(options.excludeCategory)
  for (const key of ["include", "includeAny", "exclude", "excludeUploader"] as const) {
    if (options[key]) {
      const terms = options[key].map((term) => term.trim())
      if (terms.some((term) => !term)) throw new Error(`--${key} requires non-empty text.`)
      filters[key] = terms
    }
  }
  if (options.minSeeders !== undefined) {
    const number = Number(options.minSeeders)
    if (!/^\d+$/.test(options.minSeeders) || !Number.isSafeInteger(number)) throw new Error("min-seeders must be zero or a positive integer.")
    filters.minSeeders = number
  }
  if (options.minSize !== undefined) filters.minSize = parseSize(options.minSize)
  if (options.maxSize !== undefined) filters.maxSize = parseSize(options.maxSize)
  if (filters.minSize !== undefined && filters.maxSize !== undefined && filters.minSize > filters.maxSize) {
    throw new Error("--min-size cannot exceed --max-size.")
  }
  if (options.uploader !== undefined) {
    filters.uploader = options.uploader.trim()
    if (!filters.uploader) throw new Error("--uploader requires a non-empty name.")
  }
  if (options.trusted) filters.trusted = true
  if (options.after !== undefined) filters.after = parseDate(options.after, "--after")
  if (options.before !== undefined) filters.before = parseDate(options.before, "--before")
  if (filters.after && filters.before && filters.after > filters.before) throw new Error("--after cannot be later than --before.")
  return filters
}

function matches(torrent: TorrentSummary, filters: ResultFilters): boolean {
  const name = torrent.name.toLowerCase()
  return (filters.excludeCategory === undefined || !matchesCategory(torrent.category, filters.excludeCategory))
    && (filters.include ?? []).every((term) => name.includes(term.toLowerCase()))
    && (!filters.includeAny?.length || filters.includeAny.some((term) => name.includes(term.toLowerCase())))
    && !(filters.exclude ?? []).some((term) => name.includes(term.toLowerCase()))
    && (filters.minSeeders === undefined || torrent.seeders >= filters.minSeeders)
    && (filters.minSize === undefined || torrent.size >= filters.minSize)
    && (filters.maxSize === undefined || torrent.size <= filters.maxSize)
    && (filters.uploader === undefined || torrent.username.toLowerCase() === filters.uploader.toLowerCase())
    && !(filters.excludeUploader ?? []).some((name) => torrent.username.toLowerCase() === name.toLowerCase())
    && (!filters.trusted || ["trusted", "vip"].includes(torrent.status.toLowerCase()))
    && (filters.newerThan === undefined || torrent.addedAt.getTime() >= Date.parse(filters.newerThan))
    && (filters.after === undefined || torrent.addedAt.getTime() >= Date.parse(`${filters.after}T00:00:00Z`))
    && (filters.before === undefined || torrent.addedAt.getTime() < Date.parse(`${filters.before}T00:00:00Z`) + 86_400_000)
}

export function filterResponse(response: SearchResponse, filters: ResultFilters, limit: number): SearchResponse {
  const results = response.results.filter((torrent) => matches(torrent, filters))
  return {
    ...response,
    results: limit === 0 ? results : results.slice(0, limit),
    availableResults: results.length,
    ...(Object.keys(filters).length ? { unfilteredResults: response.results.length } : {}),
  }
}
