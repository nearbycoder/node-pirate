import { Command, CommanderError, Option } from "commander"
import { ApiBayClient, EndpointPoolError, redactEndpoint } from "./api.ts"
import { completionCandidates, completionScript, resolveCompletionShell } from "./completion.ts"
import { loadConfig, type ResolvedConfig } from "./config.ts"
import { categoryGroups, categoryLabel, formatBytes, formatDate, parseCategory, parseSort, parseTopPeriod, reverseForSortDirection, sortDirection, type CategoryFilter, type SearchResponse, type SortDirection, type SortOrder, type TorrentSummary } from "./domain.ts"
import { filterResponse, parseFilters } from "./filters.ts"
import { formatResultHeader, formatResultLine } from "./format.ts"
import { createImdbSearchUrl, createImdbUrl } from "./imdb.ts"
import { createMagnetUri } from "./magnet.ts"
import { sanitizeMultiline, sanitizeSingleLine } from "./text.ts"
import { runTui, type TuiView } from "./tui.ts"
import { VERSION } from "./version.ts"

interface GlobalOptions {
  endpoint?: string[]
  config?: string
  timeout?: string
}

const jsonOutputRequested = hasOptionBeforeTerminator(process.argv.slice(2), "--json")
const program = new Command()
  .name("node-pirate")
  .description("Search API Bay with automatic endpoint failover in a modern OpenTUI interface.")
  .version(VERSION)
  .option("-e, --endpoint <url>", "API Bay-compatible endpoint; repeat to configure failover", collect)
  .option("--config <path>", "path to config JSON")
  .option("--timeout <milliseconds>", "per-endpoint request timeout")
  .allowExcessArguments(true)
  .showHelpAfterError()
  .exitOverride()
  .addHelpText("after", `
Examples:
  node-pirate
  node-pirate search "ubuntu linux" --category applications
  node-pirate top 24h --category movies
  node-pirate endpoints --strict
  node-pirate completion bash

Environment:
  NODE_PIRATE_ENDPOINTS   Comma-separated API endpoint pool
  NODE_PIRATE_TIMEOUT_MS  Per-endpoint timeout in milliseconds
  NODE_PIRATE_CONFIG      Alternate JSON config path`)

if (jsonOutputRequested) program.configureOutput({ writeErr: () => {} })

program
  .command("tui")
  .description("open the interactive OpenTUI interface")
  .argument("[query...]", "optional search to run at startup")
  .addOption(new Option("--view <view>", "initial view: all, day/24h, week/7d, or search").choices(["all", "day", "24h", "week", "7d", "search"]))
  .option("-c, --category <category>", "initial named category or numeric Pirate Bay category", "all")
  .addOption(new Option("-s, --sort <order>", "initial sort: category, seeders, leechers, date, size, or name").default("seeders"))
  .option("-r, --reverse", "reverse the selected sort's default direction")
  .addOption(new Option("--direction <direction>", "explicit initial sort direction: asc or desc").choices(["asc", "desc"]).conflicts("reverse"))
  .addHelpText("after", `
Examples:
  node-pirate tui
  node-pirate tui "ubuntu linux"
  node-pirate tui --view week --category movies --sort date
  node-pirate tui --view all --category tv --sort name --direction desc`)
  .action(async (queryWords: string[], options) => {
    const query = joinQueryWords(queryWords)
    const explicitView = options.view ? parseTuiView(options.view) : undefined
    if (query && explicitView && explicitView !== "search") {
      throw new Error("An initial query can only be combined with --view search.")
    }
    const sort = parseSort(options.sort)
    const reverse = options.direction
      ? reverseForSortDirection(sort, options.direction as SortDirection)
      : Boolean(options.reverse)
    const category = parseCategory(options.category)
    requireInteractiveTerminal()
    await runTui(await createClient(), {
      ...(query ? { initialQuery: query } : {}),
      initialView: explicitView ?? (query ? "search" : "all"),
      initialCategory: category,
      initialSort: sort,
      initialReverse: reverse,
    })
  })

