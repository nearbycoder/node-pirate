# node-pirate

A modern terminal client for searching legal torrents indexed by The Pirate Bay. The 1.0 rewrite uses [OpenTUI](https://github.com/anomalyco/opentui), TypeScript, and API Bay's JSON responses. It no longer scrapes HTML and has no Cheerio, `request`, or legacy prompt dependencies.

Only search for and download content you have the legal right to access.

## Security hardening in 1.0.1

- Torrent IDs are restricted to bounded ASCII digits before they reach terminal output or follow-up requests
- Remote text is length-bounded, normalized to well-formed Unicode, and stripped of ANSI, OSC, C0/C1, and bidirectional formatting controls
- API responses are streamed with a 4 MiB limit, and result arrays are capped at 5,000 entries before parsing or sorting
- Redirects are followed manually for at most three hops and must remain on the configured endpoint's origin
- Endpoint credentials stay private, are redacted from public state and diagnostics, and require HTTPS except for loopback development
- CI verifies the locked dependency tree, known advisories, registry signatures, tests, production build, and exact npm package contents

## What changed in 1.0

- Full-screen OpenTUI search, daily/weekly top downloads, result navigation, detail preview, and magnet retrieval
- First-class mouse support for tabs, filters, rows, scrolling, details, and magnet actions
- Full-width responsive results with clickable sortable headers and `MM/DD/YYYY` dates
- Scrollable details modal with Copy magnet, Show link, Copy IMDb search, and Close actions—no permanent sidebar
- API Bay JSON (`q.php` and `t.php`) instead of brittle HTML selectors
- Automatic failover across any number of API-compatible endpoints
- Noninteractive `search`, `top`, `details`, `magnet`, `imdb`, `download`, `endpoints`, `categories`, and `config` commands
- Bash, Zsh, and Fish completion for commands, options, categories, sort orders, and top periods
- Client-side sorting by seeders, leechers, date, size, or name
- Typed response validation, per-endpoint timeouts, and clear aggregate errors
- Unicode-aware table alignment plus ANSI/OSC control-sequence sanitization for API metadata
- No embedded downloader, tracker stack, or automatic magnet launching
- Unit, failover, and native OpenTUI render tests

## Requirements

- [Bun](https://bun.sh/) 1.2 or newer to run OpenTUI's native renderer
- A terminal around 80×20 for the most comfortable layout; compact mode keeps navigation and modal actions usable at narrower practical sizes

OpenTUI can also render on Node.js 26.4+ with experimental FFI, but this project deliberately uses Bun so the installed command works without experimental Node flags.

## Install

```sh
npm install
npm run build
npm link
```

For development:

```sh
npm run dev
```

## Shell completion

Load completion for the current shell session:

```sh
# Bash
source <(node-pirate completion bash)

# Zsh
source <(node-pirate completion zsh)

# Fish
node-pirate completion fish | source
```

With no argument, `node-pirate completion` infers Bash, Zsh, or Fish from `SHELL`. Redirect the generated script into your shell's normal completion directory for persistent setup. Completion is local and makes no API request.

## Interactive interface

Launch the TUI:

```sh
node-pirate
node-pirate tui
node-pirate tui "ubuntu linux"
node-pirate tui --view week --category movies --sort date
node-pirate tui --view all --category tv --sort name --direction desc
```

The `tui` command can initialize `--view all|day|24h|week|7d|search`, any named or numeric `--category`, a `--sort` column, and either `--direction asc|desc` or `--reverse`. A positional query selects Search automatically; when `--view` is also supplied with a query it must explicitly be `search`, avoiding an ambiguous startup state.

The interactive interface requires both terminal input and output. A bare `node-pirate` invocation in a pipe or CI job prints command help instead of emitting terminal-control sequences; an explicit noninteractive `node-pirate tui` exits with guidance to use `search`, `top`, or another command-mode operation.

Keyboard shortcuts:

| Key | Action |
| --- | --- |
| `Enter` | Search from the query, open selected details, or activate a focused view/category control |
| `Space` | Activate a focused view/category control or modal action |
| `Tab` / `Shift+Tab` | Cycle through query, views, category, sortable header, and results; cycle visible actions inside a modal |
| `↑` / `↓`, `j` / `k` | Navigate results |
| `←` / `→` on header | Sort by the previous or next visible column |
| `Enter` / `Space` on header | Reverse the active sort direction |
| `/` | Focus the query field |
| `c` / `Shift+C` | Cycle category forward or backward and reload the active view |
| `s` / `Shift+S` | Cycle to the next visible sort column / reverse the active direction |
| `r` | Force-refresh the current view, bypassing the short-lived feed cache |
| `1` / `2` / `3` / `4` | All / Top 24h / Top week / Search when the query is not focused |
| `m` | Copy the selected magnet URI with OSC 52 |
| `u` | Copy the title-based IMDb search link while the details modal is open |
| `v` | Show the selected magnet link in the modal |
| `q` | Close a modal, or quit when the query is not focused |
| `Esc` | Close a modal or quit from any main control, including the query |
| `?` / `F1` | Open the scrollable in-app help modal |

Mouse controls:

| Action | Result |
| --- | --- |
| Click `All`, `Top 24h`, `Top week`, or `Search` | Switch views; All is first/default and removes the date cutoff |
| Click category | Cycle the filter forward and reload the active view; Movies and TV are separate filters |
| Right-click category | Cycle the category backward |
| Click Type, Name, Seeds, Leech, Size, or Date | Sort that column; click again to reverse |
| Click a result | Open its scrollable details modal; use arrows or the mouse wheel to scroll |
| Mouse wheel over results | Scroll the list |
| Right-click a result | Copy its magnet link |
| Click `Copy magnet` | Copy the selected magnet link with OSC 52 |
| Click `Show link` | Show the selected magnet link in the modal |
| Click `Copy IMDb search` | Copy an IMDb search URL generated from the torrent title |
| Click `Close` | Close the modal and return to the full-width table |

If OpenTUI cannot emit OSC 52, the magnet action shows the complete link in the modal so it can still be copied. Some terminals and multiplexers silently block clipboard sequences even after accepting them; use **Show link** if the clipboard does not change. Human-readable dates use `MM/DD/YYYY`; JSON output retains ISO timestamps.

Magnet output uses the canonical Deluge-compatible prefix `magnet:?xt=urn:btih:...` without percent-encoding the `urn:btih:` portion. The display name and tracker values remain safely encoded.

## Filtering results

Both `search` and `top` support the same filters:

```sh
# Exclude unwanted releases and require active seeders
node-pirate search ubuntu --exclude beta --exclude arm64 --min-seeders 5

# Require every included phrase and keep sizes within a range
node-pirate search debian --include amd64 --include netinst --min-size 100MB --max-size 2GiB

# Narrow rankings by uploader status and upload date
node-pirate top all --trusted --after 2026-01-01 --before 2026-09-19

# Export a clean list, one value per line
node-pirate search ubuntu --uploader publisher --limit 5 --ids
node-pirate search debian --exclude beta --limit 5 --magnets > magnets.txt
```

| Option | Behavior |
| --- | --- |
| `--include-any <text>` | Require at least one of these title terms; repeat for alternatives |
| `--include <text>` | Require a literal substring in the title; repeat to require every term |
| `--exclude <text>` | Hide any title containing a literal substring; repeat for more exclusions |
| `--min-seeders <number>` | Require at least this many seeders; `0` permits unseeded results |
| `--min-size <size>`, `--max-size <size>` | Inclusive byte-size bounds; accept bytes, KB/MB/GB/TB, or KiB/MiB/GiB/TiB |
| `--uploader <name>` | Match an exact uploader name |
| `--trusted` | Keep API-reported `trusted` and `vip` statuses |
| `--after <YYYY-MM-DD>`, `--before <YYYY-MM-DD>` | Inclusive upload-date bounds in UTC |

Text and uploader matching ignore case. Text is literal, so punctuation is not interpreted as a regular expression. All filters combine with AND. MB/GB use powers of 1000; MiB/GiB use powers of 1024. Status filtering reflects upstream metadata, not a guarantee about a file.

Filters run locally on the fetched feeds, before `--limit`. Use `--limit 0` for all matches available in those feeds. Human output reports how many entries were filtered out and suggests widening filters when nothing matches. JSON includes normalized `request.filters`, `unfilteredResults`, and `filteredOut` when filters are active; `availableResults` counts matches before the limit.

`--ids` and `--magnets` produce only one value per line, with empty output and a successful exit when nothing matches. They cannot be combined with each other, `--json`, or `--magnet` (which adds links to the regular output). Partial-feed warnings still go to stderr.

## Command mode

```sh
# Human-readable results
node-pirate search "ubuntu linux" --category applications --sort seeders --limit 20
node-pirate search ubuntu linux --limit 20
node-pirate search ubuntu --limit 0
node-pirate search ubuntu --sort size --direction asc

# Machine-readable output
node-pirate search ubuntu --json
node-pirate details 59191690 --json
node-pirate details 59191690 --magnet
printf 'ubuntu linux\n' | node-pirate search --json

# Top downloads by time window and category
node-pirate top day --category video --limit 20
node-pirate top 24h --category movies --limit 20
node-pirate top day --category movies --limit 20
node-pirate top day --category tv --limit 20
node-pirate top week --category games --limit 20
node-pirate top 7d --category tv --limit 20
node-pirate top all --category movies --sort seeders
node-pirate top all --category tv --sort date
node-pirate top week --category movies --sort name --direction desc
node-pirate top all --category movies --sort name --reverse

# Magnet link output
node-pirate magnet 59191690
node-pirate imdb 59191690
node-pirate imdb 59191690 --search
node-pirate search ubuntu --limit 5 --magnet
node-pirate top day --limit 5 --magnet
# Legacy alias; also only prints the URI
node-pirate download 59191690

# Test every configured endpoint
node-pirate endpoints
node-pirate endpoints --json
# Useful in CI: fail if even one configured fallback is unavailable
node-pirate endpoints --strict

# Inspect effective endpoints, timeout, config path, and precedence sources
node-pirate config
node-pirate config --json

# Discover named filters and the IDs each composite category uses
node-pirate categories
node-pirate categories --json
```

The old option forms remain available where they are unambiguous:

```sh
node-pirate search --title ubuntu --category app --order s
node-pirate download --id 59191690
```

Use either the current or legacy form in one invocation: combining `--sort` with `--order`, a positional search with `--title`, or a positional download ID with `--id` reports an ambiguity instead of silently choosing one value. For both `search` and `top`, `--limit 0` returns every unique result available from the successfully fetched feeds.

Run `node-pirate --help` or `node-pirate <command> --help` for the complete command reference.

Search and top commands use the same default directions as the TUI: popularity, date, and size descend, while name and category ascend. Use `--direction asc` or `--direction desc` when the intended order should be explicit; `--reverse` remains available as a shorthand for flipping the default. The two forms conflict by design, and sorting is applied before `--limit`. Human table arrows and JSON's normalized `request.direction` always reflect the resolved order.

Multiword positional queries may be quoted or entered as separate arguments; `node-pirate search ubuntu linux` searches for the complete phrase rather than discarding trailing words. Use the standard `--` option terminator for a query beginning with a dash, such as `node-pirate search -- --json`; the query remains ordinary human output unless an actual `--json` option appeared before the terminator. When neither a positional query nor `--title` is supplied, `search` reads its phrase from piped stdin and collapses line breaks and repeated whitespace. Supplying both a positional query and the legacy `--title` alias is rejected as ambiguous. Top periods accept both command-style names (`day`, `week`) and the matching TUI labels (`24h`, `7d`); JSON always reports the canonical `day`, `week`, or `all` value.

Commands using `--json` also return validation and request failures as JSON on standard error with a nonzero exit status, so automation never needs to parse a human-formatted `node-pirate:` message. If every proxy fails, the payload includes `code: "ENDPOINT_POOL_FAILURE"`, the failed operation, and an ordered `failures` entry for every attempted endpoint.

Successful search and top JSON includes a normalized `request` object, `resultCount`, `availableResults`, and `truncated`. `availableResults` is the number of unique entries supplied by the successfully fetched selected API feeds after any filters and before `--limit` is applied; it is not a claim about every torrent on the index. Human output uses the same information, for example `20 of 73 results shown`, so a limited table is never mistaken for a complete response.

## Multiple API and proxy endpoints

The default data endpoint is `https://apibay.org/`. Add fallback mirrors by repeating `--endpoint`:

```sh
node-pirate \
  --endpoint https://primary.example/apibay/ \
  --endpoint https://backup.example/apibay/ \
  search ubuntu
```

Endpoints are tried in order. When one succeeds it becomes preferred for later requests in the same process. Timeouts, non-2xx responses, HTML responses, invalid JSON, and invalid torrent payloads all cause an automatic attempt against the next endpoint.

Authenticated endpoint URLs are supported. Embedded usernames, passwords, or tokens are decoded and sent as HTTP Basic authorization while the request URL itself remains credential-free. They are also removed from public client state, human output, JSON responses, health reports, resolved configuration, and aggregate errors. Credential-bearing remote endpoints must use HTTPS because Basic authorization encodes credentials but does not encrypt them; plaintext HTTP credentials are accepted only for loopback development.

Redirects are limited to three hops and must remain on the original endpoint origin. Cross-origin and credential-bearing redirect targets are rejected before they are requested. Response bodies are streamed with a 4 MiB limit, result arrays over 5,000 entries are rejected, and individual metadata fields are length-bounded before they are rendered or cached.

An endpoint must expose the API Bay-compatible paths `q.php` and `t.php`. A normal Pirate Bay HTML proxy is not enough; if a proxy hosts API Bay under a subpath, provide that subpath as shown above. This constraint is what lets the project avoid HTML scraping entirely.

You can also set a comma-separated environment variable:

```sh
export NODE_PIRATE_ENDPOINTS="https://one.example/apibay/,https://two.example/apibay/"
export NODE_PIRATE_TIMEOUT_MS=5000
node-pirate endpoints
```

Or create `~/.config/node-pirate/config.json` (respects `XDG_CONFIG_HOME`):

```json
{
  "apiEndpoints": [
    "https://apibay.org/",
    "https://backup.example/apibay/"
  ],
  "requestTimeoutMs": 8000
}
```

CLI endpoints override the environment, which overrides the config file, which overrides the built-in default. Use `NODE_PIRATE_CONFIG` or `--config` for a different config path.

`node-pirate config` shows the resolved values without making a network request. Each value includes its source (`cli`, `environment`, `config`, or `default`), which is useful when troubleshooting proxy precedence. Invalid timeout values and malformed config fields fail with an explicit message rather than being silently ignored; an endpoint timeout identifies the configured duration in its human or JSON failure details.

`node-pirate endpoints --json` reports `available`, `total`, and the latency and error state for every configured endpoint. By default the health check fails only when the entire pool is unavailable; add `--strict` in CI when any failed fallback should produce a nonzero exit status.

## Architecture

```text
OpenTUI / command output
          │
          ▼
typed TorrentDataSource
          │
          ▼
API endpoint pool ──► primary q.php / t.php
          │ failure
          ├──────────► proxy-hosted API mirror
          │ failure
          └──────────► next configured mirror
```

Search results are normalized once in `src/api.ts`; the TUI and every subcommand consume the same domain objects. Magnet URIs are derived locally from the returned info hash. Nothing automatically opens a magnet URI. The legacy `download` command is retained only as an alias that prints the same URI as `magnet`.

Independent top/category feeds load concurrently and successful feed responses are cached in memory for two minutes. Switching between top views is therefore fast and does not repeatedly hit the same proxy. Press `r` to bypass the cache. Cancelling or switching views aborts pending requests without counting the cancellation as an endpoint failure; request-identity guards also ignore late responses from sources that do not honor cancellation.

Top views and composite Movies/TV operations preserve every successful ranking or fallback response if another source is unavailable. Human output prints a warning, the TUI status turns amber, and JSON responses include `partial: true` plus `failedSources`. The command fails only when every requested source fails.

API Bay provides a 48-hour ranking rather than a dedicated 24-hour or seven-day feed. The `Top 24h` view filters that ranking and the recent feed to the last 24 hours. `Top week` merges the selected category rankings, category-specific recent pages, 48-hour ranking, and recent feed before deduplicating and filtering to seven days. `All` removes the time filter and merges every underlying ranking for composite filters—up to four feeds for Movies and two for TV. Every view can then be sorted by the clickable category, name, seeders, leechers, date, or size headers. This keeps the views API-only without reintroducing HTML scraping.

## Quality checks

```sh
npm run typecheck
npm test
npm run build
# or all three
npm run check
npm audit --audit-level=moderate
npm audit signatures
```

The test suite uses OpenTUI's memory renderer, so it verifies the real native layout and input path without modifying the current terminal. GitHub Actions also performs these checks on pull requests, pushes to `master`, and a weekly schedule; it rejects npm tarballs containing anything beyond `Readme.md`, `dist/node-pirate.js`, and `package.json`.

## Release integrity

npm releases are published by `.github/workflows/release.yml` from a GitHub Release whose `vX.Y.Z` tag matches `package.json` and points to a commit on `master`. The job re-runs the locked install, registry-signature and advisory audits, tests, build, and package allowlist before publishing through npm trusted publishing with provenance. The npm package's trusted publisher must allow `npm publish` for GitHub user `nearbycoder`, repository `node-pirate`, and workflow `release.yml`; no long-lived npm token is used by the workflow.
