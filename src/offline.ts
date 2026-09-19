import { redactEndpoint } from "./api.ts"
import type { SearchResponse, TorrentSummary } from "./domain.ts"
import { sanitizeSingleLine } from "./text.ts"

export async function readSavedResults(path: string): Promise<SearchResponse> {
  if (path === "-" && process.stdin.isTTY) throw new Error("Pipe saved JSON to filter or supply a file path.")
  const stream = path === "-" ? Bun.stdin.stream() : Bun.file(path).stream()
  const reader = stream.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8 * 1024 * 1024) throw new Error("Saved results exceed the 8 MiB input limit.")
      chunks.push(Uint8Array.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  return parseSavedResults(JSON.parse(await new Blob(chunks).text()))
}

export function parseSavedResults(value: unknown): SearchResponse {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const rows = Array.isArray(value) ? value : source.results
  if (!Array.isArray(rows) || rows.length > 5000) throw new Error("Expected a saved JSON results array with at most 5000 entries.")
  const results: TorrentSummary[] = rows.map((value, index) => {
    const fail = (): never => { throw new Error(`Invalid saved torrent at row ${index + 1}.`) }
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail()
    const row = value as Record<string, unknown>
    if (typeof row.id !== "string" || !/^\d{1,20}$/.test(row.id) || typeof row.infoHash !== "string" || !/^[a-f\d]{40}$/i.test(row.infoHash)) return fail()
    for (const key of ["seeders", "leechers", "size", "fileCount", "category"] as const) {
      if (typeof row[key] !== "number" || !Number.isSafeInteger(row[key]) || row[key] < 0) return fail()
    }
    for (const key of ["name", "username", "status"] as const) if (typeof row[key] !== "string" || row[key].length > 4096) return fail()
    const date = typeof row.addedAt === "string" ? new Date(row.addedAt) : new Date(NaN)
    if (!Number.isFinite(date.getTime()) || !sanitizeSingleLine(row.name as string)) return fail()
    return {
      id: row.id, infoHash: row.infoHash.toUpperCase(), name: sanitizeSingleLine(row.name as string),
      username: sanitizeSingleLine(row.username as string), status: sanitizeSingleLine(row.status as string),
      seeders: row.seeders as number, leechers: row.leechers as number, size: row.size as number,
      fileCount: row.fileCount as number, category: row.category as number, addedAt: date,
      ...(typeof row.imdbId === "string" && /^tt\d+$/.test(row.imdbId) ? { imdbId: row.imdbId } : {}),
    }
  })
  return {
    endpoint: typeof source.endpoint === "string" ? redactEndpoint(source.endpoint) : "saved JSON",
    results, availableResults: results.length,
    ...(source.partial === true ? { partial: true, failedSources: typeof source.failedSources === "number" && Number.isSafeInteger(source.failedSources) && source.failedSources > 0 ? source.failedSources : 1 } : {}),
  }
}