program
  .command("search")
  .description("search without opening the interactive interface")
  .argument("[query...]", "search query; quotes are optional, or reads piped stdin when omitted")
  .option("-t, --title <query>", "legacy alias for the search query")
  .option("-c, --category <category>", "all, audio, movies, tv, video, applications, games, other, or an ID", "all")
  .addOption(new Option("-s, --sort <order>", "category, seeders, leechers, date, size, or name").default("seeders"))
  .option("-r, --reverse", "reverse the selected sort's default direction")
  .addOption(new Option("--direction <direction>", "explicit sort direction: asc or desc").choices(["asc", "desc"]).conflicts("reverse"))
  .option("-o, --order <order>", "legacy sort alias: s or l")
  .option("-l, --limit <number>", "maximum results; 0 returns all available", "50")
  .option("--json", "emit machine-readable JSON")
  .option("--magnet", "include magnet links in the output")
  .addHelpText("after", `
Examples:
  node-pirate search "ubuntu linux" --category applications --limit 20
  node-pirate search ubuntu linux --limit 20
  node-pirate search ubuntu --sort size --direction asc
  printf 'ubuntu linux\\n' | node-pirate search --json
  node-pirate search debian --magnet --limit 5`)
  .action(async (queryWords: string[], options, command: Command) => {
    const positionalQuery = joinQueryWords(queryWords)
    if (positionalQuery && options.title?.trim()) {
      throw new Error("Use either a positional search query or --title, not both.")
    }
    const query = await resolveSearchQuery(positionalQuery ?? options.title)
    if (!query) throw new Error("A query is required. Example: node-pirate search ubuntu")
    if (options.order && command.getOptionValueSource("sort") === "cli") {
      throw new Error("Use either --sort or the legacy --order alias, not both.")
    }
    const client = await createClient()
    const sort = parseSort(options.order ?? options.sort)
    const reverse = options.direction
      ? reverseForSortDirection(sort, options.direction as SortDirection)
      : Boolean(options.reverse)
    const category = parseCategory(options.category)
    const limit = nonNegativeInteger(options.limit, "limit")
    const filters = parseFilters(options)
    const response = filterResponse(await client.search({
      query,
      category,
      sort,
      reverse,
      limit: 0,
    }), filters, limit)

    if (options.json) {
      console.log(JSON.stringify({
        request: {
          mode: "search",
          query,
          category: categoryIds(category),
          sort,
          direction: sortDirection(sort, reverse),
          reverse,
          limit,
          ...(Object.keys(filters).length ? { filters } : {}),
        },
        ...serializeSearchResponse(response, options.magnet),
      }, null, 2))
      return
    }
    if (printPlainResults(response, options)) return
    console.log(`Results · ${resultCountLabel(response)} · via ${response.endpoint}\n`)
    printPartialWarning(response)
    printTorrentTable(response.results, sort, options.magnet, reverse)
    printFilterSummary(response)
    if (response.results.length === 0) console.log("No results returned. Try a broader query or relax your filters.")
  })

