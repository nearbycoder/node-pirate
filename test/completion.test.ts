import { describe, expect, test } from "bun:test"
import { completionCandidates, completionScript, resolveCompletionShell } from "../src/completion.ts"

describe("shell completion", () => {
  test("resolves explicit shells or infers a supported login shell", () => {
    expect(resolveCompletionShell("bash", "/bin/fish")).toBe("bash")
    expect(resolveCompletionShell(undefined, "/usr/bin/zsh")).toBe("zsh")
    expect(() => resolveCompletionShell(undefined, "/bin/pwsh")).toThrow("Use bash, zsh, or fish")
  })

  test("completes commands, global options, and structured values", () => {
    expect(completionCandidates(["se"])).toEqual(["search"])
    expect(completionCandidates(["--endpoint", "https://api.example", "t"])).toEqual(["top", "tui"])
    expect(completionCandidates(["search", "--category", "m"])).toEqual(["movies"])
    expect(completionCandidates(["search", "--sort", "s"])).toEqual(["seeders", "size"])
    expect(completionCandidates(["search", "--direction", "d"])).toEqual(["desc"])
    expect(completionCandidates(["top", "w"])).toEqual(["week"])
    expect(completionCandidates(["completion", "f"])).toEqual(["fish"])
    expect(completionCandidates(["search", "--j"])).toEqual(["--json", "--jsonl"])
    expect(completionCandidates(["tui", "--view", "2"])).toEqual(["24h"])
    expect(completionCandidates(["tui", "--category", "t"])).toEqual(["tv"])
  })

  test("emits self-contained setup for bash, zsh, and fish", () => {
    const bash = completionScript("bash")
    const zsh = completionScript("zsh")
    const fish = completionScript("fish")
    expect(bash).toContain("complete -F _node_pirate_completion node-pirate")
    expect(bash).toContain('node-pirate __complete -- "${COMP_WORDS[@]:1}"')
    expect(zsh).toStartWith("#compdef node-pirate")
    expect(zsh).toContain("compdef _node_pirate_completion node-pirate")
    expect(fish).toContain("complete -c node-pirate")
    expect(fish).toContain("commandline -ct")
  })
})
