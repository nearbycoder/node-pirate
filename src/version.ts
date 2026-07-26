import packageMetadata from "../package.json" with { type: "json" }

export const VERSION = packageMetadata.version
export const USER_AGENT = `node-pirate/${VERSION} (+https://github.com/nearbycoder/node-pirate)`
