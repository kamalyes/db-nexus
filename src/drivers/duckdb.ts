import * as fs from 'fs'
import * as path from 'path'
import { appendLimitIfNeeded, joinFilterClauses } from '@/core/sql'
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
  DataEditResult,
  DataQueryOptions
} from '@/core/types'
import { SQL_CAPABILITIES } from '@/core/constants'
import { uniqueRowsByColumns } from '@/core/mutations'
import { DatabaseDriver } from './base'
import { SqlExecutionLogService } from '@/services/sqlExecutionLogService'

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

  private async loggedExecute(
    profile: DbConnectionProfile,
    conn: DuckDBConnection,
    sql: string
  ): Promise<DuckDBResult> {
    const start = Date.now()
    try {
      const result = await conn.execute(sql)
      await SqlExecutionLogService.tryRecordStatement(sql, profile, Date.now() - start, result.rows.length)
      return result
    } catch (error: unknown) {
      await SqlExecutionLogService.tryRecordError(sql, profile, error, Date.now() - start)
      throw error
    }
  }

  async testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult> {
    const start = Date.now()
    try {
      const conn = await this.getConnection(profile)
      await this.loggedExecute(profile, conn, 'SELECT 1')
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
    const result = await this.loggedExecute(profile, conn, "SELECT database_name FROM information_schema.databases WHERE database_name NOT IN ('information_schema', 'pg_catalog')")
    return result.rows.map((row: unknown[]) => ({
      name: String(row[0]),
      schemas: []
    }))
  }

  async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const conn = await this.getConnection(profile)
    const objects: SchemaObject[] = []
    const schemaName = scope.schema || scope.database || 'main'

    const tablesResult = await this.loggedExecute(profile, conn, `
      SELECT
        t.table_name,
        t.table_type,
        COALESCE(dt.comment, dv.comment, '') AS comment,
        dt.estimated_size
      FROM information_schema.tables t
      LEFT JOIN duckdb_tables() dt
        ON dt.schema_name = t.table_schema
       AND dt.table_name = t.table_name
      LEFT JOIN duckdb_views() dv
        ON dv.schema_name = t.table_schema
       AND dv.view_name = t.table_name
      WHERE t.table_schema = '${escapeSqlLiteral(schemaName)}'
      ORDER BY t.table_name
    `)
    
    for (const row of tablesResult.rows) {
      const name = String(row[0])
      const type = String(row[1]).toLowerCase()
      objects.push({
        name,
        type: type === 'view' ? 'view' : 'table',
        description: stringOrUndefined(row[2]) || (type === 'view' ? 'View' : 'Table'),
        rowCount: numberOrUndefined(row[3]),
        hasChildren: type !== 'view'
      })
    }

    return objects
  }

  async executeQuery(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    const start = Date.now()
    const conn = await this.getConnection(profile)
    
    const sql = appendLimitIfNeeded(request.sql, request.limit)

    const result = await conn.execute(sql)
    
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

  async getTableData(
    profile: DbConnectionProfile,
    tableName: string,
    scope: SchemaScope,
    options?: DataQueryOptions
  ): Promise<QueryResult> {
    const start = Date.now()
    const conn = await this.getConnection(profile)
    const schema = await this.getTableSchema(profile, tableName, scope)
    const qualifiedTable = getDuckQualifiedTableName(tableName, scope)
    const whereSql = buildDuckWhereSql(options)
    const orderSql = buildDuckOrderSql(options)
    const limit = options?.limit || 100
    const offset = options?.offset || 0

    const result = await this.loggedExecute(profile, conn, `SELECT * FROM ${qualifiedTable}${whereSql}${orderSql} LIMIT ${limit} OFFSET ${offset}`)
    const countResult = await this.loggedExecute(profile, conn, `SELECT COUNT(*) AS total FROM ${qualifiedTable}${whereSql}`)
    const rows = result.rows.map(row => {
      const obj: Record<string, unknown> = {}
      result.columns.forEach((col, index) => {
        obj[col] = row[index]
      })
      return obj
    })
    const totalRows = Number(firstDuckValue(countResult) || 0)

    return {
      columns: schema.columns.map(column => ({ name: column.name, type: column.type })),
      rows,
      rowCount: rows.length,
      elapsedMs: Date.now() - start,
      hasMore: offset + rows.length < totalRows,
      totalRows
    }
  }

  async getTableSchema(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): Promise<TableSchema> {
    const conn = await this.getConnection(profile)
    const schemaName = scope.schema || scope.database || 'main'
    const metadata: TableSchema['metadata'] = {
      engine: 'DuckDB'
    }

    try {
      const versionResult = await this.loggedExecute(profile, conn, 'SELECT version() AS version')
      metadata.serverVersion = firstDuckValue(versionResult)
    } catch {
      // Optional metadata only.
    }

    try {
      const tableInfoResult = await this.loggedExecute(profile, conn, `
        SELECT
          database_name,
          schema_name,
          estimated_size,
          column_count,
          index_count,
          check_constraint_count,
          sql,
          comment
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
        metadata.comment = stringOrUndefined(tableInfo.comment)
      }
    } catch {
      // duckdb_tables() is best-effort across DuckDB versions.
    }

    if (profile.filePath && fs.existsSync(profile.filePath)) {
      metadata.databaseSize = fs.statSync(profile.filePath).size
      metadata.dataLength = metadata.databaseSize
    }

    const primaryKeyColumns = new Set<string>()
    try {
      const constraintsResult = await this.loggedExecute(profile, conn, `
        SELECT constraint_column_names
        FROM duckdb_constraints()
        WHERE table_name = '${escapeSqlLiteral(tableName)}'
          AND schema_name = '${escapeSqlLiteral(schemaName)}'
          AND constraint_type = 'PRIMARY KEY'
      `)
      for (const row of constraintsResult.rows) {
        for (const columnName of parseDuckStringList(row[0])) {
          primaryKeyColumns.add(columnName)
        }
      }
    } catch {
      // Primary key metadata is best-effort across DuckDB versions.
    }

    const columnsResult = await this.loggedExecute(profile, conn, `
      SELECT
        column_name,
        data_type,
        is_nullable,
        column_default,
        column_index,
        comment
      FROM duckdb_columns()
      WHERE table_name = '${escapeSqlLiteral(tableName)}'
        AND schema_name = '${escapeSqlLiteral(schemaName)}'
      ORDER BY column_index
    `)

    const columns: TableColumn[] = columnsResult.rows.map((row: unknown[]) => ({
      name: String(row[0]),
      type: String(row[1]),
      nullable: row[2] === true || row[2] === 'YES' || String(row[2]).toLowerCase() === 'true',
      defaultValue: row[3] ? String(row[3]) : null,
      isPrimaryKey: primaryKeyColumns.has(String(row[0])),
      isAutoIncrement: false,
      comment: String(row[5] || ''),
      position: Number(row[4])
    }))

    const indexesResult = await this.loggedExecute(profile, conn, `
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
      comment: stringOrUndefined(metadata.comment),
      metadata
    }
  }

  async planInsert(
    profile: DbConnectionProfile,
    table: string,
    row: Record<string, unknown>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    const qualifiedTable = getDuckQualifiedTableName(table, scope)
    const rowColumns = Object.keys(row)
    const columns = rowColumns.map(quoteDuckIdentifier).join(', ')
    const params = rowColumns.map(() => '?').join(', ')
    const sql = rowColumns.length === 0
      ? `INSERT INTO ${qualifiedTable} DEFAULT VALUES`
      : `INSERT INTO ${qualifiedTable} (${columns}) VALUES (${params})`

    return {
      table,
      type: 'insert',
      sql,
      parameters: Object.values(row),
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
    const qualifiedTable = getDuckQualifiedTableName(table, scope)
    const tableSchema = await this.getTableSchema(profile, table, scope)
    const primaryKeyColumns = tableSchema.columns.filter(c => c.isPrimaryKey).map(c => c.name)

    if (primaryKeyColumns.length === 0) {
      throw new Error('Cannot update table without primary key')
    }

    const setColumns = Object.keys(row)
    const setClauses = setColumns
      .map(k => `${quoteDuckIdentifier(k)} = ?`)
      .join(', ')

    const whereClauses = primaryKeyColumns.map(k => `${quoteDuckIdentifier(k)} = ?`).join(' AND ')
    const sql = `UPDATE ${qualifiedTable} SET ${setClauses} WHERE ${whereClauses}`

    return {
      table,
      type: 'update',
      sql,
      parameters: [
        ...setColumns.map(column => row[column]),
        ...primaryKeyColumns.map(column => originalRow[column])
      ],
      description: `Update row in ${table}`
    }
  }

  async planDelete(
    profile: DbConnectionProfile,
    table: string,
    row: Record<string, unknown>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    return this.planBulkDelete(profile, table, [row], scope)
  }

  async planBulkDelete(
    profile: DbConnectionProfile,
    table: string,
    rows: Array<Record<string, unknown>>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    const qualifiedTable = getDuckQualifiedTableName(table, scope)
    const tableSchema = await this.getTableSchema(profile, table, scope)
    const primaryKeyColumns = tableSchema.columns.filter(c => c.isPrimaryKey).map(c => c.name)

    if (primaryKeyColumns.length === 0) {
      throw new Error('Cannot delete from table without primary key')
    }

    const deleteRows = uniqueRowsByColumns(rows, primaryKeyColumns)
    const parameters: unknown[] = []
    const whereClauses = primaryKeyColumns.length === 1
      ? `${quoteDuckIdentifier(primaryKeyColumns[0])} IN (${deleteRows.map(row => {
          parameters.push(row[primaryKeyColumns[0]])
          return '?'
        }).join(', ')})`
      : deleteRows.map(row => `(${primaryKeyColumns.map(column => {
          parameters.push(row[column])
          return `${quoteDuckIdentifier(column)} = ?`
        }).join(' AND ')})`).join(' OR ')
    const sql = `DELETE FROM ${qualifiedTable} WHERE ${whereClauses}`

    return {
      table,
      type: 'delete',
      sql,
      parameters,
      expectedAffectedRows: deleteRows.length,
      description: `Delete ${deleteRows.length} row(s) from ${table}`
    }
  }

  async executeMutation(
    profile: DbConnectionProfile,
    plan: MutationPlan
  ): Promise<DataEditResult> {
    const conn = await this.getConnection(profile)
    const params = plan.parameters || []
    const interpolatedSql = params.reduce<string>((sql, value) => sql.replace('?', formatDuckValue(value)), plan.sql)

    try {
      await conn.execute(interpolatedSql)
      const affectedRows = plan.expectedAffectedRows || 1
      return {
        success: true,
        sqlPreview: interpolatedSql,
        affectedRows,
        message: `${affectedRows} row(s) ${plan.type}ed`
      }
    } catch (error) {
      return {
        success: false,
        sqlPreview: interpolatedSql,
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

function getDuckQualifiedTableName(tableName: string, scope: SchemaScope): string {
  const schemaName = scope.schema || scope.database || 'main'
  return `${quoteDuckIdentifier(schemaName)}.${quoteDuckIdentifier(tableName)}`
}

function buildDuckWhereSql(options?: DataQueryOptions): string {
  if (!options?.filters || options.filters.length === 0) {
    return ''
  }

  const clauses = options.filters.map(filter => {
    const column = quoteDuckIdentifier(filter.column)
    if (filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL') {
      return `${column} ${filter.operator}`
    }
    if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value]
      return `${column} ${filter.operator} (${values.map(formatDuckValue).join(', ')})`
    }
    return `${column} ${filter.operator} ${formatDuckValue(filter.value)}`
  })
  return ` WHERE ${joinFilterClauses(options.filters, clauses)}`
}

function buildDuckOrderSql(options?: DataQueryOptions): string {
  if (!options?.sorts || options.sorts.length === 0) {
    return ''
  }
  return ` ORDER BY ${options.sorts.map(sort => `${quoteDuckIdentifier(sort.column)} ${sort.direction}`).join(', ')}`
}

function quoteDuckIdentifier(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`
}

function formatDuckValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return 'NULL'
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  return `'${escapeSqlLiteral(String(value))}'`
}

function escapeSqlLiteral(value: string): string {
  return String(value).replace(/'/g, "''")
}

function parseDuckStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean)
  }

  return String(value || '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
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
