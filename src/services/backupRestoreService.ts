import { window, Uri, workspace, ProgressLocation } from 'vscode'
import { DbConnectionProfile, SchemaScope, QueryResult } from '@/core/types'
import { DatabaseDriver } from '@/drivers/base'
import { t } from '@/i18n'
import { DriverRegistry } from '@/drivers/registry'

export interface BackupOptions {
  includeData: boolean
  includeSchema: boolean
  tables?: string[]
  format: 'sql' | 'json'
}

export interface RestoreOptions {
  dropExisting: boolean
  format: 'sql' | 'json'
}

export class BackupRestoreService {
  private registry: DriverRegistry

  constructor() {
    this.registry = new DriverRegistry()
  }

  static async backupDatabase(
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    scope: SchemaScope,
    options: BackupOptions
  ): Promise<void> {
    const defaultName = profile.name.replace(/[^a-zA-Z0-9]/g, '_')
    const extension = options.format === 'sql' ? 'sql' : 'json'
    
    const uri = await window.showSaveDialog({
      defaultUri: Uri.file(`${defaultName}_backup.${extension}`),
      filters: {
        'SQL Files': ['sql'],
        'JSON Files': ['json']
      }
    })

    if (!uri) return

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: t('backup.inProgress'),
        cancellable: false
      },
      async (progress) => {
        progress.report({ increment: 0, message: t('backup.preparing') })

        const content: string[] = []
        
        if (options.format === 'sql') {
          content.push(`-- Database Backup: ${profile.name}`)
          content.push(`-- Generated: ${new Date().toISOString()}`)
          content.push(`-- Driver: ${driver.displayName}`)
          content.push('')
        }

        if (options.includeSchema) {
          progress.report({ increment: 20, message: t('backup.exportingSchema') })
          const schemaContent = await BackupRestoreService._exportSchema(profile, driver, scope, options)
          content.push(schemaContent)
        }

        if (options.includeData) {
          progress.report({ increment: 40, message: t('backup.exportingData') })
          const dataContent = await BackupRestoreService._exportData(profile, driver, scope, options)
          content.push(dataContent)
        }

        progress.report({ increment: 80, message: t('backup.writingFile') })
        
        const fullContent = content.join('\n')
        const bytes = new TextEncoder().encode(fullContent)
        await workspace.fs.writeFile(uri, bytes)

        progress.report({ increment: 100, message: t('backup.completed') })
      }
    )

    window.showInformationMessage(t('backup.success', uri.fsPath))
  }

  static async restoreDatabase(
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    scope: SchemaScope,
    options: RestoreOptions
  ): Promise<void> {
    const uris = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'SQL Files': ['sql'],
        'JSON Files': ['json']
      }
    })

    if (!uris || uris.length === 0) return

    const uri = uris[0]
    const content = await workspace.fs.readFile(uri)
    const text = new TextDecoder().decode(content)

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: t('restore.inProgress'),
        cancellable: false
      },
      async (progress) => {
        progress.report({ increment: 0, message: t('restore.preparing') })

        if (options.format === 'sql') {
          await BackupRestoreService._restoreFromSQL(profile, driver, text, options, progress)
        } else {
          await BackupRestoreService._restoreFromJSON(profile, driver, text, options, progress)
        }

        progress.report({ increment: 100, message: t('restore.completed') })
      }
    )

    window.showInformationMessage(t('restore.success', uri.fsPath))
  }

  private static async _exportSchema(
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    scope: SchemaScope,
    options: BackupOptions
  ): Promise<string> {
    const lines: string[] = []
    
    if (options.format === 'sql') {
      lines.push('-- Schema Definition')
      lines.push('')
    }

    const objects = await driver.listObjects(profile, scope)
    const tables = options.tables 
      ? objects.filter(obj => obj.type === 'table' && options.tables!.includes(obj.name))
      : objects.filter(obj => obj.type === 'table')

    for (const table of tables) {
      if (driver.getDDL) {
        try {
          const ddl = await driver.getDDL(profile, table.name, 'table', scope)
          if (options.format === 'sql') {
            lines.push(`-- Table: ${table.name}`)
            lines.push(ddl)
            lines.push('')
          } else {
            lines.push(JSON.stringify({
              type: 'table',
              name: table.name,
              ddl: ddl
            }))
          }
        } catch (error) {
          console.error(`Failed to export DDL for ${table.name}:`, error)
        }
      }
    }

    return lines.join('\n')
  }

  private static async _exportData(
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    scope: SchemaScope,
    options: BackupOptions
  ): Promise<string> {
    const lines: string[] = []
    
    if (options.format === 'sql') {
      lines.push('-- Data')
      lines.push('')
    }

    const objects = await driver.listObjects(profile, scope)
    const tables = options.tables 
      ? objects.filter(obj => obj.type === 'table' && options.tables!.includes(obj.name))
      : objects.filter(obj => obj.type === 'table')

    for (const table of tables) {
      try {
        const qualifiedName = scope.database ? `${scope.database}.${table.name}` : table.name
        const result = await driver.executeQuery(profile, {
          sql: `SELECT * FROM ${qualifiedName}`
        })

        if (result.rows.length === 0) continue

        if (options.format === 'sql') {
          lines.push(`-- Data for table: ${table.name}`)
          const insertStatements = BackupRestoreService._generateInsertStatements(table.name, result)
          lines.push(insertStatements)
          lines.push('')
        } else {
          lines.push(JSON.stringify({
            type: 'data',
            table: table.name,
            rows: result.rows
          }))
        }
      } catch (error) {
        console.error(`Failed to export data for ${table.name}:`, error)
      }
    }

    return lines.join('\n')
  }

  private static _generateInsertStatements(tableName: string, result: QueryResult): string {
    const lines: string[] = []
    const columns = result.columns.map(c => c.name)

    for (const row of result.rows) {
      const values = columns.map(col => {
        const value = (row as Record<string, unknown>)[col]
        if (value === null || value === undefined) {
          return 'NULL'
        }
        if (typeof value === 'string') {
          return `'${value.replace(/'/g, "''")}'`
        }
        if (value instanceof Date) {
          return `'${value.toISOString()}'`
        }
        return String(value)
      })

      lines.push(`INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});`)
    }

    return lines.join('\n')
  }

  private static async _restoreFromSQL(
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    sql: string,
    _options: RestoreOptions,
    progress: { report: (value: { increment: number; message: string }) => void }
  ): Promise<void> {
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'))

    let completed = 0
    const total = statements.length

    for (const statement of statements) {
      try {
        await driver.executeQuery(profile, { sql: statement })
        completed++
        progress.report({
          increment: (completed / total) * 80,
          message: t('restore.executingStatement', String(completed), String(total))
        })
      } catch (error) {
        console.error('Failed to execute statement:', statement, error)
      }
    }
  }

  private static async _restoreFromJSON(
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    json: string,
    _options: RestoreOptions,
    progress: { report: (value: { increment: number; message: string }) => void }
  ): Promise<void> {
    const lines = json.split('\n').filter(line => line.trim().length > 0)
    let completed = 0
    const total = lines.length

    for (const line of lines) {
      try {
        const item = JSON.parse(line)
        
        if (item.type === 'table' && item.ddl) {
          await driver.executeQuery(profile, { sql: item.ddl })
        } else if (item.type === 'data' && item.table && item.rows) {
          for (const row of item.rows) {
            const columns = Object.keys(row)
            const values = columns.map(col => {
              const value = row[col]
              if (value === null || value === undefined) return 'NULL'
              if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
              return String(value)
            })
            const insertSql = `INSERT INTO ${item.table} (${columns.join(', ')}) VALUES (${values.join(', ')})`
            await driver.executeQuery(profile, { sql: insertSql })
          }
        }

        completed++
        progress.report({
          increment: (completed / total) * 80,
          message: t('restore.processingItem', String(completed), String(total))
        })
      } catch (error) {
        console.error('Failed to process JSON line:', line, error)
      }
    }
  }
}
