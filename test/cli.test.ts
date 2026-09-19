import { describe, expect, test } from "bun:test"
import packageMetadata from "../package.json" with { type: "json" }

async function runCli(
  arguments_: string[],
  environment: Record<string, string> = {},
  input?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const processHandle = Bun.spawn([process.execPath, "--preload", "./test/cli-fetch-preload.ts", "src/cli.ts", ...arguments_], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    stdout: "pipe",
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : new Blob([input]),
    env: { ...process.env, ...environment },
  })
  const [code, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ])
  return { code, stdout, stderr }
}

describe("CLI validation and help", () => {
  test("bare non-TTY invocation prints help instead of starting OpenTUI", async () => {
    const result = await runCli([])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Usage: node-pirate")
    expect(result.stdout).not.toContain("\u001b[")
  })

  test("explicit TUI invocation explains its terminal requirement", async () => {
    const result = await runCli(["tui"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("The TUI requires an interactive terminal")
    expect(result.stdout).not.toContain("\u001b[")
  })

  test("TUI help documents initial view, category, sort, and direction", async () => {
    const result = await runCli(["tui", "--help"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("--view <view>")
    expect(result.stdout).toContain("--category <category>")
    expect(result.stdout).toContain("--direction <direction>")
    expect(result.stdout).toContain("tui --view week --category movies --sort date")
  })

  test("unknown root commands receive a direct actionable error", async () => {
    const result = await runCli(["wat"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown command "wat"')
    expect(result.stderr).toContain("node-pirate --help")
  })

  test("rejects partially numeric limits before making a request", async () => {
    const result = await runCli(["search", "ubuntu", "--limit", "20junk"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("limit must be zero or a positive integer")
  })

  test("JSON mode emits machine-readable action and parser failures", async () => {
    const validation = await runCli(["search", "ubuntu", "--limit", "20junk", "--json"])
    expect(validation.code).toBe(1)
    expect(JSON.parse(validation.stderr)).toEqual({ error: "limit must be zero or a positive integer." })

    const parsing = await runCli(["search", "ubuntu", "--unknown-option", "--json"])
    expect(parsing.code).toBe(1)
    expect(JSON.parse(parsing.stderr).error).toContain("unknown option")
  })

  test("does not treat an option-like query after -- as a JSON flag", async () => {
    const result = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "search",
      "--",
      "--json",
    ], {
      NODE_PIRATE_TEST_FETCH: "fixture",
      NODE_PIRATE_TEST_EXPECT_QUERY: "--json",
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toStartWith("Results · 2 results")
    expect(result.stdout).not.toContain('"request"')
  })

  test("JSON timeout errors include the configured duration", async () => {
    const result = await runCli([
      "--endpoint",
      "https://slow.test/",
      "--timeout",
      "5",
      "search",
      "movie",
      "--json",
    ], { NODE_PIRATE_TEST_FETCH: "timeout" })
    expect(result.code).toBe(1)
    const payload = JSON.parse(result.stderr)
    expect(payload.code).toBe("ENDPOINT_POOL_FAILURE")
    expect(payload.failures[0].error).toBe("request timed out after 5 ms")
  })

  test("rejects partially numeric categories", async () => {
    const result = await runCli(["search", "ubuntu", "--category", "207junk"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Unknown category")
  })

  test("lists IMDb output alongside the other URI commands", async () => {
    const result = await runCli(["--help"])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("imdb [options] <id>")
    expect(result.stdout).toContain("magnet <id>")
    expect(result.stdout).toContain("config")
    expect(result.stdout).toContain("completion [shell]")
    expect(result.stdout).not.toContain("__complete")
    expect(result.stdout).toContain("NODE_PIRATE_ENDPOINTS")
    expect(result.stdout).toContain("node-pirate top 24h --category movies")
    expect(result.stdout).not.toContain("(default: [])")
  })

  test("command help includes practical search and top examples", async () => {
    const search = await runCli(["search", "--help"])
    expect(search.code).toBe(0)
    expect(search.stdout).toContain("[query...]")
    expect(search.stdout).toContain("quotes are optional")
    expect(search.stdout.replace(/\s+/gu, " ")).toContain("reads piped stdin when omitted")
    expect(search.stdout).toMatch(/0 returns all\s+available/u)
    expect(search.stdout).toContain("--direction <direction>")
    expect(search.stdout).toContain("printf 'ubuntu linux\\n' | node-pirate search --json")

    const top = await runCli(["top", "--help"])
    expect(top.code).toBe(0)
    expect(top.stdout).toContain("day/24h, week/7d, or all")
    expect(top.stdout).toContain("explicit sort direction: asc or desc")
    expect(top.stdout).toContain("--sort name --reverse")
  })

  test("reports the package manifest version", async () => {
    const result = await runCli(["--version"])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(packageMetadata.version)
  })

  test("details can emit a magnet and title-based IMDb search through the real CLI", async () => {
    const environment = { NODE_PIRATE_TEST_FETCH: "fixture" }
    const details = await runCli(["--endpoint", "https://healthy.test/", "details", "42", "--json", "--magnet"], environment)
    expect(details.code).toBe(0)
    const payload = JSON.parse(details.stdout)
    expect(payload.torrent.magnet).toStartWith("magnet:?xt=urn:btih:2C6B6858D61DA9543D4231A71DB4B1C9264B0685&")
    expect(payload.imdbUrl).toBe("https://www.imdb.com/title/tt1234567/")
    expect(payload.imdbSearchUrl).toBe("https://www.imdb.com/find/?q=Some%20Movie%20%26%20More&s=tt")

    const imdb = await runCli(["--endpoint", "https://healthy.test/", "imdb", "42", "--search"], environment)
    expect(imdb.code).toBe(0)
    expect(imdb.stdout.trim()).toBe(payload.imdbSearchUrl)
  })

  test("reverse sorting is applied before the CLI result limit", async () => {
    const result = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "search",
      "movie",
      "--sort",
      "seeders",
      "--reverse",
      "--limit",
      "1",
      "--json",
    ], { NODE_PIRATE_TEST_FETCH: "fixture" })
    expect(result.code).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.results).toHaveLength(1)
    expect(payload.results[0].id).toBe("43")
    expect(payload.results[0].seeders).toBe(2)
    expect(payload.resultCount).toBe(1)
    expect(payload.availableResults).toBe(2)
    expect(payload.truncated).toBeTrue()
    expect(payload.request).toEqual({
      mode: "search",
      query: "movie",
      category: [0],
      sort: "seeders",
      direction: "asc",
      reverse: true,
      limit: 1,
    })

    const human = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "search",
      "movie",
      "--sort",
      "seeders",
      "--reverse",
      "--limit",
      "1",
    ], { NODE_PIRATE_TEST_FETCH: "fixture" })
    expect(human.code).toBe(0)
    expect(human.stdout).toContain("1 of 2 results shown")
    expect(human.stdout).toContain("Seeds↑")
  })

  test("supports explicit ascending and descending sort directions", async () => {
    const ascending = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "search",
      "movie",
      "--sort",
      "seeders",
      "--direction",
      "asc",
      "--limit",
      "1",
      "--json",
    ], { NODE_PIRATE_TEST_FETCH: "fixture" })
    expect(ascending.code).toBe(0)
    const ascendingPayload = JSON.parse(ascending.stdout)
    expect(ascendingPayload.results[0].id).toBe("43")
    expect(ascendingPayload.request.direction).toBe("asc")
    expect(ascendingPayload.request.reverse).toBeTrue()

    const descending = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "search",
      "movie",
      "--sort",
      "name",
      "--direction",
      "desc",
      "--limit",
      "1",
    ], { NODE_PIRATE_TEST_FETCH: "fixture" })
    expect(descending.code).toBe(0)
    expect(descending.stdout).toContain("Name↓")
    expect(descending.stdout).toContain("Some Movie & More")
  })

  test("search reads and normalizes a query from piped stdin", async () => {
    const result = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "search",
      "--json",
    ], {
      NODE_PIRATE_TEST_FETCH: "fixture",
      NODE_PIRATE_TEST_EXPECT_QUERY: "movie title",
    }, "  movie\n title\t")
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).results).toHaveLength(2)
  })

  test("search joins an unquoted multiword positional query", async () => {
    const result = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "search",
      "movie",
      "title",
      "--json",
    ], {
      NODE_PIRATE_TEST_FETCH: "fixture",
      NODE_PIRATE_TEST_EXPECT_QUERY: "movie title",
    })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).results).toHaveLength(2)
  })

  test("search limit zero returns every result available from the fetched feeds", async () => {
    const result = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "search",
      "movie",
      "--limit",
      "0",
      "--json",
    ], { NODE_PIRATE_TEST_FETCH: "fixture" })
    expect(result.code).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.request.limit).toBe(0)
    expect(payload.resultCount).toBe(2)
    expect(payload.availableResults).toBe(2)
    expect(payload.truncated).toBeFalse()
  })

  test("rejects ambiguous or undeclared command arguments", async () => {
    const ambiguous = await runCli(["search", "ubuntu", "--title", "debian", "--json"])
    expect(ambiguous.code).toBe(1)
    expect(JSON.parse(ambiguous.stderr).error).toContain("either a positional search query or --title")

    const extra = await runCli(["details", "42", "unexpected", "--json"])
    expect(extra.code).toBe(1)
    expect(JSON.parse(extra.stderr).error).toContain("too many arguments")

    const sortAliases = await runCli(["search", "ubuntu", "--sort", "name", "--order", "s", "--json"])
    expect(sortAliases.code).toBe(1)
    expect(JSON.parse(sortAliases.stderr).error).toContain("either --sort or the legacy --order")

    const idAliases = await runCli(["download", "42", "--id", "43"])
    expect(idAliases.code).toBe(1)
    expect(idAliases.stderr).toContain("either a positional torrent ID or --id")

    const directionConflict = await runCli(["search", "ubuntu", "--direction", "asc", "--reverse", "--json"])
    expect(directionConflict.code).toBe(1)
    expect(JSON.parse(directionConflict.stderr).error).toContain("cannot be used with option '-r, --reverse'")

    const invalidDirection = await runCli(["top", "day", "--direction", "sideways", "--json"])
    expect(invalidDirection.code).toBe(1)
    expect(JSON.parse(invalidDirection.stderr).error).toContain("Allowed choices are asc, desc")

    const queryView = await runCli(["tui", "ubuntu", "--view", "week"])
    expect(queryView.code).toBe(1)
    expect(queryView.stderr).toContain("initial query can only be combined with --view search")
  })

  test("top accepts TUI-style period aliases and emits canonical JSON", async () => {
    for (const [alias, canonical] of [["24h", "day"], ["7d", "week"]] as const) {
      const result = await runCli([
        "--endpoint",
        "https://healthy.test/",
        "top",
        alias,
        "--json",
      ], { NODE_PIRATE_TEST_FETCH: "fixture" })
      expect(result.code).toBe(0)
      const payload = JSON.parse(result.stdout)
      expect(payload.period).toBe(canonical)
      expect(payload.request.period).toBe(canonical)
      expect(payload.request.direction).toBe("desc")
      expect(payload.resultCount).toBe(0)
      expect(payload.availableResults).toBe(0)
      expect(payload.truncated).toBeFalse()
    }
  })

  test("endpoint health supports JSON output and strict proxy checks", async () => {
    const result = await runCli([
      "--endpoint",
      "https://healthy.test/",
      "--endpoint",
      "https://unhealthy.test/",
      "endpoints",
      "--json",
      "--strict",
    ], { NODE_PIRATE_TEST_FETCH: "fixture" })
    expect(result.code).toBe(1)
    const payload = JSON.parse(result.stdout)
    expect(payload.available).toBe(1)
    expect(payload.total).toBe(2)
    expect(payload.endpoints.map((item: { ok: boolean }) => item.ok)).toEqual([true, false])
  })

  test("JSON request failures preserve diagnostics for every attempted endpoint", async () => {
    const result = await runCli([
      "--endpoint",
      "https://unhealthy.test/",
      "--endpoint",
      "https://also-unhealthy.test/api/",
      "search",
      "movie",
      "--json",
    ], { NODE_PIRATE_TEST_FETCH: "fixture" })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    const payload = JSON.parse(result.stderr)
    expect(payload.code).toBe("ENDPOINT_POOL_FAILURE")
    expect(payload.operation).toBe("search")
    expect(payload.failures).toHaveLength(2)
    expect(payload.failures.map((failure: { endpoint: string }) => failure.endpoint)).toEqual([
      "https://unhealthy.test/",
      "https://also-unhealthy.test/api/",
    ])
  })

  test("never prints credentials embedded in configured endpoint URLs", async () => {
    const authenticated = "https://user:secret@healthy.test/apibay"
    const environment = { NODE_PIRATE_TEST_FETCH: "fixture" }

    const search = await runCli(["--endpoint", authenticated, "search", "movie", "--limit", "1", "--json"], environment)
    expect(search.code).toBe(0)
    expect(search.stdout).not.toContain("user:secret")
    expect(search.stdout).not.toContain("secret")
    expect(JSON.parse(search.stdout).endpoint).toBe("https://healthy.test/apibay/")

    const config = await runCli(["--endpoint", authenticated, "config", "--json"])
    expect(config.code).toBe(0)
    expect(config.stdout).not.toContain("user")
    expect(config.stdout).not.toContain("secret")
    expect(JSON.parse(config.stdout).endpoints).toEqual(["https://healthy.test/apibay/"])

    const failure = await runCli([
      "--endpoint",
      "https://token:private@unhealthy.test/apibay",
      "search",
      "movie",
      "--json",
    ], environment)
    expect(failure.code).toBe(1)
    expect(failure.stderr).not.toContain("token")
    expect(failure.stderr).not.toContain("private")
    expect(JSON.parse(failure.stderr).failures[0].endpoint).toBe("https://unhealthy.test/apibay/")
  })

  test("shows resolved configuration provenance without making a request", async () => {
    const result = await runCli(
      ["config", "--json", "--config", "/definitely/missing/config.json"],
      {
        NODE_PIRATE_ENDPOINTS: "https://one.example/api,https://two.example",
        NODE_PIRATE_TIMEOUT_MS: "4321",
      },
    )
    expect(result.code).toBe(0)
    const config = JSON.parse(result.stdout)
    expect(config.endpoints).toEqual(["https://one.example/api/", "https://two.example/"])
    expect(config.endpointSource).toBe("environment")
    expect(config.timeoutSource).toBe("environment")
  })

  test("lists composite category IDs as structured data", async () => {
    const result = await runCli(["categories", "--json"])
    expect(result.code).toBe(0)
    const categories = JSON.parse(result.stdout)
    expect(categories.find((category: { name: string }) => category.name === "movies").ids).toEqual([201, 202, 207, 209])
    expect(categories.find((category: { name: string }) => category.name === "tv").ids).toEqual([205, 208])
  })

  test("prints shell setup and serves completion candidates without network access", async () => {
    const setup = await runCli(["completion", "bash"])
    expect(setup.code).toBe(0)
    expect(setup.stdout).toContain("complete -F _node_pirate_completion node-pirate")

    const inferred = await runCli(["completion"], { SHELL: "/usr/bin/fish" })
    expect(inferred.code).toBe(0)
    expect(inferred.stdout).toContain("complete -c node-pirate")

    const candidates = await runCli(["__complete", "--", "search", "--category", "m"])
    expect(candidates.code).toBe(0)
    expect(candidates.stdout.trim()).toBe("movies")
  })
})

