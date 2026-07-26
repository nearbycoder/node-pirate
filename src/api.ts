import { Buffer } from "node:buffer"
import {
  sortTorrents,
  type CategoryFilter,
  type DetailsResponse,
  type EndpointHealth,
  type SearchOptions,
  type SearchResponse,
  type TopOptions,
  type TorrentDataSource,
  type TorrentDetails,
  type TorrentSummary,
} from "./domain.ts"
import { sanitizeMultiline, sanitizeSingleLine } from "./text.ts"
import { USER_AGENT } from "./version.ts"

export const DEFAULT_ENDPOINTS = ["https://apibay.org/"] as const

type Fetch = typeof globalThis.fetch

interface ApiBayClientOptions {
  endpoints?: readonly string[]
  timeoutMs?: number
  fetch?: Fetch
  feedCacheTtlMs?: number
  now?: () => number
}

interface EndpointStats {
  failures: number
  successes: number
  lastError?: string
  lastLatencyMs?: number
}

interface FeedCacheEntry {
  expiresAt: number
  response: { endpoint: string; value: TorrentSummary[] }
}

export class EndpointPoolError extends Error {
  readonly operation: string
  readonly failures: ReadonlyArray<{ endpoint: string; error: string }>

  constructor(operation: string, failures: Array<{ endpoint: string; error: string }>) {
    const safeFailures = failures.map(({ endpoint, error }) => ({
      endpoint: redactEndpoint(endpoint),
      error: redactUrlCredentialsInText(error),
    }))
    super(`${operation} failed on every configured endpoint: ${safeFailures.map(({ endpoint, error }) => `${endpoint} (${error})`).join("; ")}`)
    this.name = "EndpointPoolError"
    this.operation = operation
    this.failures = safeFailures
  }
}

export class ApiBayClient implements TorrentDataSource {
  readonly endpoints: readonly string[]
  readonly stats = new Map<string, EndpointStats>()
  readonly #fetch: Fetch
  readonly #timeoutMs: number
  readonly #feedCacheTtlMs: number
  readonly #now: () => number
  readonly #feedCache = new Map<string, FeedCacheEntry>()
  #preferredIndex = 0

  constructor(options: ApiBayClientOptions = {}) {
    const candidates = options.endpoints?.length ? options.endpoints : DEFAULT_ENDPOINTS
    this.endpoints = [...new Set(candidates.map(normalizeEndpoint))]
    if (this.endpoints.length === 0) throw new Error("At least one API endpoint is required.")

    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? 8_000
    this.#feedCacheTtlMs = options.feedCacheTtlMs ?? 120_000
    this.#now = options.now ?? Date.now
    for (const endpoint of this.endpoints) this.stats.set(endpoint, { failures: 0, successes: 0 })
  }

