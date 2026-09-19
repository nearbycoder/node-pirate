export const supportedShells = ["bash", "zsh", "fish"] as const
export type SupportedShell = typeof supportedShells[number]

const commands = [
  "tui",
  "search",
  "top",
  "details",
  "magnet",
  "imdb",
  "download",
  "endpoints",
  "categories",
  "config",
  "completion",
] as const

const globalOptions = ["--help", "--version", "--endpoint", "--config", "--timeout"] as const
const filterOptions = ["--include", "--exclude", "--min-seeders", "--min-size", "--max-size", "--uploader", "--trusted", "--after", "--before", "--ids", "--magnets"] as const
const optionsByCommand: Record<string, readonly string[]> = {
  tui: ["--help", "--view", "--category", "--sort", "--direction", "--reverse"],
  search: [...filterOptions, "--help", "--title", "--category", "--sort", "--direction", "--reverse", "--order", "--limit", "--json", "--magnet"],
  top: [...filterOptions, "--help", "--category", "--sort", "--direction", "--reverse", "--limit", "--json", "--magnet"],
  details: ["--help", "--json", "--magnet"],
  magnet: ["--help"],
  imdb: ["--help", "--search"],
  download: ["--help", "--id"],
  endpoints: ["--help", "--json", "--strict"],
  categories: ["--help", "--json"],
  config: ["--help", "--json"],
  completion: ["--help"],
}

const categoryCandidates = ["all", "audio", "movies", "tv", "video", "applications", "games", "other"] as const
const sortCandidates = ["category", "seeders", "leechers", "date", "size", "name"] as const
const periodCandidates = ["day", "24h", "week", "7d", "all"] as const
const valueCandidates: Record<string, readonly string[]> = {
  "--category": categoryCandidates,
  "-c": categoryCandidates,
  "--sort": sortCandidates,
  "-s": sortCandidates,
  "--order": ["s", "l"],
  "-o": ["s", "l"],
  "--direction": ["asc", "desc"],
  "--view": ["all", "day", "24h", "week", "7d", "search"],
}
const valueOptions = new Set([
  ...filterOptions.filter((option) => !["--trusted", "--ids", "--magnets"].includes(option)),
  "--endpoint", "-e", "--config", "--timeout",
  "--title", "-t", "--view", "--category", "-c", "--sort", "-s", "--direction", "--order", "-o", "--limit", "-l", "--id", "-i",
])

export function resolveCompletionShell(value: string | undefined, shellEnvironment = process.env.SHELL): SupportedShell {
  const detected = (value ?? shellEnvironment?.split("/").at(-1) ?? "").trim().toLowerCase()
  if (supportedShells.includes(detected as SupportedShell)) return detected as SupportedShell
  throw new Error(`Unknown shell "${detected || "unspecified"}". Use bash, zsh, or fish.`)
}

export function completionCandidates(words: readonly string[]): string[] {
  const current = words.at(-1) ?? ""
  const completed = words.slice(0, -1)
  const previous = completed.at(-1)

  if (previous && valueOptions.has(previous)) {
    return filterCandidates(valueCandidates[previous] ?? [], current)
  }

  const context = findCommand(completed)
  if (!context) return filterCandidates([...commands, ...globalOptions], current)

  const commandOptions = [...(optionsByCommand[context.command] ?? []), ...globalOptions]
  if (current.startsWith("-")) return filterCandidates(commandOptions, current)

  const operands = commandOperands(completed.slice(context.index + 1))
  if (context.command === "top" && operands.length === 0) {
    return filterCandidates([...periodCandidates, ...(current ? [] : commandOptions)], current)
  }
  if (context.command === "completion" && operands.length === 0) {
    return filterCandidates([...supportedShells, ...(current ? [] : commandOptions)], current)
  }
  return current ? [] : filterCandidates(commandOptions, current)
}

export function completionScript(shell: SupportedShell): string {
  switch (shell) {
    case "bash":
      return [
        "_node_pirate_completion() {",
        "  local candidate",
        "  COMPREPLY=()",
        "  while IFS= read -r candidate; do",
        "    [[ -n $candidate ]] && COMPREPLY+=(\"$candidate\")",
        "  done < <(node-pirate __complete -- \"${COMP_WORDS[@]:1}\")",
        "}",
        "complete -F _node_pirate_completion node-pirate",
      ].join("\n")
    case "zsh":
      return [
        "#compdef node-pirate",
        "_node_pirate_completion() {",
        "  local -a candidates",
        "  candidates=(\"${(@f)$(node-pirate __complete -- \"${words[@]:1}\")}\")",
        "  compadd -- $candidates",
        "}",
        "compdef _node_pirate_completion node-pirate",
      ].join("\n")
    case "fish":
      return [
        "function __node_pirate_completion",
        "  set -l tokens (commandline -opc)",
        "  set -l current (commandline -ct)",
        "  command node-pirate __complete -- $tokens[2..-1] $current",
        "end",
        "complete -c node-pirate -f -a '(__node_pirate_completion)'",
      ].join("\n")
  }
}

function findCommand(words: readonly string[]): { command: string; index: number } | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (["--endpoint", "-e", "--config", "--timeout"].includes(word)) {
      index += 1
      continue
    }
    if (word.startsWith("-")) continue
    if ((commands as readonly string[]).includes(word)) return { command: word, index }
    return undefined
  }
  return undefined
}

function commandOperands(words: readonly string[]): string[] {
  const operands: string[] = []
  let optionsEnded = false
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!
    if (!optionsEnded && word === "--") {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && valueOptions.has(word)) {
      index += 1
      continue
    }
    if (!optionsEnded && word.startsWith("-")) continue
    operands.push(word)
  }
  return operands
}

function filterCandidates(candidates: readonly string[], prefix: string): string[] {
  return [...new Set(candidates)].filter((candidate) => candidate.startsWith(prefix)).sort()
}
