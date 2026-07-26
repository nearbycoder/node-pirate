import { expect, test } from "bun:test"
import { BoxRenderable, MouseButton } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import type { CategoryFilter, SearchResponse, TorrentDataSource } from "../src/domain.ts"
import { createTui } from "../src/tui.ts"
import { details, torrent } from "./fixtures.ts"

test("OpenTUI renders and drives an API search", async () => {
  const setup = await createTestRenderer({ width: 120, height: 28 })
  const searches: string[] = []
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/", "https://backup.example/"],
    async search(options) {
      searches.push(options.query)
      return {
        endpoint: "https://user:secret@backup.example/",
        results: [torrent()],
        availableResults: 3,
        partial: true,
        failedSources: 2,
      }
    },
    async top() {
      return { endpoint: "https://backup.example/", results: [torrent()] }
    },
    async details() {
      return { endpoint: "https://backup.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }

  const app = createTui(setup.renderer, source)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("NODE PIRATE  /  JSON API MODE")
  expect(setup.captureCharFrame()).toContain("Search legal torrents")

  app.input.focus()
  await setup.mockInput.typeText("ubuntu")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => app.results.options.length === 1)
  await setup.renderOnce()

  const frame = setup.captureCharFrame()
  expect(searches).toEqual(["ubuntu"])
  expect(frame).toContain("Ubuntu 22.04 LTS")
  expect(frame).toContain("05/18/2022")
  expect(frame).toContain("1 of 3 results via backup.example")
  expect(frame).toContain("partial: 2 sources unavailable")
  expect(frame).not.toContain("secret")
  app.destroy()
})

test("starts in a requested view, category, sort, and direction", async () => {
  const setup = await createTestRenderer({ width: 120, height: 28 })
  let topOptions: Parameters<TorrentDataSource["top"]>[0] | undefined
  const alpha = torrent({ id: "1", name: "Alpha release", infoHash: "1".repeat(40), category: 207 })
  const zulu = torrent({ id: "2", name: "Zulu release", infoHash: "2".repeat(40), category: 207 })
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [] }
    },
    async top(options) {
      topOptions = options
      return { endpoint: "https://api.example/", results: [alpha, zulu] }
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }

  const app = createTui(setup.renderer, source, {
    initialView: "week",
    initialCategory: 207,
    initialSort: "name",
    initialReverse: true,
  })
  await setup.waitFor(() => Boolean(topOptions) && app.results.options.length === 2)
  await setup.renderOnce()

  expect(topOptions?.period).toBe("week")
  expect(topOptions?.category).toBe(207)
  expect(topOptions?.sort).toBe("name")
  expect(topOptions?.reverse).toBeTrue()
  expect(app.results.options[0]?.value).toEqual(zulu)
  const frame = setup.captureCharFrame()
  expect(frame).toContain("Top downloads · 7 days")
  expect(frame).toContain("Category: category 207")
  expect(frame).toContain("Name↓")
  app.destroy()
})

test("keyboard controls remain reachable when a view has no results", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24 })
  const topRequests: Array<Parameters<TorrentDataSource["top"]>[0]> = []
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [] }
    },
    async top(options) {
      topRequests.push(options)
      return { endpoint: "https://api.example/", results: [] }
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }

  const app = createTui(setup.renderer, source, { initialView: "week" })
  await setup.waitFor(() => topRequests.length === 1)
  expect(app.input.focused).toBeTrue()
  await setup.mockInput.typeText("q")
  expect(app.input.value).toBe("q")

  setup.mockInput.pressTab()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("all-tab")
  setup.mockInput.pressTab()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("day-tab")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => topRequests.length === 2)
  expect(topRequests[1]?.period).toBe("day")

  setup.mockInput.pressTab()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("week-tab")
  setup.mockInput.pressTab()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("search-tab")
  setup.mockInput.pressTab()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("category-button")
  setup.mockInput.pressTab({ shift: true })
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("search-tab")
  setup.mockInput.pressTab()
  setup.mockInput.pressKey(" ")
  await setup.waitFor(() => topRequests.length === 3)
  expect(topRequests[2]?.category).toBe(100)

  setup.mockInput.pressKey("/")
  expect(app.input.focused).toBeTrue()
  setup.mockInput.pressEscape()
  await Bun.sleep(50)
  expect(setup.renderer.isDestroyed).toBeTrue()
})

