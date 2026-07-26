import type { TorrentDetails, TorrentSummary } from "../src/domain.ts"

export function torrent(overrides: Partial<TorrentSummary> = {}): TorrentSummary {
  return {
    id: "59191690",
    name: "Ubuntu 22.04 LTS",
    infoHash: "2C6B6858D61DA9543D4231A71DB4B1C9264B0685",
    leechers: 1,
    seeders: 39,
    size: 3_654_957_056,
    fileCount: 1,
    username: "rjaa",
    addedAt: new Date("2022-05-18T12:33:51.000Z"),
    status: "vip",
    category: 303,
    ...overrides,
  }
}

export function details(overrides: Partial<TorrentDetails> = {}): TorrentDetails {
  return { ...torrent(), description: "A legal Linux distribution image.", ...overrides }
}

export const rawSearchResult = {
  id: "59191690",
  name: "Ubuntu 22.04 LTS",
  info_hash: "2C6B6858D61DA9543D4231A71DB4B1C9264B0685",
  leechers: "1",
  seeders: "39",
  size: "3654957056",
  num_files: "1",
  username: "rjaa",
  added: "1652877231",
  status: "vip",
  category: "303",
  imdb: "",
}
