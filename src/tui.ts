import {
  BoxRenderable,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  MouseButton,
  RenderableEvents,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  link,
  t,
  type CliRenderer,
  type MouseEvent as TuiMouseEvent,
  type Renderable,
  type SelectOption,
} from "@opentui/core"
import {
  categoryGroups,
  type CategoryFilter,
  type SearchResponse,
  type SortOrder,
  type TopPeriod,
  type TorrentDataSource,
  type TorrentSummary,
  sortDirection,
  sortTorrents,
} from "./domain.ts"
import { formatDetails, formatResultHeader, formatResultLine, resultSortAtColumn, resultSortColumns } from "./format.ts"
import { createMagnetUri } from "./magnet.ts"
import { createImdbSearchUrl } from "./imdb.ts"

const CATEGORY_CYCLE: ReadonlyArray<readonly [string, CategoryFilter]> = categoryGroups.map((group) => [
  group.name === "video" ? "video (all)" : group.name,
  group.filter,
])
const SORT_CYCLE: SortOrder[] = ["seeders", "leechers", "date", "size", "name", "category"]
export type TuiView = "search" | TopPeriod
type ViewMode = TuiView
type ModalMode = "details" | "help"

export interface TuiController {
  readonly input: InputRenderable
  readonly results: SelectRenderable
  readonly sortHeader: TextRenderable
  readonly modal: BoxRenderable
  readonly modalScroll: ScrollBoxRenderable
  readonly copyAction: BoxRenderable
  readonly showAction: BoxRenderable
  readonly imdbAction: BoxRenderable
  search(query?: string): Promise<void>
  top(period: TopPeriod, refresh?: boolean): Promise<void>
  destroy(): void
}

export interface TuiOptions {
  initialQuery?: string
  initialView?: TuiView
  initialCategory?: CategoryFilter
  initialSort?: SortOrder
  initialReverse?: boolean
}

