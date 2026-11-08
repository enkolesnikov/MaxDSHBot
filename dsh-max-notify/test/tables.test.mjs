import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTableFiles,
  findMarkdownTables,
  stripMarkdownTables,
  tableToCsv,
  tableToMarkdown,
} from '../lib/tables.mjs'

const PLACEHOLDER = '\n\n_(таблица во вложении)_\n\n'

const simpleText = [
  'До:',
  '',
  '| Имя | Возраст |',
  '| --- | ---: |',
  '| Аня | 30 |',
  '| Борис | 41 |',
  '',
  'После.',
].join('\n')

const twoTablesText = [
  'Первая:',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  'Между.',
  '',
  'c | d',
  '--- | ---',
  '3 | 4',
].join('\n')

test('finds a simple table with headers, rows and source offsets', () => {
  const tables = findMarkdownTables(simpleText)
  assert.equal(tables.length, 1)
  const [table] = tables
  assert.deepEqual(table.headers, ['Имя', 'Возраст'])
  assert.deepEqual(table.rows, [
    ['Аня', '30'],
    ['Борис', '41'],
  ])
  assert.equal(table.start, simpleText.indexOf('| Имя'))
  assert.equal(table.raw, '| Имя | Возраст |\n| --- | ---: |\n| Аня | 30 |\n| Борис | 41 |')
  assert.equal(simpleText.slice(table.start, table.end), table.raw)
  assert.equal(table.end, table.start + table.raw.length)
})

test('finds several tables in one text', () => {
  const tables = findMarkdownTables(twoTablesText)
  assert.equal(tables.length, 2)
  assert.deepEqual(tables[0].headers, ['a', 'b'])
  assert.deepEqual(tables[1].headers, ['c', 'd'])
  assert.deepEqual(tables[1].rows, [['3', '4']])
  assert.equal(tables[1].start, twoTablesText.indexOf('c | d'))
  assert.equal(twoTablesText.slice(tables[1].start, tables[1].end), 'c | d\n--- | ---\n3 | 4')
})

test('unescapes \\| inside header and body cells', () => {
  const text = [
    '| a \\| b | c |',
    '| --- | --- |',
    '| x \\| y | z |',
  ].join('\n')
  const [table] = findMarkdownTables(text)
  assert.deepEqual(table.headers, ['a | b', 'c'])
  assert.deepEqual(table.rows, [['x | y', 'z']])
})

test('supports GFM tables without outer pipes', () => {
  const text = 'a | b\n--- | ---\n1 | 2\n'
  const [table] = findMarkdownTables(text)
  assert.deepEqual(table.headers, ['a', 'b'])
  assert.deepEqual(table.rows, [['1', '2']])
  assert.equal(table.start, 0)
  assert.equal(table.raw, 'a | b\n--- | ---\n1 | 2')
})

test('accepts alignment colons and padded delimiter cells', () => {
  const text = '| h1 | h2 |\n|  :---:  |  :---  |\n| a | b |'
  const [table] = findMarkdownTables(text)
  assert.deepEqual(table.headers, ['h1', 'h2'])
  assert.deepEqual(table.rows, [['a', 'b']])
})

test('ignores tables inside fenced code blocks', () => {
  const text = [
    'Текст.',
    '',
    '```js',
    '| fake | table |',
    '| --- | --- |',
    '| 1 | 2 |',
    '```',
    '',
    '| real | value |',
    '| --- | --- |',
    '| 3 | 4 |',
    '',
    '~~~',
    '| also | fake |',
    '| --- | --- |',
    '~~~',
  ].join('\n')
  const tables = findMarkdownTables(text)
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].headers, ['real', 'value'])
  assert.deepEqual(tables[0].rows, [['3', '4']])
  assert.equal(tables[0].start, text.indexOf('| real'))
})