test("mouse selects results, shows magnet links, and activates top views", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30 })
  let detailsCalls = 0
  let topCalls = 0
  const first = torrent({ id: "1", infoHash: "1".repeat(40), name: "First result", addedAt: new Date("2022-05-18T12:00:00Z") })
  const second = torrent({ id: "2", infoHash: "2".repeat(40), name: "Second result", addedAt: new Date("2024-06-20T12:00:00Z") })
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [first, second] }
    },
    async top() {
      topCalls += 1
      return { endpoint: "https://api.example/", results: [second] }
    },
    async details() {
      detailsCalls += 1
      return {
        endpoint: "https://api.example/",
        torrent: details({ ...second, description: "Long details line\n".repeat(100) }),
      }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await app.search("linux")
  await setup.renderOnce()

  await setup.mockMouse.click(app.results.screenX + 3, app.results.screenY + 1)
  expect(app.results.getSelectedIndex()).toBe(1)
  await setup.waitFor(() => detailsCalls > 0)
  expect(app.modal.visible).toBeTrue()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("modal-scroll")
  setup.mockInput.pressArrow("down")
  await setup.renderOnce()
  expect(app.modalScroll.scrollTop).toBeGreaterThan(0)

  await setup.mockMouse.click(app.showAction.screenX + 2, app.showAction.screenY + 1)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Magnet link")
  expect(setup.captureCharFrame()).toContain("IMDb title search:")
  setup.mockInput.pressKey("q")
  await setup.renderOnce()
  expect(app.modal.visible).toBeFalse()

  await setup.mockMouse.click(app.sortHeader.screenX + app.sortHeader.width - 4, app.sortHeader.screenY)
  expect(app.results.options[0]?.value).toEqual(second)
  await setup.mockMouse.click(app.sortHeader.screenX + app.sortHeader.width - 4, app.sortHeader.screenY)
  expect(app.results.options[0]?.value).toEqual(first)

  setup.resize(80, 24)
  await setup.renderOnce()
  expect(app.results.options.every((option) => /\d{2}\/\d{2}\/\d{4}/.test(option.name))).toBeTrue()

  const dayTab = setup.renderer.root.findDescendantById("day-tab") as BoxRenderable
  await setup.mockMouse.click(dayTab.screenX + 2, dayTab.screenY + 1)
  await setup.waitFor(() => topCalls === 1)
  expect(app.results.options[0]?.value).toEqual(second)
  app.destroy()
})