program
  .command("top")
  .description("show daily, weekly, or full category rankings")
  .argument("[period]", "day/24h, week/7d, or all", "day")
  .option("-c, --category <category>", "all, audio, movies, tv, video, applications, games, other, or an ID", "all")
  .addOption(new Option("-s, --sort <order>", "category, seeders, leechers, date, size, or name").default("seeders"))
  .option("-r, --reverse", "reverse the selected sort's default direction")
  .addOption(new Option("--direction <direction>", "explicit sort direction: asc or desc").choices(["asc", "desc"]).conflicts("reverse"))
  .option("-l, --limit <number>", "maximum results; 0 returns all available", "0")
  .option("--json", "emit machine-readable JSON")
  .option("--magnet", "include magnet links in the output")
  .addHelpText("after", `
Examples:
  node-pirate top 24h --category movies --limit 20
  node-pirate top 7d --category tv --sort date --direction desc
  node-pirate top all --category games --sort name --reverse`)
  .action(async (periodValue: string, options) => {
    const period = parseTopPeriod(periodValue)
    const limit = nonNegativeInteger(options.limit, "limit")
    const sort = parseSort(options.sort)
    const reverse = options.direction
      ? reverseForSortDirection(sort, options.direction as SortDirection)
      : Boolean(options.reverse)
    const category = parseCategory(options.category)
    const filters = parseFilters(options)
    const response = filterResponse(await (await createClient()).top({
      period,
      category,
      sort,
      reverse,
    }), filters, limit)
    if (options.json) {
      console.log(JSON.stringify({
        request: {
          mode: "top",
          period,
          category: categoryIds(category),
          sort,
          direction: sortDirection(sort, reverse),
          reverse,
          limit,
          ...(Object.keys(filters).length ? { filters } : {}),
        },
        ...serializeSearchResponse(response, options.magnet),
        period,
      }, null, 2))
      return
    }
    if (printPlainResults(response, options)) return
    const periodLabel = period === "day" ? "24 hours" : period === "week" ? "7 days" : "full category ranking"
    console.log(`Top downloads · ${periodLabel} · ${resultCountLabel(response)} · via ${response.endpoint}\n`)
    printPartialWarning(response)
    printTorrentTable(response.results, sort, options.magnet, reverse)
    printFilterSummary(response)
    if (response.results.length === 0) console.log("No top downloads returned. Try another category, period, or relax your filters.")
  })

program
  .command("details")
  .description("show details for a Pirate Bay torrent ID")
  .argument("<id>", "numeric torrent ID")
  .option("--json", "emit machine-readable JSON")
  .option("--magnet", "include the magnet URI")
  .action(async (id: string, options) => {
    const response = await (await createClient()).details(id)
    if (options.json) {
      console.log(JSON.stringify({
        endpoint: response.endpoint,
        torrent: serializeTorrent(response.torrent, options.magnet),
        imdbUrl: createImdbUrl(response.torrent),
        imdbSearchUrl: createImdbSearchUrl(response.torrent),
      }, null, 2))
      return
    }
    const torrent = response.torrent
    console.log(`${sanitizeSingleLine(torrent.name)}\n`)
    console.log(`ID:       ${sanitizeSingleLine(torrent.id)}`)
    console.log(`Size:     ${formatBytes(torrent.size)}`)
    console.log(`Files:    ${torrent.fileCount}`)
    console.log(`Seeders:  ${torrent.seeders}`)
    console.log(`Leechers: ${torrent.leechers}`)
    console.log(`Added:    ${formatDate(torrent.addedAt)}`)
    console.log(`Category: ${categoryLabel(torrent.category)} (${torrent.category})`)
    console.log(`Uploader: ${sanitizeSingleLine(torrent.username) || "anonymous"}`)
    console.log(`Status:   ${sanitizeSingleLine(torrent.status) || "unknown"}`)
    console.log(`Hash:     ${sanitizeSingleLine(torrent.infoHash)}`)
    const imdbUrl = createImdbUrl(torrent)
    const imdbSearchUrl = createImdbSearchUrl(torrent)
    if (imdbUrl !== imdbSearchUrl) console.log(`IMDb:     ${imdbUrl}`)
    console.log(`IMDb find: ${imdbSearchUrl}`)
    if (options.magnet) console.log(`Magnet:   ${createMagnetUri(torrent)}`)
    if (torrent.description) console.log(`\n${sanitizeMultiline(torrent.description)}`)
  })

program
  .command("magnet")
  .description("print a magnet URI for a Pirate Bay torrent ID")
  .argument("<id>", "numeric torrent ID")
  .action(async (id: string) => {
    const { torrent } = await (await createClient()).details(id)
    console.log(createMagnetUri(torrent))
  })

