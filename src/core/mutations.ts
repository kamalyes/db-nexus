export function uniqueRowsByColumns(
  rows: Array<Record<string, unknown>>,
  columns: string[]
): Array<Record<string, unknown>> {
  if (rows.length === 0) {
    throw new Error('No rows selected for delete')
  }

  const seen = new Set<string>()
  const uniqueRows: Array<Record<string, unknown>> = []

  for (const row of rows) {
    if (columns.some(column => row[column] === undefined)) {
      throw new Error('Cannot delete row without primary key values')
    }

    const key = columns.map(column => encodeKeyValue(row[column])).join('\u001f')
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    uniqueRows.push(row)
  }

  return uniqueRows
}

function encodeKeyValue(value: unknown): string {
  if (value instanceof Date) {
    return `date:${value.toISOString()}`
  }
  if (typeof value === 'bigint') {
    return `bigint:${value.toString()}`
  }

  const serialized = JSON.stringify(value)
  return `${typeof value}:${serialized === undefined ? String(value) : serialized}`
}