describe("CLI result filtering and pipe output", () => {
  const environment = { NODE_PIRATE_TEST_FETCH: "fixture" }
  const endpoint = ["--endpoint", "https://healthy.test/"]

  test("exclusion happens before limit and JSON explains the counts", async () => {
    const result = await runCli([...endpoint, "search", "movie", "--exclude", "SOME", "--limit", "1", "--json"], environment)
    expect(result.code).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.results.map((row: { id: string }) => row.id)).toEqual(["43"])
    expect(payload.availableResults).toBe(1)
    expect(payload.unfilteredResults).toBe(2)
    expect(payload.filteredOut).toBe(1)
    expect(payload.truncated).toBe(false)
    expect(payload.request.filters).toEqual({ exclude: ["SOME"] })
  })

  test("combined filters emit only IDs or magnets without headings", async () => {
    const args = [...endpoint, "search", "movie", "--include", "some", "--include", "more", "--exclude", "beta", "--min-seeders", "10", "--min-size", "1GiB", "--max-size", "2GB", "--trusted", "--uploader", "TESTER"]
    const ids = await runCli([...args, "--ids"], environment)
    expect(ids.code).toBe(0)
    expect(ids.stdout).toBe("42\n")
    expect(ids.stderr).toBe("")
    const magnets = await runCli([...args, "--magnets"], environment)
    expect(magnets.code).toBe(0)
    expect(magnets.stdout.trim()).toStartWith("magnet:?xt=urn:btih:")
    expect(magnets.stdout.trim().split("\n")).toHaveLength(1)
    const empty = await runCli([...args, "--exclude", "movie", "--ids"], environment)
    expect(empty.code).toBe(0)
    expect(empty.stdout).toBe("")
  })

  test("top supports the same filters and plain output", async () => {
    const result = await runCli([...endpoint, "top", "all", "--category", "207", "--exclude", "some", "--limit", "1", "--ids"], { ...environment, NODE_PIRATE_TEST_TOP: "fixture" })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("43\n")
  })

  test("invalid filters fail before any endpoint request", async () => {
    for (const args of [["--max-size", "junk"], ["--after", "2024-02-30"], ["--min-seeders", "-1"]]) {
      const result = await runCli(["--endpoint", "https://unhealthy.test/", "search", "ubuntu", ...args, "--json"], environment)
      expect(result.code).toBe(1)
      expect(JSON.parse(result.stderr).code).not.toBe("ENDPOINT_POOL_FAILURE")
      expect(result.stdout).toBe("")
    }
  })

  test("plain output rejects conflicting formats in either argument order", async () => {
    for (const args of [["--ids", "--json"], ["--json", "--magnets"], ["--ids", "--magnet"], ["--magnets", "--ids"]]) {
      const result = await runCli([...endpoint, "search", "movie", ...args], environment)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("cannot be used with option")
    }
  })

  test("completion exposes filters and treats their arguments as values", async () => {
    const flags = await runCli(["__complete", "--", "search", "--min-"])
    expect(flags.stdout).toBe("--min-files\n--min-seeders\n--min-size\n")
    const value = await runCli(["__complete", "--", "top", "--exclude", ""])
    expect(value.stdout).toBe("")
  })
})