program
  .command("imdb")
  .description("print a direct IMDb title URL or title-search URL for a torrent ID")
  .argument("<id>", "numeric torrent ID")
  .option("--search", "always print an IMDb search based on the torrent title")
  .action(async (id: string, options) => {
    const { torrent } = await (await createClient()).details(id)
    console.log(options.search ? createImdbSearchUrl(torrent) : createImdbUrl(torrent))
  })

program
  .command("download")
  .description("legacy alias that prints a torrent's magnet URI without opening it")
  .argument("[id]", "numeric torrent ID")
  .option("-i, --id <id>", "legacy alias for the torrent ID")
  .action(async (argument: string | undefined, options) => {
    if (argument && options.id) throw new Error("Use either a positional torrent ID or --id, not both.")
    const id = argument ?? options.id
    if (!id) throw new Error("A torrent ID is required. Example: node-pirate download 12345")
    const { torrent } = await (await createClient()).details(id)
    console.log(createMagnetUri(torrent))
  })

program
  .command("endpoints")
  .description("check all configured API endpoints")
  .option("--json", "emit machine-readable JSON")
  .option("--strict", "exit unsuccessfully when any configured endpoint fails")
  .action(async (options) => {
    const health = await (await createClient()).health()
    const available = health.filter((endpoint) => endpoint.ok).length
    if (options.json) {
      console.log(JSON.stringify({ available, total: health.length, endpoints: health }, null, 2))
    } else {
      for (const endpoint of health) {
        console.log(`${endpoint.ok ? "ok  " : "fail"}  ${String(endpoint.latencyMs).padStart(5)} ms  ${endpoint.url}${endpoint.error ? `  ${endpoint.error}` : ""}`)
      }
      console.log(`\n${available}/${health.length} endpoint${health.length === 1 ? "" : "s"} available.`)
    }
    if (options.strict ? available < health.length : available === 0) process.exitCode = 1
  })

program
  .command("categories")
  .description("list named category filters and their Pirate Bay category IDs")
  .option("--json", "emit machine-readable JSON")
  .action((options) => {
    const rows = categoryGroups.map((group) => ({
      name: group.name,
      ids: categoryIds(group.filter),
      description: group.description,
    }))
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2))
      return
    }
    console.log(`${"Name".padEnd(14)}${"IDs".padEnd(20)}Description`)
    console.log(`${"─".repeat(12).padEnd(14)}${"─".repeat(18).padEnd(20)}${"─".repeat(40)}`)
    for (const row of rows) console.log(`${row.name.padEnd(14)}${row.ids.join(",").padEnd(20)}${row.description}`)
  })

program
  .command("config")
  .description("show the resolved configuration and where each value came from")
  .option("--json", "emit machine-readable JSON")
  .action(async (options) => {
    const config = await resolveConfig()
    if (options.json) {
      console.log(JSON.stringify({
        ...config,
        endpoints: config.endpoints.map(redactEndpoint),
      }, null, 2))
      return
    }
    console.log(`Config path: ${config.configPath}`)
    console.log(`Timeout:     ${config.requestTimeoutMs} ms (${config.timeoutSource})`)
    console.log(`Endpoints:   ${config.endpointSource}`)
    config.endpoints.forEach((endpoint, index) => console.log(`  ${index + 1}. ${redactEndpoint(endpoint)}`))
  })

program
  .command("completion [shell]")
  .description("print shell completion setup for bash, zsh, or fish")
  .action((shell: string | undefined) => {
    console.log(completionScript(resolveCompletionShell(shell)))
  })

program
  .command("__complete [words...]", { hidden: true })
  .action((words: string[]) => {
    const candidates = completionCandidates(words)
    if (candidates.length) process.stdout.write(`${candidates.join("\n")}\n`)
  })

