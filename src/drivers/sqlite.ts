import * as fs from 'fs'
import type { Database, SqlJsStatic } from 'sql.js'
import { getSqlJsFilePath, loadSqlJs } from '@/core/sqlJs'
import {
  ConnectionTestResult,
  DatabaseCatalog,
  DatabaseDriverId,
  DbConnectionProfile,
  QueryRequest,
  QueryResult,
  SchemaObject,
  SchemaObjectType,
  SchemaScope,
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableSchema
} from '@/core/types'
import { SQL_CAPABILITIES } from '@/core/constants'
import { DatabaseDriver } from './base'

export class SQLiteDriver implements DatabaseDriver {
  id: DatabaseDriverId = 'sqlite'
  displayName = 'SQLite'
  capabilities = SQL_CAPABILITIES

  private SQL: SqlJsStatic | null = null
  private connections = new Map<string, Database>()

  constructor(private readonly extensionPath = '') {}

  private async initSqlJs(): Promise<SqlJsStatic> {
    if (!this.SQL) {
      const initSqlJs = loadSqlJs(this.extensionPath)
      this.SQL = await initSqlJs({
        locateFile: (file: string) => getSqlJsFilePath(this.extensionPath, file)
      })
    }
    return this.SQL
  }

  private async getConnection(profile: DbConnectionProfile): Promise<Database> {
    const key = profile.id
    if (!this.connections.has(key)) {
      if (!profile.filePath) {
        throw new Error('SQLite connection requires a file path')
      }
      const SQL = await this.initSqlJs()
      
      if (fs.existsSync(profile.filePath)) {
        const buffer = fs.readFileSync(profile.filePath)
        const db = new SQL.Database(buffer)
        this.connections.set(key, db)
      } else {
        const db = new SQL.Database()
        this.connections.set(key, db)
      }
    }
    return this.connections.get(key)!
  }

