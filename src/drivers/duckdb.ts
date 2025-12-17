import * as fs from 'fs'
import * as path from 'path'
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
  TableIndex,
  TableForeignKey,
  TableSchema,
  MutationPlan,
  DataEditResult
} from '@/core/types'
import { SQL_CAPABILITIES } from '@/core/constants'
import { DatabaseDriver } from './base'

interface DuckDBConnection {
  close: () => Promise<void>
  execute: (sql: string) => Promise<DuckDBResult>
}

interface DuckDBResult {
  columns: string[]
  rows: unknown[][]
}

export class DuckDBDriver implements DatabaseDriver {
  id: DatabaseDriverId = 'duckdb'
  displayName = 'DuckDB'
  capabilities = { ...SQL_CAPABILITIES, backupRestore: false }

  private connections = new Map<string, DuckDBConnection>()
  private duckdb: any = null

  private async getDuckDB(): Promise<any> {
    if (!this.duckdb) {
      this.duckdb = await import('duckdb')
    }
    return this.duckdb
  }

  private async getConnection(profile: DbConnectionProfile): Promise<DuckDBConnection> {
    const key = profile.id
    if (!this.connections.has(key)) {
      const duckdb = await this.getDuckDB()
      const dbPath = profile.filePath || ':memory:'
      
      const db = new duckdb.Database(dbPath)
      
      const connection: DuckDBConnection = {
        close: () => new Promise((resolve, reject) => {
          db.close((err: Error | null) => {
            if (err) reject(err)
            else resolve()
          })
        }),
        execute: (sql: string) => new Promise((resolve, reject) => {
          db.all(sql, (err: Error | null, rows: any[]) => {
            if (err) {
              reject(err)
              return
            }
            const columns = rows.length > 0 ? Object.keys(rows[0]) : []
            const values = rows.map(row => Object.values(row))
            resolve({ columns, rows: values })
          })
        })
      }
      
      this.connections.set(key, connection)
    }
    return this.connections.get(key)!
  }

