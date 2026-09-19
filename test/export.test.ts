import { expect, test } from "bun:test"
import { delimitedResults } from "../src/export.ts"
import type { TorrentSummary } from "../src/domain.ts"
const row: TorrentSummary = { id: "1", name: 'A, "quoted" title', infoHash: "A".repeat(40), seeders: 2, leechers: 0, size: 1000, fileCount: 1, category: 301, username: "=danger()", status: "trusted", addedAt: new Date("2024-01-01Z") }

test("CSV quotes delimiters and quotes, protects formulas, and preserves units", () => {
  const csv = delimitedResults([row], "csv", true)
  expect(csv).toContain('"A, ""quoted"" title"')
  expect(csv).toContain("'=danger()")
  expect(csv).toContain(",1000,")
  expect(csv).toContain("2024-01-01T00:00:00.000Z")
  expect(csv).toContain("magnet:?xt=urn:btih:")
})

test("TSV exports rows and empty exports preserve headers", () => {
  expect(delimitedResults([row], "tsv").split("\n")).toHaveLength(2)
  expect(delimitedResults([], "csv")).toStartWith("id,name,seeders,")
})