  async testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult> {
    const start = Date.now()
    try {
      if (!profile.filePath) {
        return {
          ok: false,
          message: 'SQLite connection requires a file path'
        }
      }
      const SQL = await this.initSqlJs()
      
      if (fs.existsSync(profile.filePath)) {
        const buffer = fs.readFileSync(profile.filePath)
        const db = new SQL.Database(buffer)
        db.run('SELECT 1')
        db.close()
      } else {
        const db = new SQL.Database()
        db.run('SELECT 1')
        db.close()
      }
      
      return {
        ok: true,
        message: 'Connection successful',
        latencyMs: Date.now() - start
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async listDatabases(_profile: DbConnectionProfile): Promise<DatabaseCatalog[]> {
    return [{ name: 'main', description: 'SQLite main database' }]
  }

  async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const db = await this.getConnection(profile)
    const objects: SchemaObject[] = []

    if (!scope.parentName) {
      objects.push({
        name: 'main',
        type: 'schema' as SchemaObjectType,
        description: 'Main schema'
      })
    } else if (scope.parentName === 'main' && !scope.database) {
      const result = db.exec(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      
      if (result.length > 0) {
        const rows = result[0].values
        for (const row of rows) {
          objects.push({
            name: String(row[0]),
            type: String(row[1]) as SchemaObjectType,
            description: `${row[1]} in main`
          })
        }
      }
    }

    return objects
  }

  async executeQuery(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    const start = Date.now()
    const db = await this.getConnection(profile)

    try {
      let sql = request.sql.trim()
      
      // 如果请求指定了 limit，且 SQL 中没有 LIMIT 子句，则自动追加
      if (request.limit && request.limit > 0) {
        const limitRegex = /\s+LIMIT\s+\d+/i
        if (!limitRegex.test(sql)) {
          sql += ` LIMIT ${request.limit}`
        }
      }
      
      const result = db.exec(sql)
      
      if (result.length === 0) {
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          elapsedMs: Date.now() - start
        }
      }

      const firstResult = result[0]
      const columns = firstResult.columns.map((col: string) => ({
        name: col,
        type: 'TEXT'
      }))

      const rows = firstResult.values.map((row: (string | number | null | Uint8Array)[]) => {
        const obj: Record<string, unknown> = {}
        firstResult.columns.forEach((col: string, i: number) => {
          obj[col] = row[i]
        })
        return obj
      })

      return {
        columns,
        rows,
        rowCount: rows.length,
        elapsedMs: Date.now() - start
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  }

  async getTableSchema(profile: DbConnectionProfile, tableName: string, _scope: SchemaScope): Promise<TableSchema> {
    const db = await this.getConnection(profile)
    const quotedTable = quoteSqliteIdentifier(tableName)
    const tableInfoRows = rowsAsObjects(db.exec(`PRAGMA table_info(${quotedTable})`))

    const columns: TableColumn[] = tableInfoRows.map(row => ({
      name: String(row.name),
      type: String(row.type || 'TEXT'),
      nullable: Number(row.notnull || 0) === 0,
      defaultValue: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
      isPrimaryKey: Number(row.pk || 0) > 0,
      isAutoIncrement: false,
      comment: '',
      position: Number(row.cid || 0) + 1
    }))

    const indexRows = rowsAsObjects(db.exec(`PRAGMA index_list(${quotedTable})`))
    const indexes: TableIndex[] = []
    for (const row of indexRows) {
      const indexName = String(row.name || '')
      if (!indexName) continue

      const indexInfoRows = rowsAsObjects(db.exec(`PRAGMA index_info(${quoteSqliteIdentifier(indexName)})`))
      indexes.push({
        name: indexName,
        columns: indexInfoRows.map(indexInfo => String(indexInfo.name || '')).filter(Boolean),
        isUnique: Number(row.unique || 0) === 1,
        isPrimary: String(row.origin || '') === 'pk',
        type: String(row.origin || '') || undefined
      })
    }

    const foreignKeyRows = rowsAsObjects(db.exec(`PRAGMA foreign_key_list(${quotedTable})`))
    const foreignKeyMap = new Map<string, TableForeignKey>()
    for (const row of foreignKeyRows) {
      const id = String(row.id || '0')
      const name = `fk_${tableName}_${id}`
      if (!foreignKeyMap.has(name)) {
        foreignKeyMap.set(name, {
          name,
          columns: [],
          referencedTable: String(row.table || ''),
          referencedColumns: [],
          onUpdate: String(row.on_update || ''),
          onDelete: String(row.on_delete || '')
        })
      }

      const foreignKey = foreignKeyMap.get(name)!
      foreignKey.columns.push(String(row.from || ''))
      foreignKey.referencedColumns.push(String(row.to || ''))
    }

    const metadata: TableSchema['metadata'] = {
      engine: 'SQLite',
      serverVersion: firstValue(db.exec('SELECT sqlite_version() AS version')),
      charset: firstValue(db.exec('PRAGMA encoding')),
      schemaVersion: numberOrUndefined(firstValue(db.exec('PRAGMA schema_version'))),
      userVersion: numberOrUndefined(firstValue(db.exec('PRAGMA user_version'))),
      pageCount: numberOrUndefined(firstValue(db.exec('PRAGMA page_count'))),
      pageSize: numberOrUndefined(firstValue(db.exec('PRAGMA page_size'))),
      freeListCount: numberOrUndefined(firstValue(db.exec('PRAGMA freelist_count'))),
      journalMode: firstValue(db.exec('PRAGMA journal_mode'))
    }

    if (typeof metadata.pageCount === 'number' && typeof metadata.pageSize === 'number') {
      metadata.dataLength = metadata.pageCount * metadata.pageSize
    }

    if (profile.filePath && fs.existsSync(profile.filePath)) {
      metadata.databaseSize = fs.statSync(profile.filePath).size
    }

    try {
      metadata.tableRows = numberOrUndefined(firstValue(db.exec(`SELECT COUNT(*) AS total FROM ${quotedTable}`)))
    } catch {
      // Views or virtual tables may reject COUNT(*) here; keep the rest of the schema usable.
    }

    return {
      name: tableName,
      columns,
      indexes,
      foreignKeys: Array.from(foreignKeyMap.values()),
      metadata
    }
  }

  async dispose(profileId: string): Promise<void> {
    const db = this.connections.get(profileId)
    if (db) {
      db.close()
      this.connections.delete(profileId)
    }
  }
}

function rowsAsObjects(result: ReturnType<Database['exec']>): Record<string, unknown>[] {
  if (result.length === 0) {
    return []
  }

  const firstResult = result[0]
  return firstResult.values.map(row => {
    const object: Record<string, unknown> = {}
    firstResult.columns.forEach((column, index) => {
      object[column] = row[index]
    })
    return object
  })
}

function firstValue(result: ReturnType<Database['exec']>): string | undefined {
  if (result.length === 0 || result[0].values.length === 0) {
    return undefined
  }

  const value = result[0].values[0][0]
  return value === null || value === undefined || value === '' ? undefined : String(value)
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined
  }

  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}
