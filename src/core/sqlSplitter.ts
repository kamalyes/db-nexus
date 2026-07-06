/**
 * SQL 语句拆分工具
 * 按分号将一段 SQL 拆分为多条独立语句,正确处理字符串字面量、注释与 dollar-quoted 字符串,
 * 避免在引号或注释内部错误切分。
 */

/** 单条 SQL 语句在原文中的位置信息 */
export interface SqlStatement {
  /** 语句文本(已 trim,不含结尾分号) */
  sql: string
  /** 在原始文本中的起始字符索引(从 0 开始) */
  start: number
  /** 在原始文本中的结束字符索引(不含结尾分号) */
  end: number
}

/**
 * 将一段 SQL 文本拆分为多条语句。
 *
 * 支持的上下文(在这些上下文中的分号不作为分隔符):
 * - 单引号字符串 `'...'`,支持 `''` 转义
 * - 双引号标识符 `"..."`,支持 `""` 转义
 * - 反引号标识符 `` `...` ``,支持 `` `` `` 转义
 * - 行注释 `--` 与 `#`(到行尾)
 * - 块注释 `/* *\/`
 * - PostgreSQL dollar-quoted 字符串 `$$...$$` 与 `$tag$...$tag$`
 *
 * 空语句(仅空白/注释)会被跳过。
 *
 * @param input 原始 SQL 文本
 * @returns 语句数组,顺序与原文一致
 */
export function splitSqlStatements(input: string): SqlStatement[] {
  const statements: SqlStatement[] = []
  if (!input) {
    return statements
  }

  const len = input.length
  let statementStart = 0
  let i = 0

  /** 将当前积累的语句(从 statementStart 到 i,不含分号)加入结果 */
  const pushStatement = (): void => {
    const sql = input.slice(statementStart, i).trim()
    if (sql) {
      statements.push({ sql, start: statementStart, end: i })
    }
    // 跳过分号及之后的空白,作为下一条语句的起点
    statementStart = i + 1
  }

  while (i < len) {
    const ch = input[i]
    const next = input[i + 1]

    // 行注释: -- 或 #
    if (ch === '-' && next === '-' || ch === '#') {
      // 跳到行尾
      i += ch === '-' ? 2 : 1
      while (i < len && input[i] !== '\n') {
        i++
      }
      continue
    }

    // 块注释: /* ... */
    if (ch === '/' && next === '*') {
      i += 2
      while (i < len && !(input[i] === '*' && input[i + 1] === '/')) {
        i++
      }
      i += 2 // 跳过结束符 */
      continue
    }

    // 单引号字符串
    if (ch === '\'') {
      i++
      while (i < len) {
        if (input[i] === '\'') {
          if (input[i + 1] === '\'') {
            // 转义的单引号 ''
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }

    // 双引号标识符
    if (ch === '"') {
      i++
      while (i < len) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }

    // 反引号标识符
    if (ch === '`') {
      i++
      while (i < len) {
        if (input[i] === '`') {
          if (input[i + 1] === '`') {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      continue
    }

    // PostgreSQL dollar-quoted 字符串: $$...$$ 或 $tag$...$tag$
    if (ch === '$') {
      const tag = matchDollarQuoteTag(input, i)
      if (tag) {
        const closeTag = `$${tag}$`
        const closeIndex = input.indexOf(closeTag, i + tag.length + 2)
        if (closeIndex === -1) {
          // 未闭合,直接消费到结尾
          i = len
        } else {
          i = closeIndex + closeTag.length
        }
        continue
      }
    }

    // 语句分隔符
    if (ch === ';') {
      pushStatement()
      i++
      continue
    }

    i++
  }

  // 处理最后一条(无结尾分号的情况)
  if (statementStart < len) {
    const sql = input.slice(statementStart, len).trim()
    if (sql) {
      statements.push({ sql, start: statementStart, end: len })
    }
  }

  return statements
}

/**
 * 从指定位置匹配 dollar-quote 的标签。
 * 例如 `$$` 返回空字符串,`$tag$` 返回 `tag`。
 * 不是 dollar-quote 时返回 null。
 */
function matchDollarQuoteTag(input: string, start: number): string | null {
  // start 位置是 '$'
  let i = start + 1
  let tag = ''
  while (i < input.length) {
    const ch = input[i]
    if (ch === '$') {
      // 找到闭合的 $,标签必须是合法标识符(字母/下划线开头,其余为字母数字下划线)
      if (tag === '' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) {
        return tag
      }
      return null
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      tag += ch
      i++
    } else {
      return null
    }
  }
  return null
}
