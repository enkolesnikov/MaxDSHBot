/**
 * Markdown tables in agent replies: MAX does not render Markdown tables, so a
 * reply containing tables is also delivered as attachments (CSV + Markdown).
 *
 * Pure functions only: no I/O, no dependencies. All offsets refer to the
 * original input string; fenced code blocks are ignored while searching.
 */

const DEFAULT_REPLACEMENT = '\n\n_(таблица во вложении)_\n\n'
const FENCE_PATTERN = /^( {0,3})(`{3,}|~{3,})(.*)$/
const DELIMITER_CELL_PATTERN = /^:?-{3,}:?$/

/**
 * @typedef {object} MarkdownTable
 * @property {number} start Index of the first header character in the source text.
 * @property {number} end Index after the last body-row character (`end` is exclusive).
 * @property {string} raw Exact source slice `[start, end)`.
 * @property {string[]} headers Cell values of the header row (trimmed, `\|` unescaped).
 * @property {string[][]} rows Cell values of the body rows.
 */

/**
 * Split text into lines, keeping offsets. `end` excludes `\r` and `\n`, so a
 * line's content is always `text.slice(start, end)`.
 * @param {string} text
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
function splitLines(text) {
  const lines = []
  let start = 0
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === '\n') {
      let end = index
      if (end > start && text[end - 1] === '\r') end -= 1
      lines.push({ start, end, text: text.slice(start, end) })
      start = index + 1
    }
  }
  return lines
}

/**
 * Blank out fenced code blocks (``` / ~~~) with spaces while preserving the
 * length of the text, so offsets still map to the original input.
 * An unclosed fence masks everything to the end of the text.
 * @param {string} text
 * @returns {string}
 */
function maskCodeFences(text) {
  const chars = text.split('')
  let open = null
  for (const line of splitLines(text)) {
    const match = FENCE_PATTERN.exec(line.text)
    if (!open) {
      if (match && !(match[2][0] === '`' && match[3].includes('`'))) {
        open = { marker: match[2][0], length: match[2].length }
        chars.fill(' ', line.start, line.end)
      }
      continue
    }
    chars.fill(' ', line.start, line.end)
    if (
      match &&
      match[2][0] === open.marker &&
      match[2].length >= open.length &&
      match[3].trim() === ''
    ) {
      open = null
    }
  }
  return chars.join('')
}

/**
 * Indices of pipes that act as cell separators: a pipe preceded by an odd
 * number of backslashes is escaped and belongs to the cell content.
 * @param {string} line
 * @returns {number[]}
 */
function separatorPipes(line) {
  const pipes = []
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '|') continue
    let backslashes = 0
    for (let back = index - 1; back >= 0 && line[back] === '\\'; back -= 1) backslashes += 1
    if (backslashes % 2 === 0) pipes.push(index)
  }
  return pipes
}

/**
 * Trim a raw cell and unescape `\|` (the only GFM escape that matters here).
 * @param {string} cell
 * @returns {string}
 */
function cleanCell(cell) {
  return cell.trim().replace(/\\\|/g, '|')
}

/**
 * Parse one table row into cells, dropping the optional leading/trailing pipe.
 * @param {string} line
 * @returns {string[]}
 */
function parseRow(line) {
  const pipes = separatorPipes(line)
  const cells = []
  let previous = -1
  for (const pipe of pipes) {
    cells.push(cleanCell(line.slice(previous + 1, pipe)))
    previous = pipe
  }
  cells.push(cleanCell(line.slice(previous + 1)))

  const firstNonSpace = line.search(/\S/)
  const lastNonSpace = line.trimEnd().length - 1
  if (pipes.length > 0 && pipes[0] === firstNonSpace) cells.shift()
  if (pipes.length > 0 && pipes[pipes.length - 1] === lastNonSpace) cells.pop()
  return cells
}

/**
 * Parse a delimiter row (`| --- | :---: |`); returns `null` when any cell is
 * not a valid delimiter cell.
 * @param {string} line
 * @returns {string[] | null}
 */
function parseDelimiterRow(line) {
  const cells = parseRow(line)
  if (cells.length === 0) return null
  for (const cell of cells) {
    if (!DELIMITER_CELL_PATTERN.test(cell)) return null
  }
  return cells
}

/**
 * Find Markdown tables (GFM-flavoured) in `text`.
 *
 * A table is a header row containing at least one unescaped pipe, a delimiter
 * row with the same number of cells (`:---:`, `---:`, `---`, spaces allowed)
 * and zero or more body rows. Leading/trailing pipes are optional; `\|` is an
 * escaped pipe; cells are trimmed and `\|` is unescaped. Tables inside fenced
 * code blocks are not reported. Blank or malformed lines break a table.
 *
 * @param {string} text
 * @returns {MarkdownTable[]}
 */
