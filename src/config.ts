import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_ENDPOINTS, normalizeEndpoint } from "./api.ts"

interface NodePirateConfig {
  apiEndpoints?: string[]
  requestTimeoutMs?: number
}

export type ConfigSource = "cli" | "environment" | "config" | "default"

export interface ResolvedConfig {
  endpoints: string[]
  requestTimeoutMs: number
  configPath: string
  endpointSource: ConfigSource
  timeoutSource: ConfigSource
}

export async function loadConfig(options: {
  endpoints?: string[]
  configPath?: string
  env?: Record<string, string | undefined>
} = {}): Promise<ResolvedConfig> {
  const env = options.env ?? process.env
  const configPath = options.configPath ?? env.NODE_PIRATE_CONFIG ?? defaultConfigPath(env)
  const fileConfig = await readConfig(configPath)
  const envEndpoints = splitEndpoints(env.NODE_PIRATE_ENDPOINTS)
  const endpointSource: ConfigSource = options.endpoints?.length
    ? "cli"
    : envEndpoints.length
      ? "environment"
      : fileConfig.apiEndpoints?.length
        ? "config"
        : "default"
  const endpointCandidates = endpointSource === "cli"
    ? options.endpoints!
    : endpointSource === "environment"
      ? envEndpoints
      : endpointSource === "config"
        ? fileConfig.apiEndpoints!
        : [...DEFAULT_ENDPOINTS]

  const timeoutText = env.NODE_PIRATE_TIMEOUT_MS?.trim()
  if (timeoutText && !isPositiveInteger(timeoutText)) {
    throw new Error("NODE_PIRATE_TIMEOUT_MS must be a positive integer.")
  }
  const timeoutFromEnv = timeoutText ? Number(timeoutText) : undefined
  const timeoutSource = timeoutFromEnv !== undefined ? "environment" : fileConfig.requestTimeoutMs ? "config" : "default"
  return {
    endpoints: [...new Set(endpointCandidates.map(normalizeEndpoint))],
    requestTimeoutMs:
      timeoutFromEnv !== undefined
        ? timeoutFromEnv
        : fileConfig.requestTimeoutMs ?? 8_000,
    configPath,
    endpointSource,
    timeoutSource,
  }
}

function defaultConfigPath(env: Record<string, string | undefined>): string {
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(configHome, "node-pirate", "config.json")
}

async function readConfig(path: string): Promise<NodePirateConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root value must be an object")
    const object = value as Record<string, unknown>
    if ("apiEndpoints" in object && (!Array.isArray(object.apiEndpoints) || !object.apiEndpoints.every((item) => typeof item === "string"))) {
      throw new Error("apiEndpoints must be an array of URL strings")
    }
    if ("requestTimeoutMs" in object && (typeof object.requestTimeoutMs !== "number" || !Number.isSafeInteger(object.requestTimeoutMs) || object.requestTimeoutMs <= 0)) {
      throw new Error("requestTimeoutMs must be a positive integer")
    }
    return {
      ...(Array.isArray(object.apiEndpoints) && object.apiEndpoints.every((item) => typeof item === "string")
        ? { apiEndpoints: object.apiEndpoints }
        : {}),
      ...(typeof object.requestTimeoutMs === "number" && object.requestTimeoutMs > 0
        ? { requestTimeoutMs: object.requestTimeoutMs }
        : {}),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw new Error(`Could not read config ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isPositiveInteger(value: string): boolean {
  const number = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0
}

function splitEndpoints(value: string | undefined): string[] {
  return value?.split(",").map((endpoint) => endpoint.trim()).filter(Boolean) ?? []
}
