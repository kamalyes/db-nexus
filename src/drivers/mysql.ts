import { createConnection, createPool, Pool, Connection } from 'mysql2/promise'
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
  TableSchema,
  MutationPlan,
  DataEditResult,
  DataQueryOptions
} from '@/core/types'
import { SQL_CAPABILITIES } from '@/core/constants'
import { uniqueRowsByColumns } from '@/core/mutations'
import { appendLimitIfNeeded, joinFilterClauses } from '@/core/sql'
import { DatabaseDriver } from './base'
import { SecretService } from '@/services/secretService'

export class MySQLDriver implements DatabaseDriver {
  id: DatabaseDriverId = 'mysql'
  displayName = 'MySQL'
  capabilities = SQL_CAPABILITIES

  private pools = new Map<string, Pool>()

  private async getPassword(profile: DbConnectionProfile): Promise<string> {
    try {
      const secretService = SecretService.getInstance()
      return (await secretService.getPassword(profile.id)) || ''
    } catch {
      return ''
    }
  }

  private async getPool(profile: DbConnectionProfile, database = profile.database): Promise<Pool> {
    const key = `${profile.id}:${database || ''}`
    if (!this.pools.has(key)) {
      const password = await this.getPassword(profile)
      const pool = createPool({
        host: profile.host || 'localhost',
        port: profile.port || 3306,
        database,
        user: profile.username,
        password,
        ssl: profile.ssl ? {} : undefined,
        connectTimeout: (profile.connectTimeout ?? 30) * 1000,
        connectionLimit: 5
      })
      this.pools.set(key, pool)
    }
    return this.pools.get(key)!
  }

  async testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult> {
    const start = Date.now()
    let connection: Connection | undefined
    const password = await this.getPassword(profile)

    try {
      connection = await createConnection({
        host: profile.host || 'localhost',
        port: profile.port || 3306,
        database: profile.database,
        user: profile.username,
        password,
        ssl: profile.ssl ? {} : undefined,
        connectTimeout: (profile.connectTimeout ?? 30) * 1000
      })
      await connection.query('SELECT 1')
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
    } finally {
      if (connection) await connection.end()
    }
  }

  async listDatabases(profile: DbConnectionProfile): Promise<DatabaseCatalog[]> {
    const pool = await this.getPool(profile)
    const [rows] = await pool.query('SHOW DATABASES')
    return (rows as Array<{ Database: string }>)
      .filter(row => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(row.Database))
      .map(row => ({ name: row.Database }))
  }

  async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const pool = await this.getPool(profile)
    const objects: SchemaObject[] = []

    if (!scope.database) {
      const databases = await this.listDatabases(profile)
      for (const db of databases) {
        objects.push({
          name: db.name,
          type: 'schema' as SchemaObjectType,
          description: 'Database'
        })
      }
    } else {
      const [rows] = await pool.query(
        `SELECT
           table_name as name,
           table_type as type,
           table_comment as comment,
           table_rows as row_count
         FROM information_schema.tables
         WHERE table_schema = ?
         ORDER BY table_name`,
        [scope.database]
      )
      for (const row of rows as Array<{ name: string; type: string; comment?: string; row_count?: unknown }>) {
        objects.push({
          name: row.name,
          type: row.type === 'VIEW' ? 'view' : 'table' as SchemaObjectType,
          description: row.comment || row.type,
          rowCount: numberOrUndefined(row.row_count)
        })
      }
    }