// Keep search and ranking filters identical, including output-mode conflicts.
for (const name of ["search", "top"]) {
  const command = program.commands.find((command) => command.name() === name)!
  command
    .option("--include <text>", "require title text (case-insensitive); repeat to require every term", collect)
    .option("--exclude <text>", "hide titles containing text (case-insensitive); repeat for more terms", collect)
    .option("--min-seeders <number>", "require at least this many seeders")
    .option("--min-size <size>", "minimum size, e.g. 500MB or 1GiB")
    .option("--max-size <size>", "maximum size, e.g. 2GB or 2GiB")
    .option("--uploader <name>", "exact uploader name (case-insensitive)")
    .option("--trusted", "only trusted or VIP uploaders (API-reported status)")
    .option("--after <date>", "added on or after YYYY-MM-DD (UTC)")
    .option("--before <date>", "added on or before YYYY-MM-DD (UTC)")
    .addOption(new Option("--ids", "print only one torrent ID per line").conflicts(["json", "magnet", "magnets"]))
    .addOption(new Option("--magnets", "print only one magnet URI per line").conflicts(["json", "magnet", "ids"]))
    .addHelpText("after", `
Filtering:
  Filters combine with AND and run before --limit on the fetched results.
  --include requires every term; --exclude removes any matching term.
  Sizes: MB/GB use base 1000; MiB/GiB use base 1024. Date bounds include the day.

  node-pirate ${name} ${name === "search" ? "ubuntu" : "week"} --exclude beta --min-seeders 5 --max-size 4GiB
  node-pirate ${name} ${name === "search" ? "debian" : "day"} --include amd64 --limit 5 --magnets`)
}

function printPlainResults(response: SearchResponse, options: { ids?: boolean; magnets?: boolean }): boolean {
  if (!options.ids && !options.magnets) return false
  printPartialWarning(response)
  for (const torrent of response.results) console.log(options.ids ? torrent.id : createMagnetUri(torrent))
  return true
}

function printFilterSummary(response: SearchResponse): void {
  if (response.unfilteredResults !== undefined) {
    const removed = response.unfilteredResults - (response.availableResults ?? response.results.length)
    console.log(`\n${removed} filtered out of ${response.unfilteredResults} fetched results.`)
  }
  if (response.results.length < (response.availableResults ?? 0)) console.log("Use --limit 0 to show all matching results.")
}

// The root command accepts a free argument so it can provide a direct unknown-command
// message. Every real subcommand still rejects arguments it does not declare.
for (const command of program.commands) command.allowExcessArguments(false)

program.action(async () => {
  const unknownCommand = program.args[0]
  if (unknownCommand) throw new Error(`Unknown command "${unknownCommand}". Run \`node-pirate --help\` to list available commands.`)
  if (!isInteractiveTerminal()) {
    program.outputHelp()
    return
  }
  await runTui(await createClient())
})

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true
}

function requireInteractiveTerminal(): void {
  if (isInteractiveTerminal()) return
  throw new Error("The TUI requires an interactive terminal. Use `node-pirate search`, `node-pirate top`, or another command for piped and scripted use.")
}

async function createClient(): Promise<ApiBayClient> {
  const config = await resolveConfig()
  return new ApiBayClient({ endpoints: config.endpoints, timeoutMs: config.requestTimeoutMs })
}