test("compact mode keeps navigation and modal actions usable after resize", async () => {
  const setup = await createTestRenderer({ width: 44, height: 16 })
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async top() {
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await setup.waitFor(() => app.results.options.length === 1)
  await setup.renderOnce()

  for (const id of ["all-tab", "day-tab", "week-tab", "search-tab", "category-button"]) {
    const control = setup.renderer.root.findDescendantById(id) as BoxRenderable
    expect(control.screenX).toBeGreaterThanOrEqual(0)
    expect(control.screenX + control.width).toBeLessThanOrEqual(44)
  }
  expect(setup.captureCharFrame()).toContain("Cat:all")

  app.results.selectCurrent()
  await setup.waitFor(() => app.modal.visible)
  await setup.renderOnce()
  expect(app.modal.screenX).toBeGreaterThanOrEqual(0)
  expect(app.modal.screenX + app.modal.width).toBeLessThanOrEqual(44)
  expect(app.modal.screenY + app.modal.height).toBeLessThanOrEqual(16)
  expect(setup.captureCharFrame()).toContain("Magnet")
  expect(setup.captureCharFrame()).toContain("IMDb")

  setup.resize(100, 24)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Copy IMDb search")
  app.destroy()
})

test("details modal actions support Tab, Shift+Tab, Enter, and Space", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async top() {
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await setup.waitFor(() => app.results.options.length === 1)
  app.results.selectCurrent()
  await setup.waitFor(() => app.modal.visible)
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("modal-scroll")

  setup.mockInput.pressTab()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("copy-magnet")
  setup.mockInput.pressTab()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("show-magnet")
  setup.mockInput.pressEnter()
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Magnet link:")
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("modal-scroll")

  setup.mockInput.pressTab({ shift: true })
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("close-modal")
  setup.mockInput.pressKey(" ")
  await setup.renderOnce()
  expect(app.modal.visible).toBeFalse()
  expect(setup.renderer.currentFocusedRenderable?.id).toBe("results")
  app.destroy()
})

test("category navigation cycles forward and backward with mouse or keyboard", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const seenCategories: CategoryFilter[] = []
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async top(options) {
      seenCategories.push(options.category ?? 0)
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await setup.waitFor(() => seenCategories.length === 1)
  const category = setup.renderer.root.findDescendantById("category-button") as BoxRenderable

  await setup.mockMouse.click(category.screenX + 2, category.screenY + 1)
  await setup.waitFor(() => seenCategories.length === 2)
  expect(seenCategories[1]).toBe(100)

  await setup.mockMouse.click(category.screenX + 2, category.screenY + 1, MouseButton.RIGHT)
  await setup.waitFor(() => seenCategories.length === 3)
  expect(seenCategories[2]).toBe(0)

  app.results.focus()
  setup.mockInput.pressKey("c", { shift: true })
  await setup.waitFor(() => seenCategories.length === 4)
  expect(seenCategories[3]).toBe(600)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Category: other")
  app.destroy()
})

test("clicking a visible row after mouse-wheel scrolling opens the matching torrent", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const items = Array.from({ length: 30 }, (_, index) => torrent({
    id: String(index),
    name: `Result ${String(index).padStart(2, "0")}`,
    infoHash: index.toString(16).toUpperCase().padStart(40, "0"),
    seeders: 30 - index,
  }))
  let openedId: string | undefined
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: items }
    },
    async top() {
      return { endpoint: "https://api.example/", results: [] }
    },
    async details(id) {
      openedId = id
      const selected = items.find((item) => item.id === id)!
      return { endpoint: "https://api.example/", torrent: details(selected) }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await app.search("results")
  await setup.renderOnce()

  for (let index = 0; index < 8; index += 1) {
    await setup.mockMouse.scroll(app.results.screenX + 3, app.results.screenY + 1, "down")
  }
  await setup.renderOnce()
  const selected = app.results.getSelectedIndex()
  const visibleItems = Math.max(1, app.results.height)
  const firstVisible = Math.max(0, Math.min(
    selected - Math.floor(visibleItems / 2),
    app.results.options.length - visibleItems,
  ))
  expect(firstVisible).toBeGreaterThan(0)
  expect(setup.captureCharFrame()).toContain(`Result ${String(firstVisible).padStart(2, "0")}`)

  await setup.mockMouse.click(app.results.screenX + 3, app.results.screenY)
  await setup.waitFor(() => openedId !== undefined)
  expect(openedId).toBe(String(firstVisible))
  app.destroy()
})

test("the default All load does not steal focus from a query being typed", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  let releaseTop: ((value: { endpoint: string; results: ReturnType<typeof torrent>[] }) => void) | undefined
  let topStarted = false
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [] }
    },
    async top() {
      topStarted = true
      return new Promise((resolve) => {
        releaseTop = resolve
      })
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await setup.waitFor(() => topStarted)
  app.input.focus()
  await setup.mockInput.typeText("ubuntu")
  releaseTop?.({ endpoint: "https://api.example/", results: [torrent()] })
  await setup.waitFor(() => app.results.options.length === 1)

  expect(app.input.value).toBe("ubuntu")
  expect(app.input.focused).toBeTrue()
  app.destroy()
})