test("CLI offset reports page position and preserves total matches", async () => {
  const result = await runCli(["search", "movie", "--offset", "1", "--limit", "1", "--json", "--endpoint", "https://healthy.test/"], { NODE_PIRATE_TEST_FETCH: "fixture" })
  expect(result.code).toBe(0)
  const data = JSON.parse(result.stdout)
  expect(data.results.map((row: { id: string }) => row.id)).toEqual(["43"])
  expect(data.offset).toBe(1)
  expect(data.availableResults).toBe(2)
})

test("count output counts matches before pagination and prints zero", async () => {
  const args = ["search", "movie", "--endpoint", "https://healthy.test/", "--count"]
  const env = { NODE_PIRATE_TEST_FETCH: "fixture" }
  const all = await runCli([...args, "--offset", "20", "--limit", "1"], env)
  expect(all.code).toBe(0)
  expect(all.stdout).toBe("2\n")
  const none = await runCli([...args, "--exclude", "movie"], env)
  expect(none.stdout).toBe("0\n")
  const conflict = await runCli([...args, "--json"], env)
  expect(conflict.code).toBe(1)
})

test("fail-empty distinguishes no matches from an empty page", async () => {
  const args = ["search", "movie", "--endpoint", "https://healthy.test/", "--fail-empty", "--json"]
  const env = { NODE_PIRATE_TEST_FETCH: "fixture" }
  const empty = await runCli([...args, "--exclude", "movie"], env)
  expect(empty.code).toBe(2)
  expect(JSON.parse(empty.stdout).resultCount).toBe(0)
  const page = await runCli([...args, "--offset", "20"], env)
  expect(page.code).toBe(0)
  expect(JSON.parse(page.stdout).availableResults).toBe(2)
})

test("strict results retain JSON diagnostics and take precedence over fail-empty", async () => {
  const args = ["top", "day", "--endpoint", "https://healthy.test/", "--json"]
  const env = { NODE_PIRATE_TEST_FETCH: "fixture", NODE_PIRATE_TEST_PARTIAL: "1" }
  const ordinary = await runCli(args, env)
  expect(ordinary.code).toBe(0)
  const strict = await runCli([...args, "--strict", "--fail-empty"], env)
  expect(strict.code).toBe(3)
  expect(JSON.parse(strict.stdout).partial).toBe(true)
  expect(JSON.parse(strict.stdout).failedSources).toBe(1)
})

test("CLI exports delimited rows without table prose", async () => {
  const result = await runCli(["search", "movie", "--format", "csv", "--limit", "1", "--endpoint", "https://healthy.test/"], { NODE_PIRATE_TEST_FETCH: "fixture" })
  expect(result.code).toBe(0)
  expect(result.stdout).toStartWith("id,name,seeders,")
  expect(result.stdout.trim().split("\n")).toHaveLength(2)
})
