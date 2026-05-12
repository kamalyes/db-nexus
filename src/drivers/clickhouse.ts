import https from 'https'
import http from 'http'
import { appendLimitIfNeeded } from '@/core/sql'
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
  TableSchema
} from '@/core/types'
import { DatabaseDriver } from './base'
import { SecretService } from '@/services/secretService'

interface ClickHouseResponse {
  meta?: Array<{ name: string; type: string }>
  data?: Record<string, unknown>[]
  rows?: number
  statistics?: { elapsed: number }
}

export class ClickHouseDriver implements DatabaseDriver {
  id: DatabaseDriverId = 'clickhouse'
  displayName = 'ClickHouse'
  capabilities = {
    schemaBrowse: true,
    query: true,
    dataEdit: false,
    transactions: false,
    explain: true,
    erd: false,
    importExport: true,
    backupRestore: false,
    streaming: false
  }

  private async getPassword(profile: DbConnectionProfile): Promise<string> {
    try {
      const secretService = SecretService.getInstance()
      return (await secretService.getPassword(profile.id)) || ''
    } catch {
      return ''
    }
  }

  private getBaseUrl(profile: DbConnectionProfile): string {
    const protocol = profile.ssl ? 'https' : 'http'
    const host = profile.host || 'localhost'
    const port = profile.port || 8123
    return `${protocol}://${host}:${port}`
  }

  private async query(profile: DbConnectionProfile, sql: string): Promise<ClickHouseResponse> {
    const baseUrl = this.getBaseUrl(profile)
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.searchParams.set('query', ensureJsonFormat(sql))

    const username = profile.username || 'default'
    const password = await this.getPassword(profile)

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      timeout: (profile.readTimeout ?? profile.connectTimeout ?? 30) * 1000,
      headers: {
        'Accept': 'application/json',
        'X-ClickHouse-User': username,
        'X-ClickHouse-Key': password
      }
    }