  async search(options: SearchOptions): Promise<SearchResponse> {
    const query = options.query.trim()
    if (!query) throw new Error("Search query cannot be empty.")

    const requests = categoryValues(options.category ?? 0).map((category) => this.#request(
        "search",
        "q.php",
        { q: query, cat: String(category) },
        parseSearchPayload,
        options.signal,
      ))
    const settled = await Promise.allSettled(requests)
    options.signal?.throwIfAborted()
    const successful = settled.filter((result): result is PromiseFulfilledResult<{ endpoint: string; value: TorrentSummary[] }> => result.status === "fulfilled")
    if (successful.length === 0) throw firstRejection(settled)
    const merged = successful.flatMap((result) => result.value.value)
    const failedSources = settled.length - successful.length
    const sorted = sortTorrents(dedupeTorrents(merged), options.sort ?? "seeders", options.reverse)
    const limit = options.limit === 0 ? sorted.length : Math.max(1, options.limit ?? 100)
    return {
      endpoint: successful[0]!.value.endpoint,
      results: sorted.slice(0, limit),
      availableResults: sorted.length,
      ...(failedSources ? { partial: true, failedSources } : {}),
    }
  }

  async top(options: TopOptions): Promise<SearchResponse> {
    const category = options.category ?? 0
    const primaryCategories = options.period === "all" && categoryValues(category).length === 1 && categoryValues(category)[0] === 0
      ? recentCategoryValues(category)
      : categoryValues(category)
    const primaryPaths = options.period === "day"
      ? ["precompiled/data_top100_48h.json"]
      : primaryCategories.map((value) => `precompiled/data_top100_${value || "all"}.json`)
    const supplements = options.period === "day"
      ? ["precompiled/data_top100_recent.json"]
      : options.period === "week"
        ? ["precompiled/data_top100_48h.json", "precompiled/data_top100_recent.json"]
        : []
    const feedRequests: Array<{ path: string; params: Record<string, string> }> = [
      ...primaryPaths.map((path) => ({ path, params: {} })),
      ...supplements
        .filter((path) => !primaryPaths.includes(path))
        .map((path) => ({ path, params: {} })),
      ...(options.period === "week"
        ? recentCategoryValues(category).map((categoryId) => ({
          path: "q.php",
          params: { q: `category:${categoryId}:0`, cat: "0" },
        }))
        : []),
    ]
    const settled = await Promise.allSettled(feedRequests.map(({ path, params }) => this.#feed(
      path,
      params,
      options.signal,
      options.refresh ?? false,
    )))
    options.signal?.throwIfAborted()
    const successful = settled
      .filter((result): result is PromiseFulfilledResult<{ endpoint: string; value: TorrentSummary[] }> => result.status === "fulfilled")
      .map((result) => result.value)
    if (successful.length === 0) throw firstRejection(settled)
    const failedSources = settled.length - successful.length
    const endpoint = successful[0]!.endpoint
    const merged = successful.flatMap((response) => response.value)

    const cutoff = options.period === "all"
      ? Number.NEGATIVE_INFINITY
      : this.#now() - (options.period === "day" ? 24 : 7 * 24) * 60 * 60 * 1_000
    const unique = new Map<string, TorrentSummary>()
    for (const torrent of merged) {
      if (torrent.addedAt.getTime() < cutoff || !matchesCategory(torrent.category, category)) continue
      const existing = unique.get(torrent.infoHash)
      if (!existing || torrent.seeders > existing.seeders) unique.set(torrent.infoHash, torrent)
    }

    const sorted = sortTorrents([...unique.values()], options.sort ?? "seeders", options.reverse)
    const limit = options.limit === undefined ? sorted.length : Math.max(1, options.limit)
    return {
      endpoint,
      results: sorted.slice(0, limit),
      availableResults: sorted.length,
      ...(failedSources ? { partial: true, failedSources } : {}),
    }
  }

  async details(id: string, signal?: AbortSignal): Promise<DetailsResponse> {
    if (!/^\d+$/.test(id)) throw new Error(`Torrent ID must be numeric, received "${id}".`)
    const { endpoint, value } = await this.#request("details", "t.php", { id }, parseDetailsPayload, signal)
    if (value.id === "0") throw new Error(`Torrent ${id} was not found.`)
    return { endpoint, torrent: value }
  }

  async health(): Promise<EndpointHealth[]> {
    return Promise.all(
      this.endpoints.map(async (endpoint): Promise<EndpointHealth> => {
        const startedAt = performance.now()
        try {
          const value = await this.#fetchJson(endpoint, "q.php", { q: "__node_pirate_healthcheck__", cat: "0" })
          parseSearchPayload(value)
          return { url: redactEndpoint(endpoint), ok: true, latencyMs: Math.round(performance.now() - startedAt) }
        } catch (error) {
          return {
            url: redactEndpoint(endpoint),
            ok: false,
            latencyMs: Math.round(performance.now() - startedAt),
            error: redactUrlCredentialsInText(errorMessage(error)),
          }
        }
      }),
    )
  }

  async #feed(
    path: string,
    params: Record<string, string>,
    signal: AbortSignal | undefined,
    refresh: boolean,
  ): Promise<{ endpoint: string; value: TorrentSummary[] }> {
    signal?.throwIfAborted()
    const key = feedCacheKey(path, params)
    const cached = this.#feedCache.get(key)
    if (!refresh && cached && cached.expiresAt > this.#now()) return cached.response

    const response = await this.#request("top feed", path, params, parseSearchPayload, signal)
    if (this.#feedCacheTtlMs > 0) {
      this.#feedCache.set(key, { expiresAt: this.#now() + this.#feedCacheTtlMs, response })
    }
    return response
  }

  async #request<T>(
    operation: string,
    path: string,
    params: Record<string, string>,
    parse: (payload: unknown) => T,
    signal?: AbortSignal,
  ): Promise<{ endpoint: string; value: T }> {
    const failures: Array<{ endpoint: string; error: string }> = []

    for (let offset = 0; offset < this.endpoints.length; offset += 1) {
      const index = (this.#preferredIndex + offset) % this.endpoints.length
      const endpoint = this.endpoints[index]
      if (!endpoint) continue
      const startedAt = performance.now()

      try {
        const payload = await this.#fetchJson(endpoint, path, params, signal)
        const value = parse(payload)
        const stats = this.stats.get(endpoint)!
        stats.successes += 1
        stats.lastLatencyMs = Math.round(performance.now() - startedAt)
        delete stats.lastError
        this.#preferredIndex = index
        return { endpoint: redactEndpoint(endpoint), value }
      } catch (error) {
        if (signal?.aborted) throw error
        const message = redactUrlCredentialsInText(errorMessage(error))
        const stats = this.stats.get(endpoint)!
        stats.failures += 1
        stats.lastError = message
        stats.lastLatencyMs = Math.round(performance.now() - startedAt)
        failures.push({ endpoint: redactEndpoint(endpoint), error: message })
      }
    }

    throw new EndpointPoolError(operation, failures)
  }

  async #fetchJson(
    endpoint: string,
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path, endpoint)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const authorization = extractBasicAuthorization(url)

    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.#fetch(url, {
        signal: combinedSignal,
        redirect: "follow",
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          ...(authorization ? { authorization } : {}),
        },
      })
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new Error(`request timed out after ${this.#timeoutMs} ms`)
      throw error
    }

    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    const contentType = response.headers.get("content-type") ?? ""
    let body: string
    try {
      body = await response.text()
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new Error(`request timed out after ${this.#timeoutMs} ms`)
      throw error
    }
    try {
      return JSON.parse(body) as unknown
    } catch {
      if (!contentType.includes("json")) {
        throw new Error(`expected JSON but received ${contentType || "an unknown content type"}`)
      }
      throw new Error("endpoint returned invalid JSON")
    }
  }
}