test("a cancelled search cannot overwrite a newer response", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const resolvers = new Map<string, (response: SearchResponse) => void>()
  const signals = new Map<string, AbortSignal | undefined>()
  const firstResult = torrent({ id: "1", infoHash: "1".repeat(40), name: "Stale result" })
  const secondResult = torrent({ id: "2", infoHash: "2".repeat(40), name: "Current result" })
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    search(options) {
      signals.set(options.query, options.signal)
      return new Promise((resolve) => resolvers.set(options.query, resolve))
    },
    async top() {
      return { endpoint: "https://api.example/", results: [] }
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  const firstLoad = app.search("first")
  await setup.waitFor(() => resolvers.has("first"))
  const secondLoad = app.search("second")
  await setup.waitFor(() => resolvers.has("second"))
  expect(signals.get("first")?.aborted).toBeTrue()

  resolvers.get("second")?.({ endpoint: "https://api.example/", results: [secondResult] })
  await secondLoad
  expect(app.results.options[0]?.value).toEqual(secondResult)

  resolvers.get("first")?.({ endpoint: "https://api.example/", results: [firstResult] })
  await firstLoad
  await setup.renderOnce()
  expect(app.results.options[0]?.value).toEqual(secondResult)
  expect(setup.captureCharFrame()).toContain("Current result")
  expect(setup.captureCharFrame()).not.toContain("Stale result")
  app.destroy()
})

test("switching to the idle Search tab cancels and ignores a late top response", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  let resolveTop: ((response: SearchResponse) => void) | undefined
  let topSignal: AbortSignal | undefined
  let topReturned = false
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [] }
    },
    top(options) {
      topSignal = options.signal
      return new Promise<SearchResponse>((resolve) => {
        resolveTop = resolve
      }).finally(() => {
        topReturned = true
      })
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await setup.waitFor(() => resolveTop !== undefined)
  await setup.renderOnce()
  const searchTab = setup.renderer.root.findDescendantById("search-tab") as BoxRenderable
  await setup.mockMouse.click(searchTab.screenX + 2, searchTab.screenY + 1)
  expect(topSignal?.aborted).toBeTrue()

  resolveTop?.({ endpoint: "https://api.example/", results: [torrent({ name: "Late top result" })] })
  await setup.waitFor(() => topReturned)
  await setup.renderOnce()
  expect(app.results.options).toHaveLength(0)
  expect(setup.captureCharFrame()).toContain("Search results")
  expect(setup.captureCharFrame()).not.toContain("Late top result")
  expect(app.input.focused).toBeTrue()
  app.destroy()
})

test("r forces a fresh top-feed load", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const refreshValues: Array<boolean | undefined> = []
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [] }
    },
    async top(options) {
      refreshValues.push(options.refresh)
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await setup.waitFor(() => refreshValues.length === 1)
  setup.mockInput.pressKey("r")
  await setup.waitFor(() => refreshValues.length === 2)

  expect(refreshValues).toEqual([false, true])
  app.destroy()
})

test("question mark opens a non-destructive in-app help modal", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [] }
    },
    async top() {
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async details() {
      return { endpoint: "https://api.example/", torrent: details() }
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await setup.waitFor(() => app.results.options.length === 1)
  setup.mockInput.pressKey("?")
  await setup.renderOnce()

  const actions = setup.renderer.root.findDescendantById("modal-actions") as BoxRenderable
  expect(app.modal.visible).toBeTrue()
  expect(actions.visible).toBeFalse()
  expect(setup.captureCharFrame()).toContain("NODE PIRATE HELP")
  setup.mockInput.pressKey("q")
  await setup.renderOnce()
  expect(app.modal.visible).toBeFalse()

  app.input.focus()
  setup.mockInput.pressKey("F1")
  await setup.renderOnce()
  expect(app.modal.visible).toBeTrue()
  setup.mockInput.pressKey("q")
  await setup.renderOnce()
  expect(app.input.focused).toBeTrue()
  app.destroy()
})

test("closing details aborts its pending request", async () => {
  const setup = await createTestRenderer({ width: 100, height: 24 })
  let detailsStarted = false
  let detailsAborted = false
  const source: TorrentDataSource = {
    endpoints: ["https://api.example/"],
    async search() {
      return { endpoint: "https://api.example/", results: [torrent()] }
    },
    async top() {
      return { endpoint: "https://api.example/", results: [] }
    },
    async details(_id, signal) {
      detailsStarted = true
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          detailsAborted = true
          reject(signal.reason)
        }, { once: true })
      })
    },
    async health() {
      return []
    },
  }
  const app = createTui(setup.renderer, source)
  await app.search("ubuntu")
  app.results.selectCurrent()
  await setup.waitFor(() => detailsStarted)
  setup.mockInput.pressKey("q")
  await setup.waitFor(() => detailsAborted)

  expect(app.modal.visible).toBeFalse()
  app.destroy()
})
