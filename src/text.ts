const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const unsafeControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
// Directional formatting characters can visually reorder trusted terminal labels
// around untrusted text even though they have no display width of their own.
const bidiFormattingControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

export function sanitizeSingleLine(value: string): string {
  return Bun.stripANSI(toWellFormed(value))
    .replace(/\r\n?|\n|\t|\u2028|\u2029/gu, " ")
    .replace(unsafeControls, "")
    .replace(bidiFormattingControls, "")
    .replace(/ {2,}/gu, " ")
    .trim()
}

export function sanitizeMultiline(value: string): string {
  return Bun.stripANSI(toWellFormed(value))
    .replace(/\r\n?|\u2028|\u2029/gu, "\n")
    .replace(/\t/gu, "  ")
    .replace(unsafeControls, "")
    .replace(bidiFormattingControls, "")
    .trim()
}

function toWellFormed(value: string): string {
  let result = ""
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        result += value.slice(index, index + 2)
        index += 1
      } else {
        result += "\ufffd"
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result += "\ufffd"
    } else {
      result += value.charAt(index)
    }
  }
  return result
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
