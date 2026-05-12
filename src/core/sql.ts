export function appendLimitIfNeeded(sql: string, limit?: number): string {
  const trimmed = sql.trim()
  if (!limit || limit <= 0 || !isLimitableQuery(trimmed) || hasLimitClause(trimmed)) {
    return trimmed
  }

  return `${trimTrailingSemicolons(trimmed)} LIMIT ${limit}`
}

function isLimitableQuery(sql: string): boolean {
  const keyword = getLeadingKeyword(sql)
  return keyword === 'select' || keyword === 'with'
}

function hasLimitClause(sql: string): boolean {
  return /\blimit\b/i.test(sql)
}

function getLeadingKeyword(sql: string): string {
  const match = stripLeadingComments(sql).match(/^[a-z]+/i)
  return match ? match[0].toLowerCase() : ''
}

function stripLeadingComments(sql: string): string {
  let text = sql.trimStart()

  while (text.length > 0) {
    if (text.startsWith('--')) {
      const newlineIndex = text.search(/\r?\n/)
      text = newlineIndex === -1 ? '' : text.slice(newlineIndex).trimStart()
      continue
    }

    if (text.startsWith('/*')) {
      const endIndex = text.indexOf('*/')
      text = endIndex === -1 ? '' : text.slice(endIndex + 2).trimStart()
      continue
    }

    break
  }

  return text
}

function trimTrailingSemicolons(sql: string): string {
  return sql.replace(/;+\s*$/, '')
}
