import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"

const paths: string[] = []
afterEach(async () => Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe("configuration", () => {
  test("loads endpoint pools and timeout defaults from JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "node-pirate-"))
    paths.push(directory)
    const configPath = join(directory, "config.json")
    await writeFile(configPath, JSON.stringify({
      apiEndpoints: ["https://one.example/api", "https://two.example"],
      requestTimeoutMs: 4321,
    }))

    const config = await loadConfig({ configPath, env: {} })
    expect(config.endpoints).toEqual(["https://one.example/api/", "https://two.example/"])
    expect(config.requestTimeoutMs).toBe(4321)
    expect(config.endpointSource).toBe("config")
    expect(config.timeoutSource).toBe("config")
  })

  test("explicit endpoints override environment and config", async () => {
    const config = await loadConfig({
      endpoints: ["https://cli.example"],
      configPath: "/definitely/missing/config.json",
      env: { NODE_PIRATE_ENDPOINTS: "https://env.example" },
    })
    expect(config.endpoints).toEqual(["https://cli.example/"])
    expect(config.endpointSource).toBe("cli")
  })

  test("rejects malformed environment timeouts", async () => {
    expect(loadConfig({
      configPath: "/definitely/missing/config.json",
      env: { NODE_PIRATE_TIMEOUT_MS: "8000junk" },
    })).rejects.toThrow("NODE_PIRATE_TIMEOUT_MS must be a positive integer")
  })

  test("reports malformed config fields instead of silently ignoring them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "node-pirate-"))
    paths.push(directory)
    const configPath = join(directory, "config.json")
    await writeFile(configPath, JSON.stringify({ apiEndpoints: "https://wrong.example" }))
    expect(loadConfig({ configPath, env: {} })).rejects.toThrow("apiEndpoints must be an array")
  })
})
