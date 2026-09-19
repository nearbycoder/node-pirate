if (process.env.NODE_PIRATE_TEST_FETCH === "timeout") {
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    const rejectAbort = (): void => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
    if (signal?.aborted) rejectAbort()
    else signal?.addEventListener("abort", rejectAbort, { once: true })
  })) as typeof globalThis.fetch
}

if (process.env.NODE_PIRATE_TEST_FETCH === "fixture") {
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.hostname.endsWith("unhealthy.test")) throw new TypeError("fixture endpoint unavailable")
    if (process.env.NODE_PIRATE_TEST_PARTIAL && url.pathname.endsWith("data_top100_recent.json")) throw new TypeError("fixture feed unavailable")
    const expectedQuery = process.env.NODE_PIRATE_TEST_EXPECT_QUERY
    if (expectedQuery && url.pathname.endsWith("/q.php") && url.searchParams.get("q") !== expectedQuery) {
      throw new TypeError(`expected query ${JSON.stringify(expectedQuery)}`)
    }

    const primary = {
      id: "42",
      name: "Some Movie & More",
      info_hash: "2C6B6858D61DA9543D4231A71DB4B1C9264B0685",
      leechers: "3",
      seeders: "12",
      size: "1073741824",
      num_files: "2",
      username: "tester",
      added: "1710000000",
      status: "trusted",
      category: "207",
      imdb: "tt1234567",
      descr: "A test movie",
    }
    const body = url.pathname.endsWith("/t.php")
      ? primary
      : url.pathname.endsWith("/q.php") || process.env.NODE_PIRATE_TEST_TOP === "fixture"
        ? [primary, {
            ...primary,
            id: "43",
            name: "Less popular movie",
            info_hash: "3".repeat(40),
            seeders: "2",
            imdb: "",
          }]
        : []
    return Response.json(body)
  }) as typeof globalThis.fetch
}
