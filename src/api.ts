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

// These limits keep a compromised API endpoint from turning a metadata request
// into unbounded terminal, parser, memory, or CPU work.
const MAX_TORRENT_ID_LENGTH = 20
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_SEARCH_RESULTS = 5_000
const MAX_REDIRECTS = 3
const MAX_NAME_LENGTH = 512
const MAX_USERNAME_LENGTH = 128
const MAX_STATUS_LENGTH = 64
const MAX_IMDB_ID_LENGTH = 32
const MAX_DESCRIPTION_LENGTH = 64 * 1024
const MAX_DIAGNOSTIC_LENGTH = 1_024
const MIN_TORRENT_TIMESTAMP_SECONDS = 946_684_800 // 2000-01-01T00:00:00Z
const MAX_TORRENT_TIMESTAMP_SECONDS = 4_102_444_800 // 2100-01-01T00:00:00Z
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

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
      error: safeDiagnostic(error),
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
  readonly #requestEndpoints: readonly string[]
  readonly #fetch: Fetch
  readonly #timeoutMs: number
  readonly #feedCacheTtlMs: number
  readonly #now: () => number
  readonly #feedCache = new Map<string, FeedCacheEntry>()
  #preferredIndex = 0

  constructor(options: ApiBayClientOptions = {}) {
    const candidates = options.endpoints?.length ? options.endpoints : DEFAULT_ENDPOINTS
    this.#requestEndpoints = Object.freeze([...new Set(candidates.map(normalizeEndpoint))])
    if (this.#requestEndpoints.length === 0) throw new Error("At least one API endpoint is required.")
    this.endpoints = Object.freeze(this.#requestEndpoints.map(redactEndpoint))

    this.#fetch = options.fetch ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? 8_000
    this.#feedCacheTtlMs = options.feedCacheTtlMs ?? 120_000
    this.#now = options.now ?? Date.now
    for (const endpoint of this.endpoints) {
      if (!this.stats.has(endpoint)) this.stats.set(endpoint, { failures: 0, successes: 0 })
    }
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
    if (!isTorrentId(id)) {
      throw new Error(`Torrent ID must contain 1-${MAX_TORRENT_ID_LENGTH} ASCII digits.`)
    }
    const { endpoint, value } = await this.#request("details", "t.php", { id }, parseDetailsPayload, signal)
    if (value.id === "0") throw new Error(`Torrent ${id} was not found.`)
    return { endpoint, torrent: value }
  }

  async health(): Promise<EndpointHealth[]> {
    return Promise.all(
      this.#requestEndpoints.map(async (endpoint): Promise<EndpointHealth> => {
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
            error: safeDiagnostic(errorMessage(error)),
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

    for (let offset = 0; offset < this.#requestEndpoints.length; offset += 1) {
      const index = (this.#preferredIndex + offset) % this.#requestEndpoints.length
      const endpoint = this.#requestEndpoints[index]
      if (!endpoint) continue
      const startedAt = performance.now()

      try {
        const payload = await this.#fetchJson(endpoint, path, params, signal)
        const value = parse(payload)
        const stats = this.#statsFor(endpoint)
        stats.successes += 1
        stats.lastLatencyMs = Math.round(performance.now() - startedAt)
        delete stats.lastError
        this.#preferredIndex = index
        return { endpoint: redactEndpoint(endpoint), value }
      } catch (error) {
        if (signal?.aborted) throw error
        const message = safeDiagnostic(errorMessage(error))
        const stats = this.#statsFor(endpoint)
        stats.failures += 1
        stats.lastError = message
        stats.lastLatencyMs = Math.round(performance.now() - startedAt)
        failures.push({ endpoint: redactEndpoint(endpoint), error: message })
      }
    }

    throw new EndpointPoolError(operation, failures)
  }

  #statsFor(endpoint: string): EndpointStats {
    const safeEndpoint = redactEndpoint(endpoint)
    const existing = this.stats.get(safeEndpoint)
    if (existing) return existing
    const stats = { failures: 0, successes: 0 }
    this.stats.set(safeEndpoint, stats)
    return stats
  }

  async #fetchJson(
    endpoint: string,
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let url = new URL(path, endpoint)
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
    const authorization = extractBasicAuthorization(url)
    const allowedOrigin = url.origin

    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response | undefined
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      try {
        response = await this.#fetch(url, {
          signal: combinedSignal,
          redirect: "manual",
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

      if (!REDIRECT_STATUSES.has(response.status)) break
      const location = response.headers.get("location")
      await cancelResponseBody(response)
      if (!location) throw new Error(`HTTP ${response.status} redirect did not include a Location header`)
      if (redirects === MAX_REDIRECTS) throw new Error(`endpoint exceeded the ${MAX_REDIRECTS}-redirect limit`)

      const redirectedUrl = resolveRedirect(location, url)
      if (redirectedUrl.origin !== allowedOrigin) {
        throw new Error("endpoint attempted a cross-origin redirect")
      }
      if (redirectedUrl.username || redirectedUrl.password) {
        throw new Error("endpoint attempted a credential-bearing redirect")
      }
      url = redirectedUrl
    }

    if (!response) throw new Error("endpoint did not return a response")
    if (!response.ok) {
      await cancelResponseBody(response)
      const statusText = boundedSanitizedSingleLine(response.statusText, MAX_STATUS_LENGTH)
      throw new Error(`HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`)
    }
    const contentType = boundedSanitizedSingleLine(response.headers.get("content-type") ?? "", MAX_STATUS_LENGTH)
    let body: string
    try {
      body = await readResponseText(response, MAX_RESPONSE_BYTES)
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
  if (
    url.protocol === "http:"
    && (url.username || url.password)
    && !isLoopbackHostname(url.hostname)
  ) {
    throw new Error(`Endpoint ${redactEndpoint(value)} cannot send credentials over plaintext HTTP.`)
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
    return safeDiagnostic(value)
  }
}

export function parseSearchPayload(payload: unknown): TorrentSummary[] {
  if (!Array.isArray(payload)) throw new Error("search response is not an array")
  if (payload.length > MAX_SEARCH_RESULTS) {
    throw new Error(`search response exceeds the ${MAX_SEARCH_RESULTS}-result limit`)
  }

  const results: TorrentSummary[] = []
  for (const item of payload) {
    const torrent = parseSummary(item)
    if (torrent && torrent.id !== "0") results.push(torrent)
  }
  return results
}

export function parseDetailsPayload(payload: unknown): TorrentDetails {
  const summary = parseSummary(payload)
  if (!summary) throw new Error("details response is not a valid torrent object")
  const object = payload as Record<string, unknown>
  return {
    ...summary,
    description: boundedRemoteText(object.descr, MAX_DESCRIPTION_LENGTH, true, true),
    ...optionalNumber("language", object.language),
    ...optionalNumber("textLanguage", object.textlanguage),
  }
}

function parseSummary(payload: unknown): TorrentSummary | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null
  const object = payload as Record<string, unknown>
  const id = identityString(object.id, MAX_TORRENT_ID_LENGTH)
  const infoHash = identityString(object.info_hash, 40).toUpperCase()
  const addedSeconds = finiteNumberValue(object.added)

  if (
    !isTorrentId(id)
    || !/^[A-F0-9]{40}$/.test(infoHash)
    || !Number.isInteger(addedSeconds)
    || addedSeconds < MIN_TORRENT_TIMESTAMP_SECONDS
    || addedSeconds > MAX_TORRENT_TIMESTAMP_SECONDS
  ) return null

  const name = boundedRemoteText(object.name, MAX_NAME_LENGTH, false, true)
  if (!name) return null

  const imdbId = boundedRemoteText(object.imdb, MAX_IMDB_ID_LENGTH)
  return {
    id,
    name,
    infoHash,
    leechers: numberValue(object.leechers),
    seeders: numberValue(object.seeders),
    size: numberValue(object.size),
    fileCount: numberValue(object.num_files),
    username: boundedRemoteText(object.username, MAX_USERNAME_LENGTH, false, true),
    addedAt: new Date(addedSeconds * 1_000),
    status: boundedRemoteText(object.status, MAX_STATUS_LENGTH),
    category: numberValue(object.category),
    ...(imdbId ? { imdbId } : {}),
  }
}

function isTorrentId(value: string): boolean {
  return value.length <= MAX_TORRENT_ID_LENGTH && /^\d+$/u.test(value)
}

function identityString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" && typeof value !== "number") return ""
  const string = String(value)
  if (string.length > maxLength) return ""
  return string
}

function boundedRemoteText(
  value: unknown,
  maxLength: number,
  multiline = false,
  entities = false,
): string {
  if (typeof value !== "string" && typeof value !== "number") return ""
  const input = String(value).slice(0, maxLength)
  const decoded = entities ? decodeEntities(input) : input
  const sanitized = multiline ? sanitizeMultiline(decoded) : sanitizeSingleLine(decoded)
  return truncateWellFormed(sanitized, maxLength)
}

function boundedSanitizedSingleLine(value: string, maxLength: number): string {
  return truncateWellFormed(sanitizeSingleLine(value.slice(0, maxLength)), maxLength)
}

function truncateWellFormed(value: string, maxLength: number): string {
  const truncated = value.slice(0, maxLength)
  if (!truncated || !isHighSurrogate(truncated.charCodeAt(truncated.length - 1))) return truncated
  return `${truncated.slice(0, -1)}\ufffd`
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function numberValue(value: unknown): number {
  const parsed = finiteNumberValue(value)
  return parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : 0
}

function finiteNumberValue(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number") return Number.NaN
  if (typeof value === "string" && value.length > 64) return Number.NaN
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function optionalNumber<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  const parsed = numberValue(value)
  return parsed ? ({ [key]: parsed } as { [P in K]?: number }) : {}
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " " }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized.startsWith("#")) {
      const hexadecimal = normalized.startsWith("#x")
      const codePoint = Number.parseInt(normalized.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      if (
        !Number.isSafeInteger(codePoint)
        || codePoint < 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) return "\ufffd"
      return String.fromCodePoint(codePoint)
    }
    return named[normalized] ?? match
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

function resolveRedirect(location: string, currentUrl: URL): URL {
  try {
    return new URL(location, currentUrl)
  } catch {
    throw new Error("endpoint returned an invalid redirect Location")
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The response is being discarded; a cancellation failure is not actionable.
  }
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length")?.trim()
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await cancelResponseBody(response)
    throw new Error(`response body exceeds the ${maxBytes}-byte limit`)
  }

  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytesRead = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          // Preserve the useful size error if stream cancellation itself fails.
        }
        throw new Error(`response body exceeds the ${maxBytes}-byte limit`)
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join("")
  } finally {
    reader.releaseLock()
  }
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/\.+$/u, "")
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  if (hostname === "[::1]") return true
  return /^127(?:\.\d{1,3}){3}$/u.test(hostname)
}

function safeDiagnostic(value: string): string {
  const scanLimit = MAX_DIAGNOSTIC_LENGTH * 4
  const truncated = value.length > scanLimit
  const bounded = value.slice(0, scanLimit)
  let redacted = redactUrlCredentialsInText(bounded)
    .replace(/\bBasic\s+[A-Za-z0-9+/]+=*/giu, "Basic [redacted]")
  if (truncated) {
    // If the scan ended inside a URL authority, an `@` identifying userinfo
    // could be just beyond the boundary. Drop that incomplete authority rather
    // than returning a credential prefix that merely looks like a hostname.
    redacted = redacted.replace(/(https?:\/\/)[^\s/?#]*$/giu, "$1[redacted]")
  }
  return boundedSanitizedSingleLine(redacted, MAX_DIAGNOSTIC_LENGTH)
}

function redactUrlCredentialsInText(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/?#]*@/giu, "$1")
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
