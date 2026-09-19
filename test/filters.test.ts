import { describe, expect, test } from "bun:test"
import { filterResponse, parseFilters, parseSize } from "../src/filters.ts"
import type { TorrentSummary } from "../src/domain.ts"

const torrent: TorrentSummary = {
  id: "1", name: "Ubuntu AMD64 stable", infoHash: "A".repeat(40), seeders: 10,
  leechers: 2, size: 1024 ** 3, fileCount: 1, username: "Publisher",
  addedAt: new Date("2024-03-09T23:59:59Z"), status: "vip", category: 301,
}
const response = { endpoint: "https://example.test", results: [torrent, { ...torrent, id: "2", name: "Ubuntu beta", seeders: 0, status: "member" }] }

describe("result filters", () => {
  test("parses decimal and binary units without accepting junk", () => {
    expect(parseSize("1.5GB")).toBe(1_500_000_000)
    expect(parseSize(" 1 GiB ")).toBe(1024 ** 3)
    expect(parseSize("0")).toBe(0)
    for (const value of ["-1MB", "1GBjunk", "NaN", "1e9", "1PB", "9007199254740992"]) expect(() => parseSize(value)).toThrow()
  })
  test("combines literal title, metadata, and inclusive UTC date filters", () => {
    const filters = parseFilters({ include: ["UBUNTU", "amd64"], exclude: ["beta", "[test]"], minSeeders: "10", minSize: "1GiB", maxSize: "1GiB", uploader: "publisher", trusted: true, after: "2024-03-09", before: "2024-03-09" })
    expect(filterResponse(response, filters, 0).results.map((row) => row.id)).toEqual(["1"])
    expect(filterResponse(response, { after: "2024-03-10" }, 0).results).toEqual([])
    expect(filterResponse(response, { before: "2024-03-08" }, 0).results).toEqual([])
  })
  test("filters before limiting while preserving partial-feed diagnostics", () => {
    const filtered = filterResponse({ ...response, partial: true, failedSources: 2 }, { exclude: ["stable"] }, 1)
    expect(filtered.results.map((row) => row.id)).toEqual(["2"])
    expect(filtered.availableResults).toBe(1)
    expect(filtered.unfilteredResults).toBe(2)
    expect(filtered.partial).toBe(true)
    expect(filtered.failedSources).toBe(2)
    expect(response.results).toHaveLength(2)
  })
  test("rejects invalid ranges, dates, and empty text", () => {
    for (const options of [
      { minSize: "2GB", maxSize: "1GB" }, { minSeeders: "1junk" },
      { minSeeders: "-1" }, { minSeeders: "9007199254740992" },
      { after: "2024-02-30" }, { before: "yesterday" },
      { after: "2024-03-10", before: "2024-03-09" },
      { include: [" "] }, { exclude: [""] }, { uploader: " " },
    ]) expect(() => parseFilters(options)).toThrow()
  })
})