    return objects
  }

  async executeQuery(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    const start = Date.now()
    const pool = await this.getPool(profile, request.database || profile.database)

    try {
      const sql = appendLimitIfNeeded(request.sql, request.limit)

      const [rows, fields] = await pool.query(sql)

      // Handle non-SELECT results
      if (!Array.isArray(rows)) {
        return {
          columns: [{ name: 'affectedRows', type: 'INTEGER' }, { name: 'insertId', type: 'INTEGER' }],
          rows: [{ affectedRows: rows.affectedRows || 0, insertId: rows.insertId || 0 }],
          rowCount: rows.affectedRows || 0,
          elapsedMs: Date.now() - start
        }
      }

      const columns = Array.isArray(fields)
        ? fields.map(field => ({
            name: field.name,
            type: String(field.type || 'TEXT')
          }))
        : []

      return {
        columns,
        rows: rows as Record<string, unknown>[],
        rowCount: rows.length,
        elapsedMs: Date.now() - start
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  }

  async getTableData(
    profile: DbConnectionProfile,
    tableName: string,
    scope: SchemaScope,
    options?: DataQueryOptions
  ): Promise<QueryResult> {
    const start = Date.now()
    const pool = await this.getPool(profile)
    const qualifiedTable = this.getQualifiedTableName(profile, tableName, scope)

    let sql = `SELECT * FROM ${qualifiedTable}`
    let whereSql = ''

    if (options?.filters && options.filters.length > 0) {
      const whereClauses = options.filters.map(filter => {
        const column = this.quoteIdentifier(filter.column)
        if (filter.operator === 'IS NULL' || filter.operator === 'IS NOT NULL') {
          return `${column} ${filter.operator}`
        }
        if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
          const values = Array.isArray(filter.value) ? filter.value : [filter.value]
          return `${column} ${filter.operator} (${values.map(value => this.formatValue(value)).join(', ')})`
        }
        return `${column} ${filter.operator} ${this.formatValue(filter.value)}`
      })
      whereSql = ` WHERE ${joinFilterClauses(options.filters, whereClauses)}`
      sql += whereSql
    }

    if (options?.sorts && options.sorts.length > 0) {
      const orderClauses = options.sorts.map(sort =>
        `${this.quoteIdentifier(sort.column)} ${sort.direction}`
      )
      sql += ` ORDER BY ${orderClauses.join(', ')}`
    }

    const limit = options?.limit || 100
    const offset = options?.offset || 0
    sql += ` LIMIT ${limit} OFFSET ${offset}`

    const [rows, fields] = await pool.query(sql)
    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM ${qualifiedTable}${whereSql}`)

    const columns = Array.isArray(fields)
      ? fields.map(field => ({
          name: field.name,
          type: String(field.type || 'TEXT')
        }))
      : []

    const total = Array.isArray(countRows) && countRows.length > 0
      ? Number((countRows[0] as Record<string, unknown>).total || 0)
      : 0

    const resultRows = Array.isArray(rows) ? rows as Record<string, unknown>[] : []

    return {
      columns,
      rows: resultRows,
      rowCount: resultRows.length,
      elapsedMs: Date.now() - start,
      hasMore: offset + resultRows.length < total,
      totalRows: total
    }
  }

  private getQualifiedTableName(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): string {
    const database = scope.database || profile.database
    if (!database) {
      return this.quoteIdentifier(tableName)
    }
    return `${this.quoteIdentifier(database)}.${this.quoteIdentifier(tableName)}`
  }

  private quoteIdentifier(identifier: string): string {
    return `\`${String(identifier).replace(/`/g, '``')}\``
  }

  private formatValue(value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return 'NULL'
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value)
    }
    if (typeof value === 'boolean') {
      return value ? '1' : '0'
    }
    return `'${String(value).replace(/'/g, "''")}'`
  }

  async dispose(profileId: string): Promise<void> {
    const entries = Array.from(this.pools.entries())
      .filter(([key]) => key === profileId || key.startsWith(`${profileId}:`))

    for (const [key, pool] of entries) {
      await pool.end()
      this.pools.delete(key)
    }
  }

  async getTableSchema(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): Promise<TableSchema> {
    const pool = await this.getPool(profile)
    const database = scope.database || profile.database

    const [tableRows] = await pool.query(`
      SELECT
        ENGINE,
        TABLE_ROWS,
        AUTO_INCREMENT,
        ROW_FORMAT,
        CREATE_TIME,
        UPDATE_TIME,
        CHECK_TIME,
        DATA_LENGTH,
        INDEX_LENGTH,
        MAX_DATA_LENGTH,
        TABLE_COLLATION,
        TABLE_COMMENT
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      LIMIT 1
    `, [database, tableName])

    const tableInfo = Array.isArray(tableRows) && tableRows.length > 0
      ? tableRows[0] as Record<string, unknown>
      : {}

    const [versionRows] = await pool.query('SELECT VERSION() AS VERSION')
    const serverVersion = Array.isArray(versionRows) && versionRows.length > 0
      ? String((versionRows[0] as Record<string, unknown>).VERSION || '')
      : ''

    const [sessionRows] = await pool.query("SHOW STATUS LIKE 'Threads_connected'")
    const activeSessions = Array.isArray(sessionRows) && sessionRows.length > 0
      ? Number((sessionRows[0] as Record<string, unknown>).Value || 0)
      : undefined

    const [columnsRows] = await pool.query(`
      SELECT 
        c.COLUMN_NAME,
        c.COLUMN_TYPE,
        c.IS_NULLABLE,
        c.COLUMN_DEFAULT,
        c.ORDINAL_POSITION,
        c.EXTRA,
        c.COLUMN_COMMENT,
        CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY_KEY
      FROM information_schema.COLUMNS c
      LEFT JOIN (
        SELECT ku.COLUMN_NAME, ku.TABLE_NAME, ku.TABLE_SCHEMA
        FROM information_schema.TABLE_CONSTRAINTS tc
        JOIN information_schema.KEY_COLUMN_USAGE ku 
          ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME 
          AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
          AND tc.TABLE_NAME = ku.TABLE_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME 
        AND c.TABLE_NAME = pk.TABLE_NAME 
        AND c.TABLE_SCHEMA = pk.TABLE_SCHEMA
      WHERE c.TABLE_NAME = ? AND c.TABLE_SCHEMA = ?
      ORDER BY c.ORDINAL_POSITION
    `, [tableName, database])

    const columns: TableColumn[] = (columnsRows as Record<string, unknown>[]).map(row => ({
      name: String(row.COLUMN_NAME),
      type: String(row.COLUMN_TYPE),
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT ? String(row.COLUMN_DEFAULT) : null,
      isPrimaryKey: Boolean(row.IS_PRIMARY_KEY),
      isAutoIncrement: String(row.EXTRA || '').toLowerCase().includes('auto_increment'),
      comment: String(row.COLUMN_COMMENT || ''),
      position: Number(row.ORDINAL_POSITION)
    }))

    const [indexRows] = await pool.query(`
      SELECT 
        s.INDEX_NAME,
        s.COLUMN_NAME,
        s.NON_UNIQUE,
        s.INDEX_TYPE
      FROM information_schema.STATISTICS s
      WHERE s.TABLE_NAME = ? AND s.TABLE_SCHEMA = ?
      ORDER BY s.INDEX_NAME, s.SEQ_IN_INDEX
    `, [tableName, database])

    const indexMap = new Map<string, TableIndex>()
    for (const row of indexRows as Record<string, unknown>[]) {
      const name = String(row.INDEX_NAME)
      if (!indexMap.has(name)) {
        indexMap.set(name, {
          name,
          columns: [],
          isUnique: !Boolean(row.NON_UNIQUE),
          isPrimary: name === 'PRIMARY',
          type: String(row.INDEX_TYPE)
        })
      }
      indexMap.get(name)!.columns.push(String(row.COLUMN_NAME))
    }

    const [fkRows] = await pool.query(`
      SELECT 
        kcu.CONSTRAINT_NAME,
        kcu.COLUMN_NAME,
        kcu.REFERENCED_TABLE_NAME,
        kcu.REFERENCED_COLUMN_NAME,
        rc.UPDATE_RULE,
        rc.DELETE_RULE
      FROM information_schema.KEY_COLUMN_USAGE kcu
      JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
        ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
        AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
      WHERE kcu.TABLE_NAME = ? 
        AND kcu.TABLE_SCHEMA = ?
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
    `, [tableName, database])

    const fkMap = new Map<string, TableForeignKey>()
    for (const row of fkRows as Record<string, unknown>[]) {
      const name = String(row.CONSTRAINT_NAME)
      if (!fkMap.has(name)) {
        fkMap.set(name, {
          name,
          columns: [],
          referencedTable: String(row.REFERENCED_TABLE_NAME),
          referencedColumns: [],
          onUpdate: String(row.UPDATE_RULE),
          onDelete: String(row.DELETE_RULE)
        })
      }
      const fk = fkMap.get(name)!
      fk.columns.push(String(row.COLUMN_NAME))
      fk.referencedColumns.push(String(row.REFERENCED_COLUMN_NAME))
    }

    return {
      name: tableName,
      columns,
      indexes: Array.from(indexMap.values()),
      foreignKeys: Array.from(fkMap.values()),
      comment: String(tableInfo.TABLE_COMMENT || ''),
      metadata: {
        engine: stringOrUndefined(tableInfo.ENGINE),
        tableRows: numberOrUndefined(tableInfo.TABLE_ROWS),
        autoIncrement: numberOrUndefined(tableInfo.AUTO_INCREMENT),
        rowFormat: stringOrUndefined(tableInfo.ROW_FORMAT),
        createTime: stringOrUndefined(tableInfo.CREATE_TIME),
        updateTime: stringOrUndefined(tableInfo.UPDATE_TIME),
        checkTime: stringOrUndefined(tableInfo.CHECK_TIME),
        dataLength: numberOrUndefined(tableInfo.DATA_LENGTH),
        indexLength: numberOrUndefined(tableInfo.INDEX_LENGTH),
        maxDataLength: numberOrUndefined(tableInfo.MAX_DATA_LENGTH),
        tableCollation: stringOrUndefined(tableInfo.TABLE_COLLATION),
        charset: getCharsetFromCollation(stringOrUndefined(tableInfo.TABLE_COLLATION)),
        serverVersion,
        activeSessions
      }
    }
  }

  async planInsert(
    profile: DbConnectionProfile,
    table: string,
    row: Record<string, unknown>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    const qualifiedTable = this.getQualifiedTableName(profile, table, scope)

    const rowColumns = Object.keys(row)
    const columns = rowColumns.map(c => this.quoteIdentifier(c)).join(', ')
    const params = rowColumns.map(() => '?').join(', ')
    const sql = rowColumns.length === 0
      ? `INSERT INTO ${qualifiedTable} () VALUES ()`
      : `INSERT INTO ${qualifiedTable} (${columns}) VALUES (${params})`

    return {
      table,
      database: scope.database || profile.database,
      type: 'insert',
      sql,
      parameters: Object.values(row),
      description: `Insert new row into ${qualifiedTable}`
    }
  }

  async planUpdate(
    profile: DbConnectionProfile,
    table: string,
    row: Record<string, unknown>,
    originalRow: Record<string, unknown>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    const qualifiedTable = this.getQualifiedTableName(profile, table, scope)

    const tableSchema = await this.getTableSchema!(profile, table, scope)
    const primaryKeyColumns = tableSchema.columns.filter(c => c.isPrimaryKey).map(c => c.name)

    if (primaryKeyColumns.length === 0) {
      throw new Error('Cannot update table without primary key')
    }

    const setColumns = Object.keys(row)
    const setClauses = setColumns
      .map(k => `\`${k}\` = ?`)
      .join(', ')

    const whereClauses = primaryKeyColumns.map(k => `\`${k}\` = ?`).join(' AND ')
    const sql = `UPDATE ${qualifiedTable} SET ${setClauses} WHERE ${whereClauses}`

    return {
      table,
      database: scope.database || profile.database,
      type: 'update',
      sql,
      parameters: [
        ...setColumns.map(column => row[column]),
        ...primaryKeyColumns.map(column => originalRow[column])
      ],
      description: `Update row in ${qualifiedTable}`
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
    const qualifiedTable = this.getQualifiedTableName(profile, table, scope)

    const tableSchema = await this.getTableSchema!(profile, table, scope)
    const primaryKeyColumns = tableSchema.columns.filter(c => c.isPrimaryKey).map(c => c.name)

    if (primaryKeyColumns.length === 0) {
      throw new Error('Cannot delete from table without primary key')
    }

    const deleteRows = uniqueRowsByColumns(rows, primaryKeyColumns)
    const parameters: unknown[] = []
    const whereClauses = primaryKeyColumns.length === 1
      ? `${this.quoteIdentifier(primaryKeyColumns[0])} IN (${deleteRows.map(row => {
          parameters.push(row[primaryKeyColumns[0]])
          return '?'
        }).join(', ')})`
      : deleteRows.map(row => `(${primaryKeyColumns.map(column => {
          parameters.push(row[column])
          return `${this.quoteIdentifier(column)} = ?`
        }).join(' AND ')})`).join(' OR ')
    const sql = `DELETE FROM ${qualifiedTable} WHERE ${whereClauses}`

    return {
      table,
      database: scope.database || profile.database,
      type: 'delete',
      sql,
      parameters,
      expectedAffectedRows: deleteRows.length,
      description: `Delete ${deleteRows.length} row(s) from ${qualifiedTable}`
    }
  }

  async executeMutation(
    profile: DbConnectionProfile,
    plan: MutationPlan
  ): Promise<DataEditResult> {
    const pool = await this.getPool(profile)
    const values = plan.parameters || []

    try {
      const [result] = await pool.query(plan.sql, values)
      const affectedRows = (result as any).affectedRows || 0
      return {
        success: true,
        sqlPreview: plan.sql,
        affectedRows,
        message: `${affectedRows} rows ${plan.type}ed`
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

  async getDDL(
    profile: DbConnectionProfile,
    objectName: string,
    objectType: 'table' | 'view' | 'index' | 'trigger' | 'procedure' | 'function',
    scope: SchemaScope
  ): Promise<string> {
    const pool = await this.getPool(profile)
    const database = scope.database || profile.database

    switch (objectType) {
      case 'table': {
        const [result] = await pool.query(`SHOW CREATE TABLE \`${database}\`.\`${objectName}\``)
        const rows = result as { 'Create Table': string }[]
        if (rows.length === 0) {
          throw new Error(`Table ${database}.${objectName} not found`)
        }
        return rows[0]['Create Table']
      }
      
      case 'view': {
        const [result] = await pool.query(`SHOW CREATE VIEW \`${database}\`.\`${objectName}\``)
        const rows = result as { 'Create View': string }[]
        if (rows.length === 0) {
          throw new Error(`View ${database}.${objectName} not found`)
        }
        return rows[0]['Create View']
      }
      
      case 'index': {
        const [result] = await pool.query(`
          SELECT INDEX_NAME, TABLE_NAME, NON_UNIQUE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS COLUMNS
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND INDEX_NAME = ?
          GROUP BY INDEX_NAME, TABLE_NAME, NON_UNIQUE
        `, [database, objectName])
        const rows = result as { INDEX_NAME: string; TABLE_NAME: string; NON_UNIQUE: number; COLUMNS: string }[]
        if (rows.length === 0) {
          throw new Error(`Index ${objectName} not found`)
        }
        const row = rows[0]
        const unique = row.NON_UNIQUE === 0 ? 'UNIQUE ' : ''
        return `CREATE ${unique}INDEX \`${row.INDEX_NAME}\` ON \`${database}\`.\`${row.TABLE_NAME}\` (${row.COLUMNS.split(',').map(c => `\`${c}\``).join(', ')})`
      }
      
      case 'procedure': {
        const [result] = await pool.query(`SHOW CREATE PROCEDURE \`${database}\`.\`${objectName}\``)
        const rows = result as { 'Create Procedure': string }[]
        if (rows.length === 0) {
          throw new Error(`Procedure ${database}.${objectName} not found`)
        }
        return rows[0]['Create Procedure']
      }
      
      case 'function': {
        const [result] = await pool.query(`SHOW CREATE FUNCTION \`${database}\`.\`${objectName}\``)
        const rows = result as { 'Create Function': string }[]
        if (rows.length === 0) {
          throw new Error(`Function ${database}.${objectName} not found`)
        }
        return rows[0]['Create Function']
      }
      
      case 'trigger': {
        const [result] = await pool.query(`SHOW CREATE TRIGGER \`${database}\`.\`${objectName}\``)
        const rows = result as { 'SQL Original Statement': string }[]
        if (rows.length === 0) {
          throw new Error(`Trigger ${database}.${objectName} not found`)
        }
        return rows[0]['SQL Original Statement']
      }
      
      default:
        throw new Error(`Unsupported object type: ${objectType}`)
    }
  }
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

function getCharsetFromCollation(collation?: string): string | undefined {
  if (!collation) {
    return undefined
  }

  return collation.split('_')[0] || undefined
}