export function normalizeEndpoint(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Invalid endpoint URL "${redactEndpoint(value)}".`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Endpoint ${redactEndpoint(value)} must use http or https.`)
  }
  url.hash = ""
  url.search = ""
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url.toString()
}

export function redactEndpoint(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    return url.toString()
  } catch {
    return redactUrlCredentialsInText(value)
  }
}

export function parseSearchPayload(payload: unknown): TorrentSummary[] {
  if (!Array.isArray(payload)) throw new Error("search response is not an array")
  return payload
    .map(parseSummary)
    .filter((torrent): torrent is TorrentSummary => torrent !== null && torrent.id !== "0")
}

export function parseDetailsPayload(payload: unknown): TorrentDetails {
  const summary = parseSummary(payload)
  if (!summary) throw new Error("details response is not a valid torrent object")
  const object = payload as Record<string, unknown>
  return {
    ...summary,
    description: sanitizeMultiline(decodeEntities(stringValue(object.descr))),
    ...optionalNumber("language", object.language),
    ...optionalNumber("textLanguage", object.textlanguage),
  }
}

function parseSummary(payload: unknown): TorrentSummary | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const object = payload as Record<string, unknown>
  const id = stringValue(object.id)
  const name = sanitizeSingleLine(decodeEntities(stringValue(object.name)))
  const infoHash = stringValue(object.info_hash).toUpperCase()

  if (!id || !name || !/^[A-F0-9]{40}$/.test(infoHash)) return null

  const imdbId = sanitizeSingleLine(stringValue(object.imdb))
  return {
    id,
    name,
    infoHash,
    leechers: numberValue(object.leechers),
    seeders: numberValue(object.seeders),
    size: numberValue(object.size),
    fileCount: numberValue(object.num_files),
    username: sanitizeSingleLine(decodeEntities(stringValue(object.username))),
    addedAt: new Date(numberValue(object.added) * 1_000),
    status: sanitizeSingleLine(stringValue(object.status)),
    category: numberValue(object.category),
    ...(imdbId ? { imdbId } : {}),
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : ""
}

function numberValue(value: unknown): number {
  const parsed = Number(stringValue(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function optionalNumber<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const parsed = numberValue(value)
  return parsed ? ({ [key]: parsed } as { [P in K]?: number }) : {}
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " " }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return named[entity.toLowerCase()] ?? match
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function extractBasicAuthorization(url: URL): string | undefined {
  if (!url.username && !url.password) return undefined
  const username = decodeUrlCredential(url.username)
  const password = decodeUrlCredential(url.password)
  url.username = ""
  url.password = ""
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`
}

function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function redactUrlCredentialsInText(value: string): string {
  return value.replace(/(https?:\/\/)[^/@\s]+@/giu, "$1")
}

function matchesCategory(torrentCategory: number, requestedCategory: CategoryFilter): boolean {
  return categoryValues(requestedCategory).some((category) => {
    if (category === 0) return true
    if (category % 100 === 0) return Math.floor(torrentCategory / 100) === category / 100
    return torrentCategory === category
  })
}

function categoryValues(category: CategoryFilter): readonly number[] {
  return Array.isArray(category) ? category : [category as number]
}

function recentCategoryValues(category: CategoryFilter): readonly number[] {
  const values = categoryValues(category)
  return values.length === 1 && values[0] === 0 ? [100, 200, 300, 400, 600] : values
}

function dedupeTorrents(torrents: readonly TorrentSummary[]): TorrentSummary[] {
  const unique = new Map<string, TorrentSummary>()
  for (const torrent of torrents) {
    const existing = unique.get(torrent.infoHash)
    if (!existing || torrent.seeders > existing.seeders) unique.set(torrent.infoHash, torrent)
  }
  return [...unique.values()]
}

function feedCacheKey(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(Object.entries(params).sort(([left], [right]) => left.localeCompare(right))).toString()
  return query ? `${path}?${query}` : path
}

function firstRejection(results: readonly PromiseSettledResult<unknown>[]): Error {
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (!rejected) return new Error("Every configured source failed without reporting an error.")
  return rejected.reason instanceof Error ? rejected.reason : new Error(String(rejected.reason))
}