  async testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult> {
    const start = Date.now()
    try {
      const conn = await this.getConnection(profile)
      await conn.execute('SELECT 1')
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

  async listDatabases(profile: DbConnectionProfile): Promise<DatabaseCatalog[]> {
    const conn = await this.getConnection(profile)
    const result = await conn.execute("SELECT database_name FROM information_schema.databases WHERE database_name NOT IN ('information_schema', 'pg_catalog')")
    return result.rows.map((row: unknown[]) => ({
      name: String(row[0]),
      schemas: []
    }))
  }

  async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const conn = await this.getConnection(profile)
    const objects: SchemaObject[] = []

    const tablesResult = await conn.execute(`
      SELECT table_name, table_type 
      FROM information_schema.tables 
      WHERE table_schema = 'main'
    `)
    
    for (const row of tablesResult.rows) {
      const name = String(row[0])
      const type = String(row[1]).toLowerCase()
      objects.push({
        name,
        type: type === 'view' ? 'view' : 'table',
        description: '',
        hasChildren: type !== 'view'
      })
    }

    return objects
  }

  async executeQuery(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    const start = Date.now()
    const conn = await this.getConnection(profile)
    
    const result = await conn.execute(request.sql)
    
    const columns = result.columns.map(col => ({
      name: col,
      type: 'UNKNOWN'
    }))

    const rows = result.rows.map(row => {
      const obj: Record<string, unknown> = {}
      result.columns.forEach((col, i) => {
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
  }

  async getTableSchema(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): Promise<TableSchema> {
    const conn = await this.getConnection(profile)
    const schemaName = scope.schema || scope.database || 'main'
    const metadata: TableSchema['metadata'] = {
      engine: 'DuckDB'
    }

    try {
      const versionResult = await conn.execute('SELECT version() AS version')
      metadata.serverVersion = firstDuckValue(versionResult)
    } catch {
      // Optional metadata only.
    }

    try {
      const tableInfoResult = await conn.execute(`
        SELECT
          database_name,
          schema_name,
          estimated_size,
          column_count,
          index_count,
          check_constraint_count,
          sql
        FROM duckdb_tables()
        WHERE table_name = '${escapeSqlLiteral(tableName)}'
          AND schema_name = '${escapeSqlLiteral(schemaName)}'
        LIMIT 1
      `)
      const tableInfo = firstDuckRow(tableInfoResult)
      if (tableInfo) {
        metadata.databaseName = stringOrUndefined(tableInfo.database_name)
        metadata.schemaName = stringOrUndefined(tableInfo.schema_name)
        metadata.tableRows = numberOrUndefined(tableInfo.estimated_size)
        metadata.columnCount = numberOrUndefined(tableInfo.column_count)
        metadata.indexCount = numberOrUndefined(tableInfo.index_count)
        metadata.checkCount = numberOrUndefined(tableInfo.check_constraint_count)
        metadata.createSql = stringOrUndefined(tableInfo.sql)
      }
    } catch {
      // duckdb_tables() is best-effort across DuckDB versions.
    }

    if (profile.filePath && fs.existsSync(profile.filePath)) {
      metadata.databaseSize = fs.statSync(profile.filePath).size
      metadata.dataLength = metadata.databaseSize
    }

    const columnsResult = await conn.execute(`
      SELECT 
        column_name,
        data_type,
        is_nullable,
        column_default,
        ordinal_position
      FROM information_schema.columns
      WHERE table_name = '${tableName}' AND table_schema = 'main'
      ORDER BY ordinal_position
    `)

    const columns: TableColumn[] = columnsResult.rows.map((row: unknown[]) => ({
      name: String(row[0]),
      type: String(row[1]),
      nullable: row[2] === 'YES',
      defaultValue: row[3] ? String(row[3]) : null,
      isPrimaryKey: false,
      isAutoIncrement: false,
      comment: '',
      position: Number(row[4])
    }))

    const indexesResult = await conn.execute(`
      SELECT index_name, column_name 
      FROM duckdb_indexes() 
      WHERE table_name = '${tableName}'
    `)

    const indexMap = new Map<string, TableIndex>()
    for (const row of indexesResult.rows) {
      const name = String(row[0])
      if (!indexMap.has(name)) {
        indexMap.set(name, {
          name,
          columns: [],
          isUnique: false,
          isPrimary: name.includes('PRIMARY') || name === 'pk_' + tableName
        })
      }
      indexMap.get(name)!.columns.push(String(row[1]))
    }

    return {
      name: tableName,
      columns,
      indexes: Array.from(indexMap.values()),
      foreignKeys: [],
      metadata
    }
  }

  async planInsert(
    profile: DbConnectionProfile,
    table: string,
    row: Record<string, unknown>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    const columns = Object.keys(row).join(', ')
    const params = Object.keys(row).map(() => '?').join(', ')
    const sql = `INSERT INTO ${table} (${columns}) VALUES (${params})`

    return {
      table,
      type: 'insert',
      sql,
      description: `Insert new row into ${table}`
    }
  }

  async planUpdate(
    profile: DbConnectionProfile,
    table: string,
    row: Record<string, unknown>,
    originalRow: Record<string, unknown>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    const tableSchema = await this.getTableSchema(profile, table, scope)
    const primaryKeyColumns = tableSchema.columns.filter(c => c.isPrimaryKey).map(c => c.name)

    if (primaryKeyColumns.length === 0) {
      throw new Error('Cannot update table without primary key')
    }

    const setClauses = Object.keys(row)
      .filter(k => !primaryKeyColumns.includes(k))
      .map(k => `${k} = ?`)
      .join(', ')

    const whereClauses = primaryKeyColumns.map(k => `${k} = ?`).join(' AND ')
    const sql = `UPDATE ${table} SET ${setClauses} WHERE ${whereClauses}`

    return {
      table,
      type: 'update',
      sql,
      description: `Update row in ${table}`
    }
  }

  async planDelete(
    profile: DbConnectionProfile,
    table: string,
    row: Record<string, unknown>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    const tableSchema = await this.getTableSchema(profile, table, scope)
    const primaryKeyColumns = tableSchema.columns.filter(c => c.isPrimaryKey).map(c => c.name)

    if (primaryKeyColumns.length === 0) {
      throw new Error('Cannot delete from table without primary key')
    }

    const whereClauses = primaryKeyColumns.map(k => `${k} = ?`).join(' AND ')
    const sql = `DELETE FROM ${table} WHERE ${whereClauses}`

    return {
      table,
      type: 'delete',
      sql,
      description: `Delete row from ${table}`
    }
  }

  async executeMutation(
    profile: DbConnectionProfile,
    plan: MutationPlan
  ): Promise<DataEditResult> {
    const conn = await this.getConnection(profile)

    try {
      await conn.execute(plan.sql)
      return {
        success: true,
        sqlPreview: plan.sql,
        affectedRows: 1,
        message: `Row ${plan.type}ed`
      }
    } catch (error) {
      return {
        success: false,
        sqlPreview: plan.sql,
        affectedRows: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async dispose(profileId: string): Promise<void> {
    const conn = this.connections.get(profileId)
    if (conn) {
      await conn.close()
      this.connections.delete(profileId)
    }
  }
}

function firstDuckRow(result: DuckDBResult): Record<string, unknown> | undefined {
  if (result.rows.length === 0) {
    return undefined
  }

  const row = result.rows[0]
  const object: Record<string, unknown> = {}
  result.columns.forEach((column, index) => {
    object[column] = row[index]
  })
  return object
}

function firstDuckValue(result: DuckDBResult): string | undefined {
  if (result.rows.length === 0 || result.rows[0].length === 0) {
    return undefined
  }

  return stringOrUndefined(result.rows[0][0])
}

function escapeSqlLiteral(value: string): string {
  return String(value).replace(/'/g, "''")
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  return String(value)
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined
  }

  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}