test('an unclosed fence masks the rest of the text', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```\n| c | d |\n| --- | --- |'
  const tables = findMarkdownTables(text)
  assert.equal(tables.length, 1)
  assert.deepEqual(tables[0].headers, ['a', 'b'])
})

test('skips broken tables (delimiter cell count mismatch)', () => {
  assert.deepEqual(findMarkdownTables('| a | b |\n| --- |\n| 1 | 2 |'), [])
  assert.deepEqual(findMarkdownTables('| a | b |\n\n| 1 | 2 |'), [])
  assert.deepEqual(findMarkdownTables('foo | bar\nbaz | qux'), [])
})

test('a line without a pipe ends the table body', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\nno pipe here\n| 3 | 4 |'
  const [table] = findMarkdownTables(text)
  assert.deepEqual(table.rows, [['1', '2']])
  assert.ok(!table.raw.includes('no pipe here'))
})

test('stripMarkdownTables replaces every table with the default placeholder', () => {
  const stripped = stripMarkdownTables(twoTablesText)
  assert.equal(stripped.split(PLACEHOLDER).length - 1, 2)
  assert.ok(!stripped.includes('|'))
  assert.ok(stripped.startsWith('Первая:'))
  assert.ok(stripped.includes('Между.'))
  assert.ok(stripped.endsWith('c | d\n--- | ---\n3 | 4') === false)
})

test('stripMarkdownTables honours a custom replacement', () => {
  const stripped = stripMarkdownTables(simpleText, { replacement: '[таблица]' })
  assert.equal(stripped.split('[таблица]').length - 1, 1)
  assert.ok(!stripped.includes('| Имя'))
  assert.ok(stripped.startsWith('До:'))
  assert.ok(stripped.endsWith('После.'))
})

test('stripMarkdownTables returns text unchanged when there are no tables', () => {
  const text = 'Просто текст\nбез таблиц.'
  assert.equal(stripMarkdownTables(text), text)
})

test('tableToCsv quotes commas, quotes and line breaks', () => {
  const csv = tableToCsv(['name', 'note'], [
    ['Smith, John', 'say "hi"'],
    ['line', 'a\nb'],
  ])
  assert.equal(csv, 'name,note\r\n"Smith, John","say ""hi"""\r\nline,"a\nb"')
})

test('tableToCsv leaves simple fields untouched', () => {
  assert.equal(tableToCsv(['a', 'b'], [['1', '2']]), 'a,b\r\n1,2')
})

test('tableToCsv pads and truncates ragged rows to the header width', () => {
  assert.equal(tableToCsv(['a', 'b'], [['1'], ['1', '2', '3']]), 'a,b\r\n1,\r\n1,2')
})

test('tableToMarkdown renders a clean table', () => {
  const markdown = tableToMarkdown(['Имя', 'Возраст'], [['Аня', '30']])
  assert.equal(markdown, '| Имя | Возраст |\n| --- | --- |\n| Аня | 30 |')
})

test('tableToMarkdown escapes pipes and flattens line breaks', () => {
  const markdown = tableToMarkdown(['a|b', 'c'], [['x|y', 'two\nlines']])
  assert.equal(
    markdown,
    '| a\\|b | c |\n| --- | --- |\n| x\\|y | two<br>lines |',
  )
})

test('buildTableFiles returns CSV and Markdown per table plus stripped text', () => {
  const { files, strippedText } = buildTableFiles(twoTablesText)
  assert.deepEqual(
    files.map((file) => [file.filename, file.type]),
    [
      ['table-1.csv', 'text/csv'],
      ['table-1.md', 'text/markdown'],
      ['table-2.csv', 'text/csv'],
      ['table-2.md', 'text/markdown'],
    ],
  )
  assert.equal(files[0].content, 'a,b\r\n1,2')
  assert.equal(files[1].content, '| a | b |\n| --- | --- |\n| 1 | 2 |')
  assert.equal(strippedText.split(PLACEHOLDER).length - 1, 2)
  assert.ok(!strippedText.includes('| a |'))
  assert.equal(strippedText, stripMarkdownTables(twoTablesText))
})

test('buildTableFiles limits files to maxTables but strips every table', () => {
  const text = [
    '| a |',
    '| --- |',
    '| 1 |',
    '',
    '| b |',
    '| --- |',
    '| 2 |',
    '',
    '| c |',
    '| --- |',
    '| 3 |',
  ].join('\n')
  assert.equal(findMarkdownTables(text).length, 3)
  const { files, strippedText } = buildTableFiles(text, { maxTables: 2 })
  assert.deepEqual(files.map((file) => file.filename), [
    'table-1.csv',
    'table-1.md',
    'table-2.csv',
    'table-2.md',
  ])
  assert.equal(strippedText.split(PLACEHOLDER).length - 1, 3)
})

test('buildTableFiles with maxTables 0 still returns stripped text', () => {
  const { files, strippedText } = buildTableFiles(simpleText, { maxTables: 0 })
  assert.deepEqual(files, [])
  assert.ok(!strippedText.includes('| Имя'))
})

test('buildTableFiles returns no files and unchanged text without tables', () => {
  const text = 'Никаких таблиц здесь нет.'
  const { files, strippedText } = buildTableFiles(text)
  assert.deepEqual(files, [])
  assert.equal(strippedText, text)
})
