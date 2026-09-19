import { expect, test } from "bun:test"
import { customTable, parseColumns } from "../src/columns.ts"
import { displayWidth } from "../src/text.ts"
import type { TorrentSummary } from "../src/domain.ts"

test("custom tables respect requested order, sanitize text, and fit narrow terminals", () => {
  const row = { id: "1", name: "\u001b[31m漢字 long title", seeders: 12, leechers: 0, size: 1, fileCount: 1, category: 301, username: "test", status: "vip", infoHash: "A".repeat(40), addedAt: new Date() } satisfies TorrentSummary
  const table = customTable([row], parseColumns("uploader,name,id"), 25)
  expect(table).toStartWith("uploader")
  expect(table).not.toContain("\u001b")
  for (const line of table.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(25)
  expect(() => parseColumns("name,wat")).toThrow()
  expect(() => parseColumns("name,name")).toThrow()
  expect(() => parseColumns("")).toThrow()
})
