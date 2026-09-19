/** Extract identity only; pasted URLs are never fetched. */
export function parseTorrentReference(value: string): string {
  const input = value.trim()
  if (/^\d{1,20}$/.test(input)) return input
  let url: URL
  try { url = new URL(input) } catch { throw new Error("Use a numeric torrent ID or an HTTP(S) torrent page URL.") }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Torrent page URLs must use HTTP(S) without credentials.")
  }
  const pathId = /^\/torrent\/(\d{1,20})(?:\/|$)/.exec(url.pathname)?.[1]
  const queryId = /^\/(?:description|torrent)\.php$/.test(url.pathname) && url.searchParams.getAll("id").length === 1
    ? url.searchParams.get("id") : undefined
  const id = pathId ?? queryId
  if (!id || !/^\d{1,20}$/.test(id)) throw new Error("URL must contain /torrent/<id> or /description.php?id=<id>.")
  return id
}
