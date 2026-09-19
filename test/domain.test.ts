import { describe, expect, test } from "bun:test"
import { formatBytes, parseCategory, parseSort, parseTopPeriod, reverseForSortDirection, sortDirection, sortTorrents } from "../src/domain.ts"
import { formatResultHeader, formatResultLine, resultSortAtColumn, resultSortColumns, truncate } from "../src/format.ts"
import { createMagnetUri } from "../src/magnet.ts"
import { createImdbSearchUrl, createImdbUrl } from "../src/imdb.ts"
import { displayWidth } from "../src/text.ts"
import { torrent } from "./fixtures.ts"

describe("domain helpers", () => {
  test("parses names, legacy aliases, and numeric categories", () => {
    expect(parseCategory("movies")).toEqual([201, 202, 207, 209])
    expect(parseCategory("tv")).toEqual([205, 208])
    expect(parseCategory("app")).toBe(300)
    expect(parseCategory("207")).toBe(207)
    expect(() => parseCategory("recipes")).toThrow("Unknown category")
  })

  test("parses current and legacy sort values", () => {
    expect(parseSort("s")).toBe("seeders")
    expect(parseSort("l")).toBe("leechers")
    expect(parseSort("added")).toBe("date")
    expect(() => parseSort("popular")).toThrow("Unknown sort order")
  })

  test("normalizes human-friendly top period aliases", () => {
    expect(parseTopPeriod("24h")).toBe("day")
    expect(parseTopPeriod("daily")).toBe("day")
    expect(parseTopPeriod("7d")).toBe("week")
    expect(parseTopPeriod("weekly")).toBe("week")
    expect(parseTopPeriod("all")).toBe("all")
    expect(() => parseTopPeriod("month")).toThrow("Unknown top period")
  })

  test("sorts without mutating API results", () => {
    const first = torrent({ id: "1", seeders: 3 })
    const second = torrent({ id: "2", seeders: 50 })
    const original = [first, second]
    expect(sortTorrents(original, "seeders").map((item) => item.id)).toEqual(["2", "1"])
    expect(sortTorrents(original, "seeders", true).map((item) => item.id)).toEqual(["1", "2"])
    expect(original.map((item) => item.id)).toEqual(["1", "2"])
  })

  test("resolves explicit directions against each sort's natural order", () => {
    expect(sortDirection("seeders")).toBe("desc")
    expect(sortDirection("seeders", true)).toBe("asc")
    expect(sortDirection("name")).toBe("asc")
    expect(sortDirection("name", true)).toBe("desc")
    expect(reverseForSortDirection("seeders", "asc")).toBeTrue()
    expect(reverseForSortDirection("name", "asc")).toBeFalse()
  })

  test("formats compact result rows", () => {
    const line = formatResultLine(torrent(), 80)
    expect(line).toContain("Ubuntu 22.04 LTS")
    expect(line).toContain("3.4 GB")
    expect(line).toContain("05/18/2022")
    expect(formatBytes(0)).toBe("0 B")
  })

  test("keeps responsive headers aligned with rows", () => {
    const header = formatResultHeader(80, "date")
    const row = formatResultLine(torrent(), 80)
    expect(header).toHaveLength(80)
    expect(row).toHaveLength(80)
    expect(header).toContain("Date↓")
    expect(resultSortAtColumn(79, 80)).toBe("date")
    expect(resultSortColumns(80)).toEqual(["category", "name", "seeders", "leechers", "size", "date"])
    expect(resultSortColumns(58)).toEqual(["category", "name", "seeders", "size", "date"])
    expect(resultSortColumns(40)).toEqual(["name", "seeders", "date"])
  })

  test("aligns and truncates wide Unicode titles by terminal cells", () => {
    const row = formatResultLine(torrent({ name: "日本語🙂 release title" }), 80)
    expect(displayWidth(row)).toBe(80)
    const fitted = truncate("日本語🙂 release", 8)
    expect(displayWidth(fitted)).toBe(8)
    expect(fitted).toStartWith("日本語…")
  })

  test("strips terminal escape sequences while fitting columns", () => {
    const escape = "\u001b"
    const bell = "\u0007"
    const fitted = truncate(`safe${escape}]52;c;payload${bell} title`, 12)
    expect(displayWidth(fitted)).toBe(12)
    expect(fitted).not.toContain(escape)
    expect(fitted).not.toContain("payload")
  })

  test("builds canonical Deluge-compatible magnet URIs", () => {
    const magnet = createMagnetUri(torrent({ name: "Ubuntu & tools" }), ["udp://tracker.example:80/announce"])
    expect(magnet).toStartWith("magnet:?xt=urn:btih:2C6B6858D61DA9543D4231A71DB4B1C9264B0685&")
    expect(magnet).not.toContain("urn%3Abtih%3A")
    expect(magnet).toContain("dn=Ubuntu%20%26%20tools")
    const url = new URL(magnet)
    expect(url.searchParams.get("xt")).toBe("urn:btih:2C6B6858D61DA9543D4231A71DB4B1C9264B0685")
    expect(url.searchParams.get("dn")).toBe("Ubuntu & tools")
    expect(url.searchParams.getAll("tr")).toEqual(["udp://tracker.example:80/announce"])
  })

  test("builds direct or title-search IMDb links", () => {
    expect(createImdbUrl(torrent({ imdbId: "tt1234567" }))).toBe("https://www.imdb.com/title/tt1234567/")
    expect(createImdbUrl(torrent({ name: "Some Movie & More" }))).toBe(
      "https://www.imdb.com/find/?q=Some%20Movie%20%26%20More&s=tt",
    )
    expect(createImdbSearchUrl(torrent({ name: "Some Movie & More", imdbId: "tt1234567" }))).toBe(
      "https://www.imdb.com/find/?q=Some%20Movie%20%26%20More&s=tt",
    )
  })
})

test("category lists combine names and IDs without duplicates", () => {
  expect(parseCategory("movies, tv,207")).toEqual([201, 202, 207, 209, 205, 208])
  expect(parseCategory("applications,301")).toEqual([300, 301])
  expect(parseCategory("all,movies")).toBe(0)
  expect(() => parseCategory("movies,,tv")).toThrow("empty entries")
  expect(() => parseCategory("movies,unknown")).toThrow("Unknown category")
})