export function findMarkdownTables(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const masked = maskCodeFences(text)
  const lines = splitLines(masked)
  const tables = []

  for (let index = 0; index + 1 < lines.length; index += 1) {
    const headerLine = lines[index]
    if (headerLine.text.trim() === '') continue
    if (separatorPipes(headerLine.text).length === 0) continue
    const headers = parseRow(headerLine.text)
    if (headers.length === 0) continue

    const delimiterLine = lines[index + 1]
    if (delimiterLine.text.trim() === '') continue
    const delimiters = parseDelimiterRow(delimiterLine.text)
    if (!delimiters || delimiters.length !== headers.length) continue

    const rows = []
    let cursor = index + 2
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.text.trim() === '') break
      if (separatorPipes(line.text).length === 0) break
      rows.push(parseRow(line.text))
    }

    const lastLine = lines[cursor - 1]
    const start = headerLine.start
    const end = lastLine.end
    tables.push({ start, end, raw: text.slice(start, end), headers, rows })
    index = cursor - 1
  }

  return tables
}

/**
 * Replace already-found tables with `replacement`, right to left so earlier
 * offsets stay valid.
 * @param {string} source
 * @param {MarkdownTable[]} tables
 * @param {string} replacement
 * @returns {string}
 */
function replaceTables(source, tables, replacement) {
  let result = source
  for (let index = tables.length - 1; index >= 0; index -= 1) {
    const table = tables[index]
    result = result.slice(0, table.start) + replacement + result.slice(table.end)
  }
  return result
}

/**
 * Replace every Markdown table with a placeholder (tables ship as files).
 * @param {string} text
 * @param {{ replacement?: string }} [options]
 * @returns {string}
 */
export function stripMarkdownTables(text, { replacement = DEFAULT_REPLACEMENT } = {}) {
  const source = typeof text === 'string' ? text : ''
  const tables = findMarkdownTables(source)
  if (tables.length === 0) return source
  return replaceTables(source, tables, replacement)
}

/**
 * Coerce a value list to strings.
 * @param {unknown} values
 * @returns {string[]}
 */
function toCells(values) {
  return Array.isArray(values) ? values.map((value) => (value == null ? '' : String(value))) : []
}

/**
 * Pad/truncate rows to `width` cells so CSV and Markdown stay rectangular.
 * @param {unknown} rows
 * @param {number} width
 * @returns {string[][]}
 */
function normalizeRows(rows, width) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => {
    const cells = toCells(row)
    return Array.from({ length: width }, (_, index) => cells[index] ?? '')
  })
}

/**
 * Quote one CSV field when needed (comma, quote or newline); `"` → `""`.
 * @param {string} value
 * @returns {string}
 */
function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * Render a table as RFC 4180-ish CSV: fields are quoted when they contain a
 * comma, a quote or a line break; records are separated by CRLF.
 * Rows are padded/truncated to the header width.
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
export function tableToCsv(headers, rows) {
  const headerCells = toCells(headers)
  const records = [headerCells, ...normalizeRows(rows, headerCells.length)]
  return records.map((cells) => cells.map(csvField).join(',')).join('\r\n')
}

/**
 * Escape one Markdown table cell: pipes are escaped, line breaks become `<br>`.
 * @param {string} value
 * @returns {string}
 */
function markdownCell(value) {
  return value.trim().replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|')
}

/**
 * Render a clean Markdown table (for the `.md` attachment).
 * Rows are padded/truncated to the header width.
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
export function tableToMarkdown(headers, rows) {
  const headerCells = toCells(headers).map(markdownCell)
  if (headerCells.length === 0) return ''
  const lines = [
    `| ${headerCells.join(' | ')} |`,
    `| ${headerCells.map(() => '---').join(' | ')} |`,
    ...normalizeRows(rows, headerCells.length).map(
      (cells) => `| ${cells.map(markdownCell).join(' | ')} |`,
    ),
  ]
  return lines.join('\n')
}

/**
 * Build attachments for the tables found in `text`.
 *
 * Every table gets `table-N.csv` and `table-N.md` (numbering starts at 1, at
 * most `maxTables` tables). `strippedText` always has *all* tables replaced by
 * the placeholder, including tables beyond `maxTables`, so the chat message
 * never contains a table that was not attached.
 *
 * @param {string} text
 * @param {{ maxTables?: number }} [options]
 * @returns {{ files: Array<{ filename: string, content: string, type: 'text/csv' | 'text/markdown' }>, strippedText: string }}
 */
export function buildTableFiles(text, { maxTables = 3 } = {}) {
  const source = typeof text === 'string' ? text : ''
  const tables = findMarkdownTables(source)
  if (tables.length === 0) return { files: [], strippedText: source }

  const requested = Number(maxTables)
  const limit = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0
  const files = []
  tables.slice(0, limit).forEach((table, index) => {
    const number = index + 1
    files.push({
      filename: `table-${number}.csv`,
      content: tableToCsv(table.headers, table.rows),
      type: 'text/csv',
    })
    files.push({
      filename: `table-${number}.md`,
      content: tableToMarkdown(table.headers, table.rows),
      type: 'text/markdown',
    })
  })

  return { files, strippedText: replaceTables(source, tables, DEFAULT_REPLACEMENT) }
}