    return new Promise((resolve, reject) => {
      const client = profile.ssl ? https : http
      const req = client.request(options, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (json.exception) {
              reject(new Error(json.exception))
            } else {
              resolve(json)
            }
          } catch {
            reject(new Error(`Invalid response: ${data.substring(0, 200)}`))
          }
        })
      })
      req.on('error', reject)
      req.setTimeout((profile.readTimeout ?? profile.connectTimeout ?? 30) * 1000, () => {
        req.destroy(new Error('ClickHouse request timed out'))
      })
      req.end()
    })
  }

  async testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult> {
    const start = Date.now()
    try {
      await this.query(profile, 'SELECT 1')
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
    const result = await this.query(profile, 'SHOW DATABASES')
    return (result.data || []).map((row: Record<string, unknown>) => ({
      name: String(row.name || '')
    }))
  }

  async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const objects: SchemaObject[] = []

    if (!scope.database) {
      // List databases
      const databases = await this.listDatabases(profile)
      for (const db of databases) {
        objects.push({
          name: db.name,
          type: 'schema' as SchemaObjectType,
          description: 'Database'
        })
      }
    } else {
      // List tables in the database
      const result = await this.query(profile, `SHOW TABLES FROM ${scope.database}`)
      for (const row of result.data || []) {
        const tableName = Object.values(row)[0] as string
        objects.push({
          name: tableName,
          type: 'table' as SchemaObjectType,
          description: 'Table'
        })
      }
    }

    return objects
  }

  async executeQuery(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    const start = Date.now()

    try {
      let sql = appendLimitIfNeeded(request.sql, request.limit).replace(/;+\s*$/, '')

      sql += ' FORMAT JSON'

      const result = await this.query(profile, sql)

      const columns = (result.meta || []).map(col => ({
        name: col.name,
        type: col.type
      }))

      return {
        columns,
        rows: result.data || [],
        rowCount: result.rows || 0,
        elapsedMs: Date.now() - start
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  }

  async getTableSchema(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): Promise<TableSchema> {
    const database = scope.database || profile.database || 'default'
    const metadata: TableSchema['metadata'] = {
      engine: 'ClickHouse'
    }

    try {
      const versionResult = await this.query(profile, 'SELECT version() AS version')
      metadata.serverVersion = stringOrUndefined(versionResult.data?.[0]?.version)
    } catch {
      // Optional metadata only.
    }

    try {
      const sessionsResult = await this.query(profile, 'SELECT count() AS active_sessions FROM system.processes')
      metadata.activeSessions = numberOrUndefined(sessionsResult.data?.[0]?.active_sessions)
    } catch {
      // Optional metadata only.
    }

    const tableResult = await this.query(profile, `
      SELECT
        engine,
        total_rows,
        total_bytes,
        metadata_modification_time,
        create_table_query,
        primary_key,
        sorting_key,
        partition_key
      FROM system.tables
      WHERE database = '${escapeSqlLiteral(database)}'
        AND name = '${escapeSqlLiteral(tableName)}'
      LIMIT 1
    `)

    const tableInfo = tableResult.data?.[0] || {}
    metadata.engine = stringOrUndefined(tableInfo.engine) || 'ClickHouse'
    metadata.tableRows = numberOrUndefined(tableInfo.total_rows)
    metadata.dataLength = numberOrUndefined(tableInfo.total_bytes)
    metadata.updateTime = stringOrUndefined(tableInfo.metadata_modification_time)
    metadata.createSql = stringOrUndefined(tableInfo.create_table_query)
    metadata.primaryKeys = stringOrUndefined(tableInfo.primary_key)
    metadata.sortingKey = stringOrUndefined(tableInfo.sorting_key)
    metadata.partitionKey = stringOrUndefined(tableInfo.partition_key)

    const columnsResult = await this.query(profile, `
      SELECT
        name,
        type,
        default_expression,
        position,
        comment
      FROM system.columns
      WHERE database = '${escapeSqlLiteral(database)}'
        AND table = '${escapeSqlLiteral(tableName)}'
      ORDER BY position
    `)

    const primaryKeyExpression = stringOrUndefined(tableInfo.primary_key) || ''
    const columns: TableColumn[] = (columnsResult.data || []).map(row => {
      const name = String(row.name || '')
      const type = String(row.type || '')
      return {
        name,
        type,
        nullable: type.startsWith('Nullable('),
        defaultValue: row.default_expression === null || row.default_expression === undefined ? null : String(row.default_expression),
        isPrimaryKey: isClickHousePrimaryKeyColumn(primaryKeyExpression, name),
        isAutoIncrement: false,
        comment: String(row.comment || ''),
        position: Number(row.position || 0)
      }
    })

    const indexes: TableIndex[] = []
    try {
      const indexResult = await this.query(profile, `
        SELECT name, expr, type
        FROM system.data_skipping_indices
        WHERE database = '${escapeSqlLiteral(database)}'
          AND table = '${escapeSqlLiteral(tableName)}'
        ORDER BY name
      `)
      indexes.push(...(indexResult.data || []).map(row => ({
        name: String(row.name || ''),
        columns: [String(row.expr || '')].filter(Boolean),
        isUnique: false,
        isPrimary: false,
        type: String(row.type || '')
      })))
    } catch {
      // Data-skipping indexes may be unavailable on older ClickHouse versions.
    }

    return {
      name: tableName,
      columns,
      indexes,
      foreignKeys: [],
      comment: columns.find(column => column.comment)?.comment,
      metadata
    }
  }
}

function ensureJsonFormat(sql: string): string {
  const trimmed = sql.trim().replace(/;$/, '')
  return /\bFORMAT\s+JSON\b/i.test(trimmed) ? trimmed : `${trimmed} FORMAT JSON`
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

function isClickHousePrimaryKeyColumn(primaryKeyExpression: string, columnName: string): boolean {
  if (!primaryKeyExpression) {
    return false
  }

  const normalizedParts = primaryKeyExpression
    .replace(/[()]/g, '')
    .split(',')
    .map(part => part.trim().replace(/^`|`$/g, ''))

  return normalizedParts.includes(columnName)
}
