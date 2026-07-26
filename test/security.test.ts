import { describe, expect, test } from "bun:test"
import { ApiBayClient, EndpointPoolError, parseDetailsPayload, parseSearchPayload } from "../src/api.ts"
import { formatDetails } from "../src/format.ts"
import { createImdbSearchUrl } from "../src/imdb.ts"
import { createMagnetUri } from "../src/magnet.ts"
import { rawSearchResult, torrent } from "./fixtures.ts"

type FakeFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Response | Promise<Response>

function fakeFetch(implementation: FakeFetch): typeof globalThis.fetch {
  return implementation as typeof globalThis.fetch
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  })
}

function isWellFormed(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 0xD800 || codePoint > 0xDFFF
  })
}

describe("security regressions", () => {
  test("rejects terminal-control, non-numeric, and unbounded torrent IDs", async () => {
    const escape = "\u001b"
    const maximumLengthId = "9".repeat(20)
    const rejectedIds = [
      `12${escape}]52;c;clipboard\u0007`,
      `12${escape}[2J`,
      "12x",
      "-12",
      "1.2",
      "9".repeat(21),
    ]
    const payload = [
      ...rejectedIds.map((id) => ({ ...rawSearchResult, id })),
      {
        ...rawSearchResult,
        id: maximumLengthId,
        info_hash: "9".repeat(40),
      },
      rawSearchResult,
    ]

    expect(parseSearchPayload(payload).map((torrent) => torrent.id)).toEqual([
      maximumLengthId,
      rawSearchResult.id,
    ])

    let calls = 0
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: fakeFetch((input) => {
        calls += 1
        const id = new URL(String(input)).searchParams.get("id") ?? rawSearchResult.id
        return jsonResponse({ ...rawSearchResult, id, descr: "safe" })
      }),
    })
    expect((await client.details(rawSearchResult.id)).torrent.id).toBe(rawSearchResult.id)
    expect((await client.details(maximumLengthId)).torrent.id).toBe(maximumLengthId)
    for (const id of rejectedIds) {
      await expect(client.details(id)).rejects.toThrow(/torrent id|numeric/i)
    }
    expect(calls).toBe(2)
  })

  test("does not crash on malformed numeric HTML entities", () => {
    const malformedEntities = [
      "&#1114112;",
      "&#x110000;",
      "&#999999999999999999999999999999999999;",
      "&#xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF;",
    ]

    for (const entity of malformedEntities) {
      let summaries: ReturnType<typeof parseSearchPayload> = []
      expect(() => {
        summaries = parseSearchPayload([{ ...rawSearchResult, name: `safe ${entity} title` }])
      }).not.toThrow()
      expect(summaries).toHaveLength(1)
      expect(isWellFormed(summaries[0]!.name)).toBeTrue()

      let description = ""
      expect(() => {
        description = parseDetailsPayload({
          ...rawSearchResult,
          descr: `safe ${entity} description`,
        }).description
      }).not.toThrow()
      expect(isWellFormed(description)).toBeTrue()
    }
  })

  test("makes lone surrogates safe before building magnet and IMDb URLs", () => {
    const malformedName = "before\uD800after"
    const torrent = {
      infoHash: rawSearchResult.info_hash,
      name: malformedName,
    }

    let magnet = ""
    let imdb = ""
    expect(() => {
      magnet = createMagnetUri(torrent)
      imdb = createImdbSearchUrl(torrent)
    }).not.toThrow()

    expect(new URL(magnet).searchParams.get("dn")).toBe("before\uFFFDafter")
    expect(new URL(imdb).searchParams.get("q")).toBe("before\uFFFDafter")
  })

  test("removes bidirectional text controls from remote text fields", () => {
    const bidiControls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
    const result = parseSearchPayload([{
      ...rawSearchResult,
      name: `safe${bidiControls}name`,
      username: `safe${bidiControls}user`,
      status: `safe${bidiControls}status`,
    }])[0]
    expect(result?.name).toBe("safename")
    expect(result?.username).toBe("safeuser")
    expect(result?.status).toBe("safestatus")

    const details = parseDetailsPayload({
      ...rawSearchResult,
      descr: `safe${bidiControls}description`,
    })
    expect(details.description).toBe("safedescription")
  })

  test("bounds every remotely supplied display field", () => {
    const result = parseSearchPayload([{
      ...rawSearchResult,
      name: "n".repeat(10_000),
      username: "u".repeat(10_000),
      status: "s".repeat(10_000),
      imdb: "i".repeat(10_000),
    }])[0]
    expect(result?.name.length).toBe(512)
    expect(result?.username.length).toBe(128)
    expect(result?.status.length).toBe(64)
    expect(result?.imdbId?.length).toBe(32)

    const details = parseDetailsPayload({
      ...rawSearchResult,
      descr: "d".repeat(100_000),
    })
    expect(details.description.length).toBe(64 * 1024)
  })

  test("sanitizes terminal detail formatting even for a custom data source", () => {
    const escape = "\u001b"
    const bell = "\u0007"
    const formatted = formatDetails(torrent({
      id: `12${escape}]52;c;clipboard${bell}`,
      name: `safe${escape}[2Jname`,
      username: "user\u202ename",
      status: `trusted${escape}[31m`,
    }))

    expect(formatted).not.toContain(escape)
    expect(formatted).not.toContain(bell)
    expect(formatted).not.toContain("\u202e")
    expect(formatted).toContain("ID 12")
  })

  test("rejects invalid-date records individually", () => {
    const results = parseSearchPayload([
      {
        ...rawSearchResult,
        id: "1",
        info_hash: "1".repeat(40),
        added: "not-a-date",
      },
      {
        ...rawSearchResult,
        id: "2",
        info_hash: "2".repeat(40),
        added: String(Number.MAX_SAFE_INTEGER),
      },
      {
        ...rawSearchResult,
        id: "3",
        info_hash: "3".repeat(40),
      },
    ])

    expect(results.map((torrent) => torrent.id)).toEqual(["3"])
    expect(results[0]!.addedAt.toISOString()).toBe("2022-05-18T12:33:51.000Z")
    expect(() => parseDetailsPayload({
      ...rawSearchResult,
      added: String(Number.MAX_SAFE_INTEGER),
      descr: "invalid date",
    })).toThrow(/details|date|torrent/i)
  })

  test("rejects an oversized response body before parsing it", async () => {
    const validJsonWithExcessWhitespace = `${JSON.stringify([rawSearchResult])}${" ".repeat(4 * 1024 * 1024)}`
    const client = new ApiBayClient({
      endpoints: ["https://api.example/"],
      fetch: fakeFetch(() => new Response(validJsonWithExcessWhitespace, {
        headers: { "content-type": "application/json" },
      })),
    })

    await expect(client.search({ query: "ubuntu" })).rejects.toBeInstanceOf(EndpointPoolError)
    expect(client.stats.get("https://api.example/")?.lastError).toMatch(/body|bytes|large|limit|size/i)
  })

  test("bounds or rejects excessive result arrays", () => {
    const excessivePayload = new Array(5_001).fill(rawSearchResult)
    expect(() => parseSearchPayload(excessivePayload)).toThrow(/5[,\s]?000|array|items|results|large|limit|many/i)
  })

  test("rejects cross-origin and credential-bearing redirects without following them", async () => {
    const redirects = [
      "https://other.example/stolen",
      "https://attacker:secret@api.example/next",
      "file:///etc/passwd",
    ]

    for (const location of redirects) {
      const calls: string[] = []
      const redirectModes: Array<RequestRedirect | undefined> = []
      const client = new ApiBayClient({
        endpoints: ["https://user:secret@api.example/base/"],
        fetch: fakeFetch((input, init) => {
          calls.push(String(input))
          redirectModes.push(init?.redirect)
          return new Response(null, {
            status: 302,
            headers: { location },
          })
        }),
      })

      await expect(client.search({ query: "ubuntu" })).rejects.toBeInstanceOf(EndpointPoolError)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toStartWith("https://api.example/")
      expect(calls[0]).not.toContain("user")
      expect(calls[0]).not.toContain("secret")
      expect(redirectModes).toEqual(["manual"])
      expect(client.stats.get("https://api.example/base/")?.lastError).toMatch(/redirect|origin|location|scheme|credential/i)
    }
  })

  test("rejects same-origin redirect chains beyond the configured hop limit", async () => {
    const calls: string[] = []
    const client = new ApiBayClient({
      endpoints: ["https://api.example/base/"],
      fetch: fakeFetch((input, init) => {
        expect(init?.redirect).toBe("manual")
        const url = String(input)
        calls.push(url)
        return new Response(null, {
          status: 302,
          headers: { location: `/hop-${calls.length}` },
        })
      }),
    })

    await expect(client.search({ query: "ubuntu" })).rejects.toBeInstanceOf(EndpointPoolError)
    expect(calls).toHaveLength(4)
    expect(client.stats.get("https://api.example/base/")?.lastError).toMatch(/redirect|hop|many|limit/i)
  })

  test("follows a same-origin redirect and preserves same-origin authentication", async () => {
    const calls: Array<{ authorization: string; redirect: RequestRedirect | undefined; url: string }> = []
    const client = new ApiBayClient({
      endpoints: ["https://user%40example:p%40ss@api.example/base/"],
      fetch: fakeFetch((input, init) => {
        const url = String(input)
        calls.push({
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          redirect: init?.redirect,
          url,
        })
        if (calls.length === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: "/redirected/q.php" },
          })
        }
        return jsonResponse([rawSearchResult])
      }),
    })

    const response = await client.search({ query: "ubuntu" })
    expect(response.results).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.redirect)).toEqual(["manual", "manual"])
    expect(calls[1]!.url).toBe("https://api.example/redirected/q.php")
    expect(calls.map((call) => atob(call.authorization.slice("Basic ".length)))).toEqual([
      "user@example:p@ss",
      "user@example:p@ss",
    ])
  })

  test("does not expose raw endpoint credentials through public endpoints or stats", async () => {
    const client = new ApiBayClient({
      endpoints: ["https://user:secret@api.example/private/"],
      fetch: fakeFetch(() => jsonResponse([rawSearchResult])),
    })
    await client.search({ query: "ubuntu" })

    expect(client.endpoints).toEqual(["https://api.example/private/"])
    expect([...client.stats.keys()]).toEqual(["https://api.example/private/"])
    const publicState = JSON.stringify({
      endpoints: client.endpoints,
      stats: [...client.stats],
    })
    expect(publicState).not.toContain("user")
    expect(publicState).not.toContain("secret")
  })

  test("redacts credentials containing an at-sign from endpoint diagnostics", () => {
    expect(() => new ApiBayClient({
      endpoints: ["not-a-url https://user:p@ss@api.example/private/"],
    })).toThrow("not-a-url https://api.example/private/")

    const oversizedCredential = `very-secret-${"x".repeat(5_000)}`
    const poolError = new EndpointPoolError("search", [{
      endpoint: "https://api.example/",
      error: `request failed for https://${oversizedCredential}@api.example/private/`,
    }])
    expect(poolError.message).not.toContain("very-secret")
    expect(() => new ApiBayClient({
      endpoints: [`not-a-url https://${oversizedCredential}@api.example/private/`],
    })).toThrow()
    try {
      new ApiBayClient({
        endpoints: [`not-a-url https://${oversizedCredential}@api.example/private/`],
      })
    } catch (error) {
      expect(String(error)).not.toContain("very-secret")
    }
  })

  test("rejects credentials over plain HTTP but permits the loopback development exception", async () => {
    const fetch = fakeFetch((_input, init) => {
      expect(atob((new Headers(init?.headers).get("authorization") ?? "").slice("Basic ".length))).toBe("user:secret")
      return jsonResponse([rawSearchResult])
    })

    expect(() => new ApiBayClient({
      endpoints: ["http://user:secret@api.example/"],
      fetch,
    })).toThrow(/credential|https|secure/i)

    const loopback = new ApiBayClient({
      endpoints: ["http://user:secret@127.0.0.1:8080/"],
      fetch,
    })
    const response = await loopback.search({ query: "ubuntu" })
    expect(response.endpoint).toBe("http://127.0.0.1:8080/")
    expect(loopback.endpoints).toEqual(["http://127.0.0.1:8080/"])
  })
})