export function createTui(
  renderer: CliRenderer,
  source: TorrentDataSource,
  options: TuiOptions = {},
): TuiController {
  const requestedCategory = options.initialCategory ?? 0
  const knownCategoryIndex = CATEGORY_CYCLE.findIndex(([, filter]) => categoryFiltersEqual(filter, requestedCategory))
  const categoryCycle: ReadonlyArray<readonly [string, CategoryFilter]> = knownCategoryIndex >= 0
    ? CATEGORY_CYCLE
    : [...CATEGORY_CYCLE, [`category ${String(requestedCategory)}`, requestedCategory] as const]
  let torrents: TorrentSummary[] = []
  let categoryIndex = knownCategoryIndex >= 0 ? knownCategoryIndex : categoryCycle.length - 1
  let sortIndex = Math.max(0, SORT_CYCLE.indexOf(options.initialSort ?? "seeders"))
  let activeMode: ViewMode = options.initialView ?? (options.initialQuery?.trim() ? "search" : "all")
  let activeRequest: AbortController | undefined
  let activeDetailsRequest: AbortController | undefined
  let startupPending = true
  let sortReversed = options.initialReverse ?? false
  let modalTorrent: TorrentSummary | undefined
  let modalMode: ModalMode | undefined
  let modalReturnFocus: Renderable | null = null

  const root = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#071015",
  })
  const title = new TextRenderable(renderer, {
    id: "title",
    height: 1,
    content: " NODE PIRATE  /  JSON API MODE",
    fg: "#57E6B1",
  })

  const searchPanel = new BoxRenderable(renderer, {
    id: "search-panel",
    height: 3,
    border: true,
    borderStyle: "rounded",
    borderColor: "#245A64",
    focusedBorderColor: "#57E6B1",
    paddingX: 1,
    flexDirection: "row",
    alignItems: "center",
  })
  const input = new InputRenderable(renderer, {
    id: "query",
    flexGrow: 1,
    placeholder: "Search legal torrents…",
    value: options.initialQuery ?? "",
    textColor: "#E6F1F5",
    cursorColor: "#57E6B1",
    backgroundColor: "#071015",
    focusedBackgroundColor: "#10242B",
    onKeyDown(key) {
      if (key.name !== "escape") return
      key.preventDefault()
      key.stopPropagation()
      shutdown()
    },
  })
  searchPanel.add(input)

  const modeBar = new BoxRenderable(renderer, {
    id: "mode-bar",
    height: 3,
    flexDirection: "row",
    alignItems: "center",
  })
  const searchTab = makeButton("search-tab", " Search ", 10, activateSearchMode)
  const dayTab = makeButton("day-tab", " Top 24h ", 11, () => void top("day"))
  const weekTab = makeButton("week-tab", " Top week ", 12, () => void top("week"))
  const allTab = makeButton("all-tab", " All ", 9, () => void top("all"))
  const categoryButton = makeButton(
    "category-button",
    categoryText(),
    "auto",
    () => cycleCategory(1),
    () => cycleCategory(-1),
  )
  categoryButton.box.flexGrow = 1
  categoryButton.box.minWidth = 0
  modeBar.add(allTab.box)
  modeBar.add(dayTab.box)
  modeBar.add(weekTab.box)
  modeBar.add(searchTab.box)
  modeBar.add(categoryButton.box)

  const content = new BoxRenderable(renderer, {
    id: "content",
    flexGrow: 1,
    flexDirection: "column",
    minHeight: 8,
  })
  const resultPanel = new BoxRenderable(renderer, {
    id: "result-panel",
    width: "100%",
    height: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: "#245A64",
    title: " Search results ",
    paddingX: 1,
    flexDirection: "column",
  })
  const sortHeader = new TextRenderable(renderer, {
    id: "sort-header",
    width: "100%",
    height: 1,
    content: "",
    fg: "#57E6B1",
    bg: "#071015",
    onMouseDown: handleHeaderMouseDown,
    onKeyDown(key) {
      if (key.name === "left" || key.name === "right") {
        key.preventDefault()
        key.stopPropagation()
        moveHeaderSort(key.name === "left" ? -1 : 1)
      } else if (key.name === "return" || key.name === "enter" || key.name === "space" || key.sequence === " ") {
        key.preventDefault()
        key.stopPropagation()
        toggleHeaderSort()
      }
    },
  })
  sortHeader.focusable = true
  const results = new SelectRenderable(renderer, {
    id: "results",
    width: "100%",
    flexGrow: 1,
    options: [],
    showDescription: false,
    showScrollIndicator: true,
    wrapSelection: true,
    backgroundColor: "#071015",
    focusedBackgroundColor: "#071015",
    textColor: "#B9CAD0",
    selectedTextColor: "#071015",
    selectedBackgroundColor: "#57E6B1",
    onMouseDown: handleResultMouseDown,
    onMouseScroll: handleResultMouseScroll,
  })
  resultPanel.add(sortHeader)
  resultPanel.add(results)
  content.add(resultPanel)

  const status = new TextRenderable(renderer, {
    id: "status",
    height: 1,
    content: " Tab controls/header  •  Enter activate/reverse  •  click headers to sort  •  ? help  •  Esc quit",
    fg: "#8DA7B1",
  })
  root.add(title)
  root.add(searchPanel)
  root.add(modeBar)
  root.add(content)
  root.add(status)

  const modal = new BoxRenderable(renderer, {
    id: "details-modal",
    position: "absolute",
    zIndex: 100,
    visible: false,
    border: true,
    borderStyle: "rounded",
    borderColor: "#57E6B1",
    backgroundColor: "#0B1920",
    title: " Torrent details ",
    padding: 1,
    flexDirection: "column",
    focusable: true,
  })
  const modalScroll = new ScrollBoxRenderable(renderer, {
    id: "modal-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    backgroundColor: "#0B1920",
  })
  const modalDetails = new TextRenderable(renderer, {
    id: "modal-details",
    width: "100%",
    content: "",
    fg: "#D5E4E9",
  })
  modalScroll.add(modalDetails)
  const modalActions = new BoxRenderable(renderer, {
    id: "modal-actions",
    width: "100%",
    height: 3,
    flexDirection: "row",
  })
  const copyButton = makeButton("copy-magnet", " Copy magnet ", "25%", copySelectedMagnet)
  const showButton = makeButton("show-magnet", " Show link ", "25%", showSelectedMagnet)
  const imdbButton = makeButton("copy-imdb", " Copy IMDb search ", "25%", copyImdbLink)
  const closeButton = makeButton("close-modal", " Close ", "25%", closeModal)
  const copyAction = copyButton.box
  const showAction = showButton.box
  const imdbAction = imdbButton.box
  const closeAction = closeButton.box
  modalActions.add(copyAction)
  modalActions.add(showAction)
  modalActions.add(imdbAction)
  modalActions.add(closeAction)
  modal.add(modalScroll)
  modal.add(modalActions)
  root.add(modal)
  renderer.root.add(root)

  sortHeader.on(RenderableEvents.FOCUSED, () => {
    sortHeader.bg = "#10242B"
    setStatus("Sort header focused. Use ←/→ to choose a visible column; Enter reverses it.")
  })
  sortHeader.on(RenderableEvents.BLURRED, () => {
    sortHeader.bg = "#071015"
  })

  function makeButton(
    id: string,
    label: string,
    width: number | "auto" | `${number}%`,
    action: () => void,
    secondaryAction?: () => void,
  ): { box: BoxRenderable; text: TextRenderable } {
    const box = new BoxRenderable(renderer, {
      id,
      width,
      height: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: "#245A64",
      focusedBorderColor: "#57E6B1",
      focusable: true,
      alignItems: "center",
      justifyContent: "center",
      onMouseDown(event) {
        const selectedAction = event.button === MouseButton.LEFT
          ? action
          : event.button === MouseButton.RIGHT
            ? secondaryAction
            : undefined
        if (!selectedAction) return
        event.preventDefault()
        event.stopPropagation()
        this.focus()
        selectedAction()
      },
      onKeyDown(key) {
        if (key.name !== "return" && key.name !== "enter" && key.name !== "space" && key.sequence !== " ") return
        key.preventDefault()
        key.stopPropagation()
        const selectedAction = key.shift && secondaryAction ? secondaryAction : action
        selectedAction()
      },
    })
    const text = new TextRenderable(renderer, { content: label, height: 1, fg: "#B9CAD0" })
    box.add(text)
    return { box, text }
  }

  function selectedTorrent(): TorrentSummary | undefined {
    if (modal.visible && modalTorrent) return modalTorrent
    const selected = results.getSelectedOption()?.value
    return isTorrent(selected) ? selected : undefined
  }

  function setStatus(message: string, error = false): void {
    status.content = ` ${message}`
    status.fg = error ? "#FF7A90" : "#8DA7B1"
  }

  function updateModeTabs(): void {
    for (const [mode, tab] of [["search", searchTab], ["day", dayTab], ["week", weekTab], ["all", allTab]] as const) {
      const active = mode === activeMode
      tab.box.backgroundColor = active ? "#57E6B1" : "#071015"
      tab.text.fg = active ? "#071015" : "#B9CAD0"
    }
    resultPanel.title = activeMode === "search"
      ? " Search results "
      : activeMode === "day"
        ? " Top downloads · 24h "
        : activeMode === "week"
          ? " Top downloads · 7 days "
          : " Full category ranking "
  }

  function categoryText(width = renderer.width): string {
    const label = categoryCycle[categoryIndex]?.[0] ?? "all"
    if (width >= 72) return ` Category: ${label} `
    const compactLabel = label === "applications" ? "apps" : label.replace(" (all)", "")
    return ` Cat:${compactLabel} `
  }

  function cycleCategory(direction: 1 | -1 = 1): void {
    categoryIndex = (categoryIndex + direction + categoryCycle.length) % categoryCycle.length
    categoryButton.text.content = categoryText()
    void reload()
  }

  function visibleSortColumns(): SortOrder[] {
    return resultSortColumns(Math.max(24, renderer.width - 8))
  }

  function selectSort(sort: SortOrder, toggleCurrent = false, hint?: string): void {
    const nextIndex = SORT_CYCLE.indexOf(sort)
    if (nextIndex < 0) return
    if (nextIndex === sortIndex && toggleCurrent) sortReversed = !sortReversed
    else if (nextIndex !== sortIndex) {
      sortIndex = nextIndex
      sortReversed = false
    }
    sortCurrentResults()
    const direction = sortDirection(SORT_CYCLE[sortIndex] ?? "seeders", sortReversed)
    setStatus(`Sorted by ${sort} ${direction === "asc" ? "ascending" : "descending"}.${hint ? ` ${hint}` : ""}`)
  }

  function cycleSort(): void {
    const visible = visibleSortColumns()
    const currentIndex = visible.indexOf(SORT_CYCLE[sortIndex] ?? "seeders")
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % visible.length
    const nextSort = visible[nextIndex]
    if (nextSort) selectSort(nextSort, false, "Shift+S reverses it.")
  }

  function moveHeaderSort(direction: 1 | -1): void {
    const visible = visibleSortColumns()
    const currentIndex = visible.indexOf(SORT_CYCLE[sortIndex] ?? "seeders")
    const nextIndex = currentIndex < 0
      ? direction === 1 ? 0 : visible.length - 1
      : (currentIndex + direction + visible.length) % visible.length
    const nextSort = visible[nextIndex]
    if (nextSort) selectSort(nextSort, false, "Use ←/→ for another column; Enter reverses it.")
  }

  function toggleHeaderSort(): void {
    const visible = visibleSortColumns()
    const currentSort = SORT_CYCLE[sortIndex] ?? "seeders"
    const visibleSort = visible.includes(currentSort) ? currentSort : visible[0]
    if (visibleSort) selectSort(visibleSort, visibleSort === currentSort, "Press Enter again to reverse.")
  }

  function cycleMainFocus(direction: 1 | -1): void {
    const focusOrder: Renderable[] = [
      input,
      allTab.box,
      dayTab.box,
      weekTab.box,
      searchTab.box,
      categoryButton.box,
      ...(torrents.length ? [sortHeader, results] : []),
    ]
    const currentIndex = focusOrder.indexOf(renderer.currentFocusedRenderable as Renderable)
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + focusOrder.length) % focusOrder.length
    focusOrder[nextIndex]?.focus()
  }

  async function reload(refresh = false): Promise<void> {
    return activeMode === "search" ? search() : top(activeMode, refresh)
  }

  function activateSearchMode(): void {
    startupPending = false
    activeRequest?.abort()
    activeRequest = undefined
    activeMode = "search"
    updateModeTabs()
    input.focus()
    setStatus("Type a query and press Enter, or switch to All / Top 24h / Top week.")
  }

  function showResponse(response: SearchResponse, label: string, focusResults = true): void {
    torrents = response.results
    sortCurrentResults()
    if (torrents.length) {
      results.setSelectedIndex(0)
      if (focusResults) results.focus()
    } else {
      if (activeMode === "search") input.focus()
    }
    const available = response.availableResults ?? torrents.length
    const count = available > torrents.length ? `${torrents.length} of ${available}` : String(torrents.length)
    const partialSuffix = response.partial
      ? ` • partial: ${response.failedSources ?? 1} source${response.failedSources === 1 ? "" : "s"} unavailable`
      : ""
    setStatus(`${count} ${label.toLowerCase()} via ${new URL(response.endpoint).host}${partialSuffix}`)
    if (response.partial) status.fg = "#F2C14E"
  }

  function refreshResultOptions(terminalWidth = renderer.width): void {
    const lineWidth = Math.max(24, terminalWidth - 8)
    results.options = torrents.map((torrent): SelectOption => ({
      name: formatResultLine(torrent, lineWidth),
      description: "",
      value: torrent,
    }))
    sortHeader.content = `   ${formatResultHeader(lineWidth, SORT_CYCLE[sortIndex] ?? "seeders", sortReversed)}`
  }

  function sortCurrentResults(): void {
    const selectedHash = selectedTorrent()?.infoHash
    torrents = sortTorrents(torrents, SORT_CYCLE[sortIndex] ?? "seeders", sortReversed)
    refreshResultOptions()
    if (selectedHash) {
      const index = torrents.findIndex((torrent) => torrent.infoHash === selectedHash)
      if (index >= 0) results.setSelectedIndex(index)
    }
  }

  function handleHeaderMouseDown(event: TuiMouseEvent): void {
    if (event.button !== MouseButton.LEFT) return
    const lineWidth = Math.max(24, renderer.width - 8)
    const sort = resultSortAtColumn(event.x - sortHeader.screenX - 3, lineWidth)
    if (!sort) return
    event.preventDefault()
    event.stopPropagation()
    sortHeader.focus()
    selectSort(sort, true, "Click again or press Enter to reverse.")
  }

  function layoutModal(width = renderer.width, height = renderer.height): void {
    applyResponsiveLayout(width, height)
    const modalWidth = Math.max(1, Math.min(96, width - (width < 72 ? 2 : 4)))
    const modalHeight = Math.max(1, Math.min(24, height - (height < 20 ? 2 : 4)))
    modal.width = modalWidth
    modal.height = modalHeight
    modal.left = Math.max(0, Math.floor((width - modalWidth) / 2))
    modal.top = Math.max(0, Math.floor((height - modalHeight) / 2))
    refreshResultOptions(width)
  }

  function applyResponsiveLayout(width: number, height: number): void {
    const compact = width < 72
    const veryCompact = width < 52
    allTab.box.width = veryCompact ? 5 : compact ? 7 : 9
    dayTab.box.width = veryCompact ? 6 : compact ? 7 : 11
    weekTab.box.width = veryCompact ? 6 : compact ? 8 : 12
    searchTab.box.width = veryCompact ? 7 : compact ? 9 : 10
    allTab.text.content = "All"
    dayTab.text.content = compact ? "24h" : "Top 24h"
    weekTab.text.content = veryCompact ? "Wk" : compact ? "Week" : "Top week"
    searchTab.text.content = veryCompact ? "Find" : "Search"
    categoryButton.text.content = categoryText(width)
    content.minHeight = Math.max(3, Math.min(8, height - 8))

    const narrowModal = width < 80
    copyButton.text.content = narrowModal ? "Magnet" : "Copy magnet"
    showButton.text.content = narrowModal ? "Show" : "Show link"
    imdbButton.text.content = narrowModal ? "IMDb" : "Copy IMDb search"
    closeButton.text.content = "Close"
  }

  function closeModal(): void {
    const closedMode = modalMode
    const returnFocus = modalReturnFocus
    activeDetailsRequest?.abort()
    activeDetailsRequest = undefined
    modal.visible = false
    modalTorrent = undefined
    modalMode = undefined
    modalReturnFocus = null
    modalActions.visible = true
    if (returnFocus) returnFocus.focus()
    else if (torrents.length) results.focus()
    else input.focus()
    setStatus(closedMode === "help" ? "Help closed." : "Details closed.")
  }

  async function openDetailsModal(torrent: TorrentSummary): Promise<void> {
    rememberModalFocus()
    activeDetailsRequest?.abort()
    activeDetailsRequest = new AbortController()
    const request = activeDetailsRequest
    modalMode = "details"
    modalTorrent = torrent
    modal.visible = true
    modal.title = " Torrent details "
    modalActions.visible = true
    modalScroll.scrollTo(0)
    layoutModal()
    setModalContent(torrent, "Loading full details…")
    modalScroll.focus()
    setStatus(`Loading details for ${torrent.id}…`)
    try {
      const response = await source.details(torrent.id, request.signal)
      if (request.signal.aborted || !modal.visible || modalMode !== "details" || modalTorrent?.id !== torrent.id) return
      modalTorrent = response.torrent
      setModalContent(response.torrent, response.torrent.description || "No description.")
      setStatus(`Details via ${new URL(response.endpoint).host}`)
    } catch (error) {
      if (request.signal.aborted || !modal.visible || modalMode !== "details" || modalTorrent?.id !== torrent.id) return
      setModalContent(torrent, `Could not load full details: ${error instanceof Error ? error.message : String(error)}`)
      setStatus(error instanceof Error ? error.message : String(error), true)
    } finally {
      if (activeDetailsRequest === request) activeDetailsRequest = undefined
    }
  }

  function showHelpModal(): void {
    rememberModalFocus()
    activeDetailsRequest?.abort()
    activeDetailsRequest = undefined
    modalMode = "help"
    modalTorrent = undefined
    modal.title = " Help "
    modalActions.visible = false
    modal.visible = true
    modalScroll.scrollTo(0)
    layoutModal()
    modalDetails.content = [
      "NODE PIRATE HELP",
      "",
      "Views",
      "  1  All rankings       2  Top 24h",
      "  3  Top week          4  Search",
      "",
      "Results",
      "  ↑/↓ or j/k  Move selection",
      "  Enter/click Open details",
      "  Header click Sort; click again to reverse",
      "  Tab to header; ←/→ column; Enter reverse",
      "  c / Shift+C  Cycle category forward / backward",
      "  s / Shift+S  Next visible sort / reverse",
      "  r            Force refresh",
      "",
      "Links",
      "  m/right-click  Copy magnet",
      "  v              Show magnet",
      "  u              Copy IMDb title search (inside details)",
      "",
      "General",
      "  Tab / Shift+Tab  Move through query, views, category, header, results",
      "  Enter / Space     Activate a focused view or category",
      "  /  Focus search",
      "  In details: Tab/Shift+Tab actions; Enter/Space activates",
      "  ? or F1  Help       Esc quit; q quits outside the query",
      "",
      "CLI discovery: node-pirate --help; node-pirate categories; node-pirate config",
    ].join("\n")
    modalScroll.focus()
    setStatus("Help open. Use arrows or the mouse wheel to scroll; q/Esc closes it.")
  }

  async function search(query = input.value): Promise<void> {
    startupPending = false
    const normalized = query.trim()
    activeMode = "search"
    updateModeTabs()
    activeRequest?.abort()
    activeRequest = undefined
    if (!normalized) {
      setStatus("Enter a search query first.", true)
      input.focus()
      return
    }

    activeRequest = new AbortController()
    const request = activeRequest
    setStatus(`Searching ${source.endpoints.length} endpoint${source.endpoints.length === 1 ? "" : "s"}…`)
    try {
      const response = await source.search({
        query: normalized,
        category: categoryCycle[categoryIndex]?.[1] ?? 0,
        sort: SORT_CYCLE[sortIndex] ?? "seeders",
        reverse: sortReversed,
        limit: 100,
        signal: request.signal,
      })
      if (request.signal.aborted || activeRequest !== request || activeMode !== "search") return
      const available = response.availableResults ?? response.results.length
      showResponse(response, `result${available === 1 ? "" : "s"}`)
    } catch (error) {
      if (request.signal.aborted || activeRequest !== request) return
      setStatus(error instanceof Error ? error.message : String(error), true)
      input.focus()
    } finally {
      if (activeRequest === request) activeRequest = undefined
    }
  }

  async function top(period: TopPeriod, refresh = false): Promise<void> {
    startupPending = false
    activeMode = period
    updateModeTabs()
    activeRequest?.abort()
    activeRequest = new AbortController()
    const request = activeRequest
    const windowLabel = period === "day" ? "24 hours" : period === "week" ? "7 days" : "all available rankings"
    setStatus(period === "all" ? `Loading ${windowLabel}…` : `Loading top downloads from the last ${windowLabel}…`)
    try {
      const response = await source.top({
        period,
        category: categoryCycle[categoryIndex]?.[1] ?? 0,
        sort: SORT_CYCLE[sortIndex] ?? "seeders",
        reverse: sortReversed,
        limit: 500,
        signal: request.signal,
        refresh,
      })
      if (request.signal.aborted || activeRequest !== request || activeMode !== period) return
      const preserveQueryFocus = input.focused && Boolean(input.value.trim())
      const available = response.availableResults ?? response.results.length
      showResponse(response, `top download${available === 1 ? "" : "s"}`, !preserveQueryFocus)
    } catch (error) {
      if (request.signal.aborted || activeRequest !== request) return
      setStatus(error instanceof Error ? error.message : String(error), true)
    } finally {
      if (activeRequest === request) activeRequest = undefined
    }
  }

  function resultIndexAt(event: TuiMouseEvent): number | undefined {
    const localY = event.y - results.screenY
    if (localY < 0 || localY >= results.height || results.options.length === 0) return undefined
    const visibleItems = Math.max(1, results.height)
    const selected = results.getSelectedIndex()
    const offset = Math.max(0, Math.min(selected - Math.floor(visibleItems / 2), results.options.length - visibleItems))
    const index = offset + localY
    return index < results.options.length ? index : undefined
  }

  function handleResultMouseDown(event: TuiMouseEvent): void {
    const index = resultIndexAt(event)
    if (index === undefined) return
    event.preventDefault()
    event.stopPropagation()
    results.focus()
    results.setSelectedIndex(index)

    if (event.button === MouseButton.RIGHT) {
      copySelectedMagnet()
      return
    }
    if (event.button !== MouseButton.LEFT) return
    results.selectCurrent()
  }

  function handleResultMouseScroll(event: TuiMouseEvent): void {
    const direction = event.scroll?.direction
    if (direction !== "up" && direction !== "down") return
    event.preventDefault()
    event.stopPropagation()
    results.focus()
    const steps = Math.max(1, Math.round(Math.abs(event.scroll?.delta ?? 3)))
    if (direction === "up") results.moveUp(steps)
    else results.moveDown(steps)
  }

  function copySelectedMagnet(): void {
    const torrent = selectedTorrent()
    if (!torrent) {
      setStatus("Select a torrent before copying its magnet link.", true)
      return
    }
    const magnet = createMagnetUri(torrent)
    if (renderer.copyToClipboardOSC52(magnet)) setStatus("Magnet link copied to the terminal clipboard.")
    else showSelectedMagnet()
  }

  function showSelectedMagnet(): void {
    const torrent = selectedTorrent()
    if (!torrent) {
      setStatus("Select a torrent before showing its magnet link.", true)
      return
    }
    rememberModalFocus()
    activeDetailsRequest?.abort()
    activeDetailsRequest = undefined
    modalMode = "details"
    modalTorrent = torrent
    modal.visible = true
    modal.title = " Torrent details "
    modalActions.visible = true
    layoutModal()
    setModalContent(torrent, "Magnet link shown below; nothing was opened.", createMagnetUri(torrent))
    modalScroll.focus()
    setStatus("Magnet link shown in the details modal; nothing was opened.")
  }

  function copyImdbLink(): void {
    const torrent = selectedTorrent()
    if (!torrent) {
      setStatus("Select a torrent before copying its IMDb link.", true)
      return
    }
    const url = createImdbSearchUrl(torrent)
    if (renderer.copyToClipboardOSC52(url)) setStatus("IMDb search link copied to the terminal clipboard.")
    else {
      activeDetailsRequest?.abort()
      activeDetailsRequest = undefined
      setModalContent(torrent, "IMDb link shown below because clipboard access is unavailable.")
      setStatus("IMDb search link shown in the details modal.")
    }
  }

  function setModalContent(torrent: TorrentSummary, body: string, magnet?: string): void {
    const imdbUrl = createImdbSearchUrl(torrent)
    modalDetails.content = t`${formatDetails(torrent)}\n\n${body}${magnet ? `\n\nMagnet link:\n${magnet}` : ""}\n\nIMDb title search: ${link(imdbUrl)(imdbUrl)}\n\nUse ↑/↓ or the mouse wheel to scroll. Tab selects actions; Enter activates. Press m to copy magnet, u to copy IMDb search, v to show magnet, or Esc to close.`
  }

  function rememberModalFocus(): void {
    if (!modal.visible) modalReturnFocus = renderer.currentFocusedRenderable
  }

  function cycleModalFocus(direction: 1 | -1): void {
    const controls: Renderable[] = modalMode === "details"
      ? [modalScroll, copyAction, showAction, imdbAction, closeAction]
      : [modalScroll]
    const current = renderer.currentFocusedRenderable
    const currentIndex = controls.findIndex((control) => control === current)
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + controls.length) % controls.length
    controls[nextIndex]?.focus()
  }

  function activateFocusedModalAction(): boolean {
    switch (renderer.currentFocusedRenderable?.id) {
      case "copy-magnet":
        copySelectedMagnet()
        return true
      case "show-magnet":
        showSelectedMagnet()
        return true
      case "copy-imdb":
        copyImdbLink()
        return true
      case "close-modal":
        closeModal()
        return true
      default:
        return false
    }
  }

  input.on(InputRenderableEvents.ENTER, (value: string) => void search(value))
  results.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: SelectOption) => {
    if (!isTorrent(option.value)) return
    void openDetailsModal(option.value)
  })

  renderer.keyInput.on("keypress", (key) => {
    if (modal.visible) {
      if (key.name === "tab") {
        key.preventDefault()
        cycleModalFocus(key.shift ? -1 : 1)
      }
      else if (modalMode === "details" && (key.name === "return" || key.name === "enter" || key.name === "space" || key.sequence === " ")) {
        if (activateFocusedModalAction()) key.preventDefault()
      }
      else if (key.name === "escape" || key.name === "q" || (modalMode === "help" && key.name === "?")) closeModal()
      else if (modalMode === "details" && key.name === "m") copySelectedMagnet()
      else if (modalMode === "details" && key.name === "u") copyImdbLink()
      else if (modalMode === "details" && key.name === "v") showSelectedMagnet()
      return
    }
    if (key.name === "f1" || (!input.focused && key.name === "?")) {
      showHelpModal()
      return
    }
    if (key.name === "tab") {
      key.preventDefault()
      cycleMainFocus(key.shift ? -1 : 1)
      return
    }
    if (input.focused) {
      if (key.name === "escape") {
        key.preventDefault()
        shutdown()
      }
      return
    }

    if (key.name === "q" || key.name === "escape") shutdown()
    else if (key.name === "/") input.focus()
    else if (key.name === "r") void reload(true)
    else if (key.name === "c") cycleCategory(key.shift ? -1 : 1)
    else if (key.name === "s") {
      if (key.shift) toggleHeaderSort()
      else cycleSort()
    }
    else if (key.name === "1") void top("all")
    else if (key.name === "2") void top("day")
    else if (key.name === "3") void top("week")
    else if (key.name === "4") activateSearchMode()
    else if (key.name === "m") copySelectedMagnet()
    else if (key.name === "v") showSelectedMagnet()
  })

  updateModeTabs()
  layoutModal()
  renderer.on("resize", (width: number, height: number) => layoutModal(width, height))
  renderer.once("destroy", () => {
    activeRequest?.abort()
    activeDetailsRequest?.abort()
  })
  input.focus()
  queueMicrotask(() => {
    if (!startupPending) return
    if (activeMode === "search") {
      if (options.initialQuery?.trim()) void search(options.initialQuery)
      else activateSearchMode()
      return
    }
    if (!activeRequest) void top(activeMode)
  })

  return {
    input,
    results,
    sortHeader,
    modal,
    modalScroll,
    copyAction,
    showAction,
    imdbAction,
    search,
    top,
    destroy: shutdown,
  }

  function shutdown(): void {
    activeRequest?.abort()
    activeDetailsRequest?.abort()
    renderer.destroy()
  }
}

export async function runTui(source: TorrentDataSource, options: TuiOptions = {}): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    useMouse: true,
    enableMouseMovement: true,
    autoFocus: true,
    backgroundColor: "#071015",
  })
  createTui(renderer, source, options)
  await new Promise<void>((resolve) => renderer.once("destroy", resolve))
}

function isTorrent(value: unknown): value is TorrentSummary {
  return Boolean(value && typeof value === "object" && "infoHash" in value && "id" in value)
}

function categoryFiltersEqual(left: CategoryFilter, right: CategoryFilter): boolean {
  const leftValues = Array.isArray(left) ? left : [left as number]
  const rightValues = Array.isArray(right) ? right : [right as number]
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index])
}
