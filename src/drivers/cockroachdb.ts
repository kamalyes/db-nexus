import { PostgreSQLDriver } from './postgresql'
import { DatabaseDriverId, DbConnectionProfile, SchemaScope, SchemaObject, SchemaObjectType, TableSchema } from '@/core/types'
import { Pool } from 'pg'
import { SecretService } from '@/services/secretService'

export class CockroachDBDriver extends PostgreSQLDriver {
  override id: DatabaseDriverId = 'cockroachdb'
  override displayName = 'CockroachDB'

  private cockroachPools = new Map<string, Pool>()

  protected override getDefaultDatabase(profile: DbConnectionProfile): string {
    return profile.database || 'defaultdb'
  }

  protected override async getPool(profile: DbConnectionProfile, database = this.getDefaultDatabase(profile)): Promise<Pool> {
    const key = this.getPoolKey(profile, database)
    if (!this.cockroachPools.has(key)) {
      const password = await this.getPassword(profile)
      const pool = new Pool({
        host: profile.host || 'localhost',
        port: profile.port || 26257,
        database,
        user: profile.username || 'root',
        password,
        ssl: profile.ssl !== false ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: (profile.connectTimeout ?? 30) * 1000,
        max: 10
      })
      this.cockroachPools.set(key, pool)
    }
    return this.cockroachPools.get(key)!
  }

  override async listDatabases(profile: DbConnectionProfile): Promise<{ name: string; description?: string }[]> {
    const pool = await this.getPool(profile)
    const result = await pool.query(`
      SELECT datname AS name
      FROM pg_database
      WHERE datistemplate = false
      ORDER BY datname
    `)
    return result.rows.map((row: { name: string }) => ({
      name: row.name
    }))
  }

  override async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const database = scope.database || this.getDefaultDatabase(profile)
    const pool = await this.getPool(profile, database)
    const objects: SchemaObject[] = []

    if (!scope.database || (scope.database && !scope.schema)) {
      const result = await pool.query(`
        SELECT schema_name as name 
        FROM information_schema.schemata 
        WHERE schema_name NOT LIKE 'pg_%' 
          AND schema_name != 'information_schema'
          AND schema_name NOT LIKE 'crdb_%'
          AND schema_name NOT LIKE '%_pg_catalog'
          AND schema_name NOT LIKE 'persistence%'
        ORDER BY schema_name
      `)
      for (const row of result.rows as Array<{ name: string }>) {
        objects.push({
          name: row.name,
          type: 'schema' as SchemaObjectType,
          description: 'Schema'
        })
      }
    } else {
      try {
        const result = await pool.query(`SHOW TABLES FROM ${quoteCockroachIdentifier(scope.schema || 'public')} WITH COMMENT`)
        for (const row of result.rows as Array<Record<string, unknown>>) {
          const name = String(row.table_name || row.name || '')
          if (!name) {
            continue
          }
          const objectType = mapCockroachObjectType(String(row.type || 'table'))
          const comment = stringOrUndefined(row.comment)
          objects.push({
            name,
            type: objectType,
            rowCount: numberOrUndefined(row.estimated_row_count),
            description: comment || String(row.type || objectType)
          })
        }
      } catch {
        const result = await pool.query(
          `SELECT table_name as name, table_type as type
           FROM information_schema.tables
           WHERE table_schema = $1
           ORDER BY table_name`,
          [scope.schema]
        )
        for (const row of result.rows as Array<{ name: string; type: string }>) {
          objects.push({
            name: row.name,
            type: mapCockroachObjectType(row.type),
            description: row.type
          })
        }
      }
    }

