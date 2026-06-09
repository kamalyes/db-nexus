import { Uri, window, workspace } from 'vscode'
import { QueryResult } from '@/core/types'
import { formatExportValue, formatSqlLiteral } from '@/core/sqlValue'

export class DataExportService {
  static async exportToCSV(result: QueryResult, defaultFileName: string): Promise<void> {
    const uri = await window.showSaveDialog({
      defaultUri: Uri.file(`${defaultFileName}.csv`),
      filters: {
        'CSV Files': ['csv']
      }
    })

    if (!uri) return

    const csv = this._convertToCSV(result)
    const content = new TextEncoder().encode(csv)

    await workspace.fs.writeFile(uri, content)
    window.showInformationMessage(`Exported ${result.rowCount} rows to ${uri.fsPath}`)
  }

  static async exportToJSON(result: QueryResult, defaultFileName: string): Promise<void> {
    const uri = await window.showSaveDialog({
      defaultUri: Uri.file(`${defaultFileName}.json`),
      filters: {
        'JSON Files': ['json']
      }
    })

    if (!uri) return

    const json = JSON.stringify(result.rows, null, 2)
    const content = new TextEncoder().encode(json)

    await workspace.fs.writeFile(uri, content)
    window.showInformationMessage(`Exported ${result.rowCount} rows to ${uri.fsPath}`)
  }

  static async exportToSQL(
    result: QueryResult,
    tableName: string,
    defaultFileName: string
  ): Promise<void> {
    const uri = await window.showSaveDialog({
      defaultUri: Uri.file(`${defaultFileName}.sql`),
      filters: {
        'SQL Files': ['sql']
      }
    })

    if (!uri) return

    const sql = this._convertToInsertStatements(result, tableName)
    const content = new TextEncoder().encode(sql)

    await workspace.fs.writeFile(uri, content)
    window.showInformationMessage(`Exported ${result.rowCount} rows to ${uri.fsPath}`)
  }

  static async importFromCSV(): Promise<Record<string, unknown>[] | undefined> {
    const uris = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'CSV Files': ['csv']
      }
    })

    if (!uris || uris.length === 0) return undefined

    const content = await workspace.fs.readFile(uris[0])
    const text = new TextDecoder().decode(content)

    return this._parseCSV(text)
  }

  static async importFromJSON(): Promise<Record<string, unknown>[] | undefined> {
    const uris = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'JSON Files': ['json']
      }
    })

    if (!uris || uris.length === 0) return undefined

    const content = await workspace.fs.readFile(uris[0])
    const text = new TextDecoder().decode(content)

    try {
      const data = JSON.parse(text)
      if (Array.isArray(data)) {
        return data
      }
      window.showErrorMessage('JSON file must contain an array of objects')
      return undefined
    } catch (error) {
      window.showErrorMessage('Invalid JSON file')
      return undefined
    }
  }

  private static _convertToCSV(result: QueryResult): string {
    const columns = result.columns.map(c => c.name)

    const escapeCSVValue = (value: unknown): string => {
      if (value === null || value === undefined) return ''
      const str = formatExportValue(value)
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
      }
      return str
    }

    const header = columns.map(escapeCSVValue).join(',')
    const rows = result.rows.map(row => 
      columns.map(col => escapeCSVValue(row[col])).join(',')
    )

    return [header, ...rows].join('\n')
  }

  private static _convertToInsertStatements(
    result: QueryResult,
    tableName: string
  ): string {
    const columns = result.columns.map(c => c.name)
    const statements: string[] = []

    for (const row of result.rows) {
      const values = columns.map(col => formatSqlLiteral(row[col]))
      const columnList = columns.map(c => `"${c}"`).join(', ')
      const valueList = values.join(', ')
      statements.push(`INSERT INTO "${tableName}" (${columnList}) VALUES (${valueList});`)
    }

    return statements.join('\n')
  }

  private static _parseCSV(text: string): Record<string, unknown>[] {
    const lines = text.split(/\r?\n/)
    if (lines.length < 2) return []

    const parseCSVLine = (line: string): string[] => {
      const result: string[] = []
      let current = ''
      let inQuotes = false

      for (let i = 0; i < line.length; i++) {
        const char = line[i]

        if (inQuotes) {
          if (char === '"') {
            if (line[i + 1] === '"') {
              current += '"'
              i++
            } else {
              inQuotes = false
            }
          } else {
            current += char
          }
        } else {
          if (char === '"') {
            inQuotes = true
          } else if (char === ',') {
            result.push(current)
            current = ''
          } else {
            current += char
          }
        }
      }
      result.push(current)

      return result
    }

    const headers = parseCSVLine(lines[0])
    const rows: Record<string, unknown>[] = []

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue

      const values = parseCSVLine(line)
      const row: Record<string, unknown> = {}

      headers.forEach((header, index) => {
        const value = values[index] || ''
        row[header] = value === '' ? null : value
      })

      rows.push(row)
    }

    return rows
  }
}
