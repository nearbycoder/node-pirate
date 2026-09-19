import { expect, test } from "bun:test"
import { parseTorrentReference } from "../src/torrent-id.ts"

test("torrent page references extract bounded IDs without fetching the URL", () => {
  for (const value of ["42", " 42 ", "https://example.test/torrent/42/title", "https://example.test/description.php?id=42"]) expect(parseTorrentReference(value)).toBe("42")
  for (const value of ["42junk", "https://example.test/?id=42", "https://example.test/torrent/42junk", "https://u:p@example.test/torrent/42", "file:///torrent/42", "https://example.test/description.php?id=42&id=43", "1".repeat(21)]) expect(() => parseTorrentReference(value)).toThrow()
})