    return objects
  }

  override async getTableSchema(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): Promise<TableSchema> {
    const tableSchema = await super.getTableSchema(profile, tableName, scope)
    const database = scope.database || this.getDefaultDatabase(profile)
    const pool = await this.getPool(profile, database)
    const schema = scope.schema || await this.resolveCockroachTableSchema(pool, tableName)

    if (!schema) {
      return tableSchema
    }

    await this.applyCockroachComments(pool, tableSchema, tableName, schema)
    return tableSchema
  }

  private async resolveCockroachTableSchema(pool: Pool, tableName: string): Promise<string | undefined> {
    const result = await pool.query(`
      SELECT table_schema
      FROM information_schema.tables
      WHERE table_name = $1
        AND table_schema NOT LIKE 'pg_%'
        AND table_schema != 'information_schema'
        AND table_schema NOT LIKE 'crdb_%'
      ORDER BY
        CASE
          WHEN table_schema = current_schema() THEN 0
          WHEN table_schema = 'public' THEN 1
          ELSE 2
        END,
        table_schema
      LIMIT 2
    `, [tableName])

    return result.rows.length === 1
      ? String((result.rows[0] as { table_schema: string }).table_schema)
      : undefined
  }

  private async applyCockroachComments(
    pool: Pool,
    tableSchema: TableSchema,
    tableName: string,
    schema: string
  ): Promise<void> {
    try {
      const tableInfo = await this.getCockroachTableInfo(pool, tableName, schema)
      if (tableInfo.comment !== undefined) {
        tableSchema.comment = tableInfo.comment
        tableSchema.metadata = {
          ...(tableSchema.metadata || {}),
          comment: tableInfo.comment
        }
      }
      if (tableInfo.rowCount !== undefined) {
        tableSchema.metadata = {
          ...(tableSchema.metadata || {}),
          tableRows: tableInfo.rowCount
        }
      }
    } catch {
      // CockroachDB exposes comments through SHOW statements; keep base schema metadata if that fails.
    }

    try {
      const columnComments = await this.getCockroachColumnComments(pool, tableName, schema)
      tableSchema.columns = tableSchema.columns.map(column => {
        if (!columnComments.has(column.name)) {
          return column
        }
        return {
          ...column,
          comment: columnComments.get(column.name) || ''
        }
      })
    } catch {
      // Column comments are optional metadata; avoid failing schema browsing for older CockroachDB versions.
    }
  }

  private async getCockroachTableInfo(
    pool: Pool,
    tableName: string,
    schema: string
  ): Promise<{ comment?: string; rowCount?: number }> {
    const result = await pool.query(`SHOW TABLES FROM ${quoteCockroachIdentifier(schema)} WITH COMMENT`)
    const row = (result.rows as Array<Record<string, unknown>>)
      .find(item => String(item.table_name || item.name || '') === tableName)

    return {
      comment: stringOrUndefined(row?.comment),
      rowCount: numberOrUndefined(row?.estimated_row_count)
    }
  }

  private async getCockroachColumnComments(
    pool: Pool,
    tableName: string,
    schema: string
  ): Promise<Map<string, string>> {
    const qualifiedTable = `${quoteCockroachIdentifier(schema)}.${quoteCockroachIdentifier(tableName)}`
    const result = await pool.query(`SHOW COLUMNS FROM ${qualifiedTable} WITH COMMENT`)
    const comments = new Map<string, string>()

    for (const row of result.rows as Array<Record<string, unknown>>) {
      const columnName = String(row.column_name || '')
      if (columnName) {
        comments.set(columnName, stringOrUndefined(row.comment) || '')
      }
    }

    return comments
  }

  override async dispose(profileId: string): Promise<void> {
    const entries = Array.from(this.cockroachPools.entries())
      .filter(([key]) => key === profileId || key.startsWith(`${profileId}:`))

    for (const [key, pool] of entries) {
      await pool.end()
      this.cockroachPools.delete(key)
    }
  }
}

function quoteCockroachIdentifier(identifier: string): string {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function mapCockroachObjectType(type: string): SchemaObjectType {
  const normalized = type.toLowerCase()
  if (normalized.includes('materialized') && normalized.includes('view')) {
    return 'materializedView'
  }
  if (normalized.includes('view')) {
    return 'view'
  }
  return 'table'
}

function stringOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const text = String(value)
  return text.length > 0 ? text : undefined
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}
