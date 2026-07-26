const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu

export function sanitizeSingleLine(value: string): string {
  return Bun.stripANSI(value)
    .replace(/\r\n?|\n|\t/gu, " ")
    .replace(unsafeControls, "")
    .replace(/ {2,}/gu, " ")
    .trim()
}

export function sanitizeMultiline(value: string): string {
  return Bun.stripANSI(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(unsafeControls, "")
    .trim()
}

export function displayWidth(value: string): number {
  return Bun.stringWidth(value)
}

export function fitToWidth(value: string, width: number): string {
  if (width <= 0) return ""
  const safe = sanitizeSingleLine(value)
  const currentWidth = displayWidth(safe)
  if (currentWidth <= width) return `${safe}${" ".repeat(width - currentWidth)}`
  if (width === 1) return "…"

  const contentWidth = width - 1
  let result = ""
  let resultWidth = 0
  for (const { segment } of graphemes.segment(safe)) {
    const segmentWidth = displayWidth(segment)
    if (resultWidth + segmentWidth > contentWidth) break
    result += segment
    resultWidth += segmentWidth
  }
  return `${result}…${" ".repeat(contentWidth - resultWidth)}`
}