async function resolveConfig(): Promise<ResolvedConfig> {
  const options = program.opts<GlobalOptions>()
  const config = await loadConfig({
    ...(options.endpoint?.length ? { endpoints: options.endpoint } : {}),
    ...(options.config ? { configPath: options.config } : {}),
  })
  if (!options.timeout) return config
  return {
    ...config,
    requestTimeoutMs: positiveInteger(options.timeout, "timeout"),
    timeoutSource: "cli",
  }
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function hasOptionBeforeTerminator(arguments_: readonly string[], option: string): boolean {
  const terminator = arguments_.indexOf("--")
  const parsedArguments = terminator === -1 ? arguments_ : arguments_.slice(0, terminator)
  return parsedArguments.includes(option)
}

function joinQueryWords(words: readonly string[]): string | undefined {
  const query = words.join(" ").replace(/\s+/gu, " ").trim()
  return query || undefined
}

function parseTuiView(value: string): TuiView {
  return value.trim().toLowerCase() === "search" ? "search" : parseTopPeriod(value)
}

async function resolveSearchQuery(value: string | undefined): Promise<string | undefined> {
  const explicit = value?.trim()
  if (explicit) return explicit
  if (process.stdin.isTTY) return undefined
  const piped = (await Bun.stdin.text()).replace(/\s+/gu, " ").trim()
  return piped || undefined
}

function categoryIds(filter: CategoryFilter): readonly number[] {
  return Array.isArray(filter) ? filter : [filter as number]
}

function positiveInteger(value: string, label: string): number {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`)
  return number
}

function nonNegativeInteger(value: string, label: string): number {
  const number = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be zero or a positive integer.`)
  return number
}

function printTorrentTable(torrents: readonly TorrentSummary[], sort: SortOrder, includeMagnet: boolean, reversed = false): void {
  if (torrents.length === 0) return
  const width = Math.max(24, (process.stdout.columns ?? 120) - 12)
  console.log(`${"ID".padStart(9)}  ${formatResultHeader(width, sort, reversed)}`)
  console.log(`${"─".repeat(9)}  ${"─".repeat(width)}`)
  for (const torrent of torrents) {
    console.log(`${sanitizeSingleLine(torrent.id).padStart(9)}  ${formatResultLine(torrent, width)}`)
    if (includeMagnet) console.log(`${"".padStart(11)}${createMagnetUri(torrent)}`)
  }
}

function serializeTorrent(torrent: TorrentSummary, includeMagnet = false): Record<string, unknown> {
  return {
    ...torrent,
    addedAt: torrent.addedAt.toISOString(),
    ...(includeMagnet ? { magnet: createMagnetUri(torrent) } : {}),
  }
}

function serializeSearchResponse(response: SearchResponse, includeMagnet: boolean): Record<string, unknown> {
  const availableResults = response.availableResults ?? response.results.length
  return {
    endpoint: response.endpoint,
    resultCount: response.results.length,
    availableResults,
    ...(response.unfilteredResults !== undefined ? { unfilteredResults: response.unfilteredResults, filteredOut: response.unfilteredResults - availableResults } : {}),
    truncated: response.results.length < availableResults,
    ...(response.partial ? { partial: true, failedSources: response.failedSources ?? 1 } : {}),
    results: response.results.map((torrent) => serializeTorrent(torrent, includeMagnet)),
  }
}

function resultCountLabel(response: SearchResponse): string {
  const shown = response.results.length
  const available = response.availableResults ?? shown
  if (shown < available) return `${shown} of ${available} results shown`
  return `${shown} result${shown === 1 ? "" : "s"}`
}

function printPartialWarning(response: SearchResponse): void {
  if (!response.partial) return
  const count = response.failedSources ?? 1
  console.error(`Warning: partial results; ${count} source${count === 1 ? " was" : "s were"} unavailable.\n`)
}

try {
  await program.parseAsync(process.argv)
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode
    if (error.exitCode !== 0 && jsonOutputRequested) {
      console.error(JSON.stringify({
        error: error.message.replace(/^error:\s*/i, ""),
        code: error.code,
      }, null, 2))
    }
  } else {
    const message = sanitizeSingleLine(error instanceof Error ? error.message : String(error))
    console.error(jsonOutputRequested ? JSON.stringify(serializeCliError(error, message), null, 2) : `node-pirate: ${message}`)
    process.exitCode = 1
  }
}

function serializeCliError(error: unknown, message: string): Record<string, unknown> {
  if (error instanceof EndpointPoolError) {
    return {
      error: message,
      code: "ENDPOINT_POOL_FAILURE",
      operation: error.operation,
      failures: error.failures,
    }
  }
  return { error: message }
}
