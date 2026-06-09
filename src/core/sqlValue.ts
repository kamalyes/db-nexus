function pad(value: number, size = 2): string {
  return String(value).padStart(size, '0')
}

export function formatDateTimeValue(value: Date): string {
  if (Number.isNaN(value.getTime())) {
    return String(value)
  }

  const offsetMinutes = -value.getTimezoneOffset()
  const offsetSign = offsetMinutes >= 0 ? '+' : '-'
  const offsetAbs = Math.abs(offsetMinutes)
  const milliseconds = value.getMilliseconds()
  const millisecondsPart = milliseconds > 0 ? `.${pad(milliseconds, 3)}` : ''

  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}` +
    `${millisecondsPart}${offsetSign}${pad(Math.floor(offsetAbs / 60))}:${pad(offsetAbs % 60)}`
}

export function formatExportValue(value: unknown): string {
  if (value instanceof Date) {
    return formatDateTimeValue(value)
  }

  return String(value)
}

export function formatSqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }

  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }

  if (value instanceof Date) {
    return `'${formatDateTimeValue(value).replace(/'/g, "''")}'`
  }

  if (typeof value === 'object') {
    try {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`
    } catch {
      return `'${formatExportValue(value).replace(/'/g, "''")}'`
    }
  }

  return `'${formatExportValue(value).replace(/'/g, "''")}'`
}
