import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeConfig, loadConfig } from "../src/config.ts"

test("config init creates a loadable private starter and refuses overwrite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "node-pirate-init-"))
  try {
    const env = { XDG_CONFIG_HOME: directory, NODE_PIRATE_ENDPOINTS: "https://user:secret@example.test" }
    const path = await initializeConfig({ env })
    expect(path).toBe(join(directory, "node-pirate", "config.json"))
    const initial = await readFile(path, "utf8")
    expect(initial).not.toContain("secret")
    expect((await loadConfig({ configPath: path, env: {} })).endpointSource).toBe("config")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(initializeConfig({ configPath: path })).rejects.toThrow("not overwritten")
    expect(await readFile(path, "utf8")).toBe(initial)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
