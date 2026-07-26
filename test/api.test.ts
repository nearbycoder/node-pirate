import { describe, expect, test } from "bun:test"
import { ApiBayClient, EndpointPoolError, normalizeEndpoint, parseDetailsPayload, parseSearchPayload, redactEndpoint } from "../src/api.ts"
import { rawSearchResult } from "./fixtures.ts"
import packageMetadata from "../package.json" with { type: "json" }

describe("API Bay client", () => {
  test("normalizes string fields and HTML entities", () => {
    const result = parseSearchPayload([{ ...rawSearchResult, name: "Linux &amp; tools" }])[0]
    expect(result?.name).toBe("Linux & tools")
    expect(result?.seeders).toBe(39)
    expect(result?.addedAt.toISOString()).toBe("2022-05-18T12:33:51.000Z")

    const details = parseDetailsPayload({ ...rawSearchResult, descr: "Free &amp; open", language: "1" })
    expect(details.description).toBe("Free & open")
    expect(details.language).toBe(1)
  })

  test("removes terminal controls without flattening detail paragraphs", () => {
    const escape = "\u001b"
    const bell = "\u0007"
    const result = parseSearchPayload([{
      ...rawSearchResult,
      name: `Linux\nAdmin${escape}]52;c;payload${bell} &amp; tools`,
      username: `safe\r\nuser`,
      status: `trusted${escape}[31m`,
    }])[0]
    expect(result?.name).toBe("Linux Admin & tools")
    expect(result?.username).toBe("safe user")
    expect(result?.status).toBe("trusted")

    const details = parseDetailsPayload({
      ...rawSearchResult,
      descr: `First line\r\nSecond line&#27;[2J`,
    })
    expect(details.description).toBe("First line\nSecond line")
    expect(details.description).not.toContain(escape)
  })

  test("fails over and keeps the successful endpoint preferred", async () => {
    const calls: string[] = []
    let userAgent = ""
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      calls.push(url)
      userAgent = new Headers(init?.headers).get("user-agent") ?? ""
      if (url.startsWith("https://down.example")) return new Response("unavailable", { status: 503 })
      return Response.json([rawSearchResult])
    }
    const client = new ApiBayClient({
      endpoints: ["https://down.example", "https://healthy.example/apibay"],
      fetch: fetch as typeof globalThis.fetch,
    })

    const first = await client.search({ query: "ubuntu" })
    const second = await client.search({ query: "debian" })
    expect(first.endpoint).toBe("https://healthy.example/apibay/")
    expect(first.availableResults).toBe(1)
    expect(second.endpoint).toBe(first.endpoint)
    expect(calls.filter((url) => url.startsWith("https://down.example"))).toHaveLength(1)
    expect(calls[1]).toContain("/apibay/q.php")
    expect(userAgent).toContain(`node-pirate/${packageMetadata.version}`)
  })

  test("uses endpoint credentials for requests without exposing them in responses or errors", async () => {
    const requestedUrls: string[] = []
    const authorizationHeaders: string[] = []
    const client = new ApiBayClient({
      endpoints: ["https://user%40example:p%40ss@api.example/private"],
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requestedUrls.push(String(input))
        authorizationHeaders.push(new Headers(init?.headers).get("authorization") ?? "")
        return Response.json([rawSearchResult])
      }) as typeof globalThis.fetch,
    })

    const response = await client.search({ query: "ubuntu" })
    expect(requestedUrls[0]).toContain("https://api.example/private/q.php")
    expect(requestedUrls[0]).not.toContain("user%40example")
    expect(authorizationHeaders[0]).toStartWith("Basic ")
    expect(atob(authorizationHeaders[0]!.slice("Basic ".length))).toBe("user@example:p@ss")
    expect(response.endpoint).toBe("https://api.example/private/")
    expect(response.endpoint).not.toContain("secret")
    const health = await client.health()
    expect(health[0]?.url).toBe("https://api.example/private/")
    expect(atob(authorizationHeaders[1]!.slice("Basic ".length))).toBe("user@example:p@ss")

    const failing = new ApiBayClient({
      endpoints: ["https://token:private@down.example/api"],
      fetch: (async (input: string | URL | Request) => {
        throw new Error(`could not fetch ${String(input)}`)
      }) as unknown as typeof globalThis.fetch,
    })
    try {
      await failing.search({ query: "ubuntu" })
      throw new Error("expected search to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(EndpointPoolError)
      expect((error as Error).message).not.toContain("token")
      expect((error as Error).message).not.toContain("private")
      expect((error as EndpointPoolError).failures[0]?.endpoint).toBe("https://down.example/api/")
    }
  })

  test("redacts credentials from valid and invalid endpoint diagnostics", () => {
    expect(redactEndpoint("https://user:secret@example.test/api")).toBe("https://example.test/api")
    try {
      normalizeEndpoint("ftp://user:secret@example.test/api")
      throw new Error("expected endpoint validation to fail")
    } catch (error) {
      expect((error as Error).message).not.toContain("user")
      expect((error as Error).message).not.toContain("secret")
      expect((error as Error).message).toContain("ftp://example.test/api")
    }
  })

  test("reports every endpoint failure", async () => {
    const client = new ApiBayClient({
      endpoints: ["https://one.example", "https://two.example"],
      fetch: (async () => new Response("<html>blocked</html>", { headers: { "content-type": "text/html" } })) as unknown as typeof globalThis.fetch,
    })
    try {
      await client.search({ query: "ubuntu" })
      throw new Error("expected search to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(EndpointPoolError)
      expect((error as EndpointPoolError).operation).toBe("search")
      expect((error as EndpointPoolError).failures).toHaveLength(2)
      expect((error as Error).message).toContain("expected JSON")
    }
  })

  test("reports the configured duration when an endpoint times out", async () => {
    const client = new ApiBayClient({
      endpoints: ["https://slow.example/"],
      timeoutMs: 5,
      fetch: ((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })) as typeof globalThis.fetch,
    })

    try {
      await client.search({ query: "ubuntu" })
      throw new Error("expected search to time out")
    } catch (error) {
      expect(error).toBeInstanceOf(EndpointPoolError)
      expect((error as Error).message).toContain("request timed out after 5 ms")
    }
  })

  test("accepts valid JSON from proxy paths with a generic content type", async () => {
    const client = new ApiBayClient({
      endpoints: ["https://proxy.example/apibay/"],
      fetch: (async () => new Response(JSON.stringify([rawSearchResult]), {
        headers: { "content-type": "text/plain" },
      })) as unknown as typeof globalThis.fetch,
    })
    const response = await client.search({ query: "ubuntu" })
    expect(response.results[0]?.name).toBe("Ubuntu 22.04 LTS")
  })

  test("reports availability before applying the caller's result limit", async () => {
    const second = {
      ...rawSearchResult,
      id: "43",
      info_hash: "4".repeat(40),
      seeders: "2",
    }
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async () => Response.json([rawSearchResult, second])) as unknown as typeof globalThis.fetch,
    })

    const response = await client.search({ query: "ubuntu", limit: 1 })
    expect(response.results).toHaveLength(1)
    expect(response.availableResults).toBe(2)

    const completeResponse = await client.search({ query: "ubuntu", limit: 0 })
    expect(completeResponse.results).toHaveLength(2)
    expect(completeResponse.availableResults).toBe(2)
  })

  test("builds category-aware daily top views from precompiled feeds", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const currentVideo = { ...rawSearchResult, id: "1", info_hash: "1".repeat(40), category: "208", added: String(now), seeders: "80" }
    const currentAudio = { ...rawSearchResult, id: "2", info_hash: "2".repeat(40), category: "101", added: String(now), seeders: "100" }
    const oldVideo = { ...rawSearchResult, id: "3", info_hash: "3".repeat(40), category: "208", added: String(now - 49 * 60 * 60), seeders: "500" }
    const urls: string[] = []
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input))
        return Response.json([currentVideo, currentAudio, oldVideo])
      }) as unknown as typeof globalThis.fetch,
    })
    const response = await client.top({ period: "day", category: 200 })
    expect(response.results.map((torrent) => torrent.id)).toEqual(["1"])
    expect(urls[0]).toContain("data_top100_48h.json")
    expect(urls[1]).toContain("data_top100_recent.json")
  })

  test("uses category rankings as the primary weekly feed", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const weekly = { ...rawSearchResult, id: "4", info_hash: "4".repeat(40), category: "401", added: String(now - 6 * 24 * 60 * 60) }
    const urls: string[] = []
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input))
        return Response.json([weekly])
      }) as typeof globalThis.fetch,
    })
    const response = await client.top({ period: "week", category: 400 })
    expect(response.results[0]?.id).toBe("4")
    expect(urls[0]).toContain("data_top100_400.json")
  })

  test("preserves daily fallback results when the primary ranking is unavailable", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const currentMovie = {
      ...rawSearchResult,
      id: "5",
      info_hash: "5".repeat(40),
      category: "207",
      added: String(now),
    }
    const urls: string[] = []
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        urls.push(url)
        if (url.includes("data_top100_48h.json")) return new Response("unavailable", { status: 503 })
        return Response.json([currentMovie])
      }) as typeof globalThis.fetch,
    })

    const response = await client.top({ period: "day", category: [201, 202, 207, 209] })
    expect(response.results.map((torrent) => torrent.id)).toEqual(["5"])
    expect(response.partial).toBeTrue()
    expect(response.failedSources).toBe(1)
    expect(urls.some((url) => url.includes("data_top100_48h.json"))).toBeTrue()
    expect(urls.some((url) => url.includes("data_top100_recent.json"))).toBeTrue()
  })

  test("preserves weekly fallback results when primary and optional feeds partially fail", async () => {
    const now = Math.floor(Date.now() / 1_000)
    const currentGame = {
      ...rawSearchResult,
      id: "6",
      info_hash: "6".repeat(40),
      category: "401",
      added: String(now),
    }
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async (input: string | URL | Request) => {
        if (String(input).includes("data_top100_48h.json")) return Response.json([currentGame])
        return new Response("unavailable", { status: 503 })
      }) as typeof globalThis.fetch,
    })

    const response = await client.top({ period: "week", category: 400 })
    expect(response.results.map((torrent) => torrent.id)).toEqual(["6"])
    expect(response.partial).toBeTrue()
    expect(response.failedSources).toBe(3)
  })

  test("fails top requests only when every ranking and fallback source fails", async () => {
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async () => new Response("unavailable", { status: 503 })) as unknown as typeof globalThis.fetch,
    })

    expect(client.top({ period: "day" })).rejects.toBeInstanceOf(EndpointPoolError)
  })

  test("loads primary and fallback top feeds concurrently", async () => {
    let active = 0
    let maxActive = 0
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(10)
        active -= 1
        return Response.json([rawSearchResult])
      }) as unknown as typeof globalThis.fetch,
    })

    await client.top({ period: "day" })
    expect(maxActive).toBe(2)
  })

  test("merges and deduplicates composite movie searches", async () => {
    const urls: string[] = []
    let active = 0
    let maxActive = 0
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input))
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(10)
        active -= 1
        return Response.json([rawSearchResult])
      }) as typeof globalThis.fetch,
    })
    const response = await client.search({ query: "open movie", category: [201, 202, 207, 209] })
    expect(response.results).toHaveLength(1)
    expect(urls.map((url) => new URL(url).searchParams.get("cat"))).toEqual(["201", "202", "207", "209"])
    expect(maxActive).toBe(4)
  })

  test("returns transparent partial results when one movie source fails", async () => {
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async (input: string | URL | Request) => {
        const category = new URL(String(input)).searchParams.get("cat")
        if (category === "202") return new Response("unavailable", { status: 503 })
        return Response.json([rawSearchResult])
      }) as typeof globalThis.fetch,
    })
    const response = await client.search({ query: "open movie", category: [201, 202, 207, 209] })
    expect(response.results).toHaveLength(1)
    expect(response.partial).toBeTrue()
    expect(response.failedSources).toBe(1)
  })

  test("preserves successful top rankings when one composite feed fails", async () => {
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async (input: string | URL | Request) => {
        if (String(input).includes("data_top100_202.json")) return new Response("unavailable", { status: 503 })
        return Response.json([{ ...rawSearchResult, category: "201" }])
      }) as typeof globalThis.fetch,
    })
    const response = await client.top({ period: "all", category: [201, 202, 207, 209] })
    expect(response.results).toHaveLength(1)
    expect(response.partial).toBeTrue()
    expect(response.failedSources).toBe(1)
  })

  test("caches top feeds and bypasses the cache on explicit refresh", async () => {
    const calls: string[] = []
    const now = Number(rawSearchResult.added) * 1_000
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      now: () => now,
      fetch: (async (input: string | URL | Request) => {
        calls.push(String(input))
        return Response.json([rawSearchResult])
      }) as typeof globalThis.fetch,
    })

    await client.top({ period: "day" })
    await client.top({ period: "day" })
    expect(calls).toHaveLength(2)

    await client.top({ period: "day", refresh: true })
    expect(calls).toHaveLength(4)
  })

  test("loads independent composite category feeds concurrently", async () => {
    let active = 0
    let maxActive = 0
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Bun.sleep(10)
        active -= 1
        return Response.json([rawSearchResult])
      }) as unknown as typeof globalThis.fetch,
    })

    await client.top({ period: "all", category: [201, 202, 207, 209] })
    expect(maxActive).toBe(4)
  })

  test("propagates cancellation without recording an endpoint failure", async () => {
    let markSupplementStarted: (() => void) | undefined
    const supplementStarted = new Promise<void>((resolve) => {
      markSupplementStarted = resolve
    })
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).includes("data_top100_recent.json")) return Response.json([rawSearchResult])
        markSupplementStarted?.()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        })
      }) as typeof globalThis.fetch,
    })
    const controller = new AbortController()
    const request = client.top({ period: "day", signal: controller.signal })
    await supplementStarted
    controller.abort(new DOMException("Cancelled", "AbortError"))

    expect(request).rejects.toThrow("Cancelled")
    expect(client.stats.get("https://api.example/")?.failures).toBe(0)
  })
})
