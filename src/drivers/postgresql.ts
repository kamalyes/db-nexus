import { Client, Pool } from 'pg'
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
  DataQueryOptions,
  ExecutionPlan,
  ExecutionPlanNode
} from '@/core/types'
import { SQL_CAPABILITIES } from '@/core/constants'
import { DatabaseDriver } from './base'
import { SecretService } from '@/services/secretService'

export class PostgreSQLDriver implements DatabaseDriver {
  id: DatabaseDriverId = 'postgresql'
  displayName = 'PostgreSQL'
  capabilities = SQL_CAPABILITIES

  private pools = new Map<string, Pool>()

  protected async getPassword(profile: DbConnectionProfile): Promise<string> {
    try {
      const secretService = SecretService.getInstance()
      return (await secretService.getPassword(profile.id)) || ''
    } catch {
      return ''
    }
  }

  protected getDefaultDatabase(profile: DbConnectionProfile): string {
    return profile.database || 'postgres'
  }

  protected getPoolKey(profile: DbConnectionProfile, database: string): string {
    return `${profile.id}:${database}`
  }

  protected async getPool(profile: DbConnectionProfile, database = this.getDefaultDatabase(profile)): Promise<Pool> {
    const key = this.getPoolKey(profile, database)
    if (!this.pools.has(key)) {
      const password = await this.getPassword(profile)
      const pool = new Pool({
        host: profile.host || 'localhost',
        port: profile.port || 5432,
        database,
        user: profile.username,
        password,
        ssl: profile.ssl ? { rejectUnauthorized: false } : false
      })
      this.pools.set(key, pool)
    }
    return this.pools.get(key)!
  }

  async testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult> {
    const start = Date.now()
    const password = await this.getPassword(profile)
    const client = new Client({
      host: profile.host || 'localhost',
      port: profile.port || 5432,
      database: this.getDefaultDatabase(profile),
      user: profile.username,
      password,
      ssl: profile.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 5000
    })

    try {
      await client.connect()
      await client.query('SELECT 1')
      await client.end()
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
    const pool = await this.getPool(profile)
    const result = await pool.query(
      "SELECT datname as name, pg_catalog.shobj_description(oid, 'pg_database') as description FROM pg_database WHERE datistemplate = false ORDER BY datname"
    )
    return result.rows.map((row: { name: string; description?: string }) => ({
      name: row.name,
      description: row.description
    }))
  }

  async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const database = scope.database || this.getDefaultDatabase(profile)
    const pool = await this.getPool(profile, database)
    const objects: SchemaObject[] = []

    if (!scope.database || (scope.database && !scope.schema)) {
      const result = await pool.query(
        "SELECT schema_name as name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema' ORDER BY schema_name"
      )
      for (const row of result.rows as Array<{ name: string }>) {
        objects.push({
          name: row.name,
          type: 'schema' as SchemaObjectType,
          description: 'Schema'
        })
      }
    } else {
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
          type: row.type === 'VIEW' ? 'view' : 'table' as SchemaObjectType,
          description: row.type
        })
      }
    }

    return objects
  }

  async executeQuery(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    const start = Date.now()
    const pool = await this.getPool(profile, request.database || this.getDefaultDatabase(profile))

    try {
      const sql = request.limit
        ? `${request.sql} LIMIT ${request.limit}`
        : request.sql

      const result = await pool.query(sql)

      const columns = result.fields.map((field: { name: string; dataTypeID: number }) => ({
        name: field.name,
        type: field.dataTypeID.toString()
      }))

      return {
        columns,
        rows: result.rows,
        rowCount: result.rowCount || 0,
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
    const pool = await this.getPool(profile, scope.database || this.getDefaultDatabase(profile))
    const schema = scope.schema || 'public'
    const qualifiedTable = `${schema}.${tableName}`

    let sql = `SELECT * FROM ${qualifiedTable}`

    if (options?.filters && options.filters.length > 0) {
      const whereClauses = options.filters.map(f => {
        if (f.operator === 'IS NULL') {
          return `${f.column} IS NULL`
        }
        if (f.operator === 'IS NOT NULL') {
          return `${f.column} IS NOT NULL`
        }
        if (f.operator === 'IN' || f.operator === 'NOT IN') {
          const values = Array.isArray(f.value) ? f.value : [f.value]
          const placeholders = values.map(() => '?').join(', ')
          return `${f.column} ${f.operator} (${placeholders})`
        }
        return `${f.column} ${f.operator} '${f.value}'`
      })
      sql += ` WHERE ${whereClauses.join(' AND ')}`
    }

    if (options?.sorts && options.sorts.length > 0) {
      const orderClauses = options.sorts.map(s => `${s.column} ${s.direction}`)
      sql += ` ORDER BY ${orderClauses.join(', ')}`
    }

    const limit = options?.limit || 100
    const offset = options?.offset || 0
    sql += ` LIMIT ${limit} OFFSET ${offset}`

    const result = await pool.query(sql)

    const columns = result.fields.map((field: { name: string; dataTypeID: number }) => ({
      name: field.name,
      type: field.dataTypeID.toString()
    }))

    const countResult = await pool.query(`SELECT COUNT(*) as total FROM ${qualifiedTable}`)
    const totalRows = Number((countResult.rows[0] as { total: string }).total)

    return {
      columns,
      rows: result.rows,
      rowCount: result.rowCount || 0,
      elapsedMs: Date.now() - start,
      hasMore: offset + result.rows.length < totalRows,
      totalRows
    }
  }

  async getExecutionPlan(
    profile: DbConnectionProfile,
    sql: string,
    scope: SchemaScope
  ): Promise<ExecutionPlan> {
    const pool = await this.getPool(profile, scope.database || this.getDefaultDatabase(profile))

    const result = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`)
    const planData = result.rows[0] as { 'QUERY PLAN': unknown[] }

    const parseNode = (node: Record<string, unknown>, id: string): ExecutionPlanNode => {
      const children: ExecutionPlanNode[] = []
      const plans = node.Plans as Record<string, unknown>[] | undefined
      if (plans) {
        plans.forEach((child, i) => {
          children.push(parseNode(child, `${id}-${i}`))
        })
      }

      return {
        id,
        type: String(node['Node Type'] || 'Unknown'),
        name: String(node['Node Type'] || 'Unknown'),
        cost: node['Total Cost'] as number | undefined,
        rows: node['Plan Rows'] as number | undefined,
        width: node['Plan Width'] as number | undefined,
        actualTime: node['Actual Total Time'] as number | undefined,
        actualRows: node['Actual Rows'] as number | undefined,
        actualLoops: node['Actual Loops'] as number | undefined,
        children: children.length > 0 ? children : undefined,
        details: node
      }
    }

    const rootPlan = (planData['QUERY PLAN'] as Record<string, unknown>[])[0] as Record<string, unknown>
    const rootNode = parseNode(rootPlan, '0')

    return {
      nodes: [rootNode],
      totalCost: rootNode.cost,
      totalRows: rootNode.rows,
      executionTime: rootNode.actualTime
    }
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
    const pool = await this.getPool(profile, scope.database || this.getDefaultDatabase(profile))
    const schema = scope.schema || 'public'
    const metadata: TableSchema['metadata'] = {}

    try {
      const tableInfoResult = await pool.query(`
        SELECT
          c.reltuples::bigint AS table_rows,
          c.relpersistence,
          c.relkind,
          pg_get_userbyid(c.relowner) AS owner,
          obj_description(c.oid, 'pg_class') AS comment,
          pg_relation_size(c.oid) AS data_length,
          pg_indexes_size(c.oid) AS index_length,
          pg_total_relation_size(c.oid) AS total_length
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = $1 AND n.nspname = $2
        LIMIT 1
      `, [tableName, schema])

      const tableInfo = tableInfoResult.rows[0] as Record<string, unknown> | undefined
      if (tableInfo) {
        metadata.tableRows = numberOrUndefined(tableInfo.table_rows)
        metadata.rowFormat = stringOrUndefined(tableInfo.relpersistence)
        metadata.objectKind = stringOrUndefined(tableInfo.relkind)
        metadata.owner = stringOrUndefined(tableInfo.owner)
        metadata.dataLength = numberOrUndefined(tableInfo.data_length)
        metadata.indexLength = numberOrUndefined(tableInfo.index_length)
        metadata.totalLength = numberOrUndefined(tableInfo.total_length)
        metadata.comment = stringOrUndefined(tableInfo.comment)
      }
    } catch {
      // Optional pg_catalog metadata is best-effort; schema browsing should still work without it.
    }

    try {
      const versionResult = await pool.query('SHOW server_version')
      metadata.serverVersion = stringOrUndefined(versionResult.rows[0]?.server_version)
    } catch {
      // Ignore optional server metadata failures.
    }

    try {
      const databaseResult = await pool.query(`
        SELECT
          d.datname,
          pg_encoding_to_char(d.encoding) AS charset,
          d.datcollate AS collation,
          s.numbackends AS active_sessions
        FROM pg_database d
        LEFT JOIN pg_stat_database s ON s.datid = d.oid
        WHERE d.datname = current_database()
        LIMIT 1
      `)
      const databaseInfo = databaseResult.rows[0] as Record<string, unknown> | undefined
      if (databaseInfo) {
        metadata.databaseName = stringOrUndefined(databaseInfo.datname)
        metadata.charset = stringOrUndefined(databaseInfo.charset)
        metadata.tableCollation = stringOrUndefined(databaseInfo.collation)
        metadata.activeSessions = numberOrUndefined(databaseInfo.active_sessions)
      }
    } catch {
      // Ignore optional database metadata failures.
    }

    const columnsResult = await pool.query(`
      SELECT 
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        c.ordinal_position,
        COALESCE(pkc.column_name IS NOT NULL, false) as is_primary_key,
        COALESCE(c.column_default LIKE 'nextval%', false) as is_auto_increment,
        COALESCE(pgd.description, '') as comment
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.column_name, kcu.table_name, kcu.table_schema
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu 
          ON tc.constraint_name = kcu.constraint_name 
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pkc ON c.column_name = pkc.column_name 
        AND c.table_name = pkc.table_name 
        AND c.table_schema = pkc.table_schema
      LEFT JOIN pg_catalog.pg_statio_all_tables psat 
        ON psat.schemaname = c.table_schema AND psat.relname = c.table_name
      LEFT JOIN pg_catalog.pg_description pgd 
        ON pgd.objoid = psat.relid AND pgd.objsubid = c.ordinal_position
      WHERE c.table_name = $1 AND c.table_schema = $2
      ORDER BY c.ordinal_position
    `, [tableName, schema])

    const columns: TableColumn[] = columnsResult.rows.map((row: Record<string, unknown>) => ({
      name: String(row.column_name),
      type: String(row.data_type),
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default ? String(row.column_default) : null,
      isPrimaryKey: Boolean(row.is_primary_key),
      isAutoIncrement: Boolean(row.is_auto_increment),
      comment: String(row.comment || ''),
      position: Number(row.ordinal_position)
    }))

    const indexesResult = await pool.query(`
      SELECT 
        i.relname as index_name,
        array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns,
        ix.indisunique as is_unique,
        ix.indisprimary as is_primary
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE t.relname = $1 AND n.nspname = $2
      GROUP BY i.relname, ix.indisunique, ix.indisprimary
    `, [tableName, schema])

    const indexes: TableIndex[] = indexesResult.rows.map((row: Record<string, unknown>) => {
      let columns = row.columns
      if (typeof columns === 'string') {
        columns = columns.replace(/^\{|\}$/g, '').split(',').filter(c => c)
      }
      return {
        name: String(row.index_name),
        columns: Array.isArray(columns) ? columns.map(String) : [String(columns)],
        isUnique: Boolean(row.is_unique),
        isPrimary: Boolean(row.is_primary)
      }
    })

    const fkResult = await pool.query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.update_rule,
        rc.delete_rule
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = $1
        AND tc.table_schema = $2
    `, [tableName, schema])

    const fkMap = new Map<string, TableForeignKey>()
    for (const row of fkResult.rows as Record<string, unknown>[]) {
      const name = String(row.constraint_name)
      if (!fkMap.has(name)) {
        fkMap.set(name, {
          name,
          columns: [],
          referencedTable: String(row.foreign_table_name),
          referencedColumns: [],
          onUpdate: String(row.update_rule),
          onDelete: String(row.delete_rule)
        })
      }
      const fk = fkMap.get(name)!
      fk.columns.push(String(row.column_name))
      fk.referencedColumns.push(String(row.foreign_column_name))
    }

    return {
      name: tableName,
      columns,
      indexes,
      foreignKeys: Array.from(fkMap.values()),
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
    const database = scope.database || this.getDefaultDatabase(profile)
    const schema = scope.schema || 'public'
    const qualifiedTable = `${schema}.${table}`

    const columns = Object.keys(row).join(', ')
    const params = Object.keys(row).map((_, i) => `$${i + 1}`).join(', ')
    const sql = `INSERT INTO ${qualifiedTable} (${columns}) VALUES (${params})`

    return {
      table,
      database,
      schema,
      type: 'insert',
      sql,
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
    const database = scope.database || this.getDefaultDatabase(profile)
    const schema = scope.schema || 'public'
    const qualifiedTable = `${schema}.${table}`

    const tableSchema = await this.getTableSchema!(profile, table, scope)
    const primaryKeyColumns = tableSchema.columns.filter(c => c.isPrimaryKey).map(c => c.name)

    if (primaryKeyColumns.length === 0) {
      throw new Error('Cannot update table without primary key')
    }

    const setClauses = Object.keys(row)
      .filter(k => !primaryKeyColumns.includes(k))
      .map((k, i) => `${k} = $${i + 1}`)
      .join(', ')

    const whereClauses = primaryKeyColumns.map((k, i) => `${k} = $${Object.keys(row).filter(c => !primaryKeyColumns.includes(c)).length + i + 1}`).join(' AND ')

    const sql = `UPDATE ${qualifiedTable} SET ${setClauses} WHERE ${whereClauses}`

    return {
      table,
      database,
      schema,
      type: 'update',
      sql,
      description: `Update row in ${qualifiedTable}`
    }
  }

  async planDelete(
    profile: DbConnectionProfile,
    table: string,
    row: Record<string, unknown>,
    scope: SchemaScope
  ): Promise<MutationPlan> {
    const database = scope.database || this.getDefaultDatabase(profile)
    const schema = scope.schema || 'public'
    const qualifiedTable = `${schema}.${table}`

    const tableSchema = await this.getTableSchema!(profile, table, scope)
    const primaryKeyColumns = tableSchema.columns.filter(c => c.isPrimaryKey).map(c => c.name)

    if (primaryKeyColumns.length === 0) {
      throw new Error('Cannot delete from table without primary key')
    }

    const whereClauses = primaryKeyColumns.map((k, i) => `${k} = $${i + 1}`).join(' AND ')
    const sql = `DELETE FROM ${qualifiedTable} WHERE ${whereClauses}`

    return {
      table,
      database,
      schema,
      type: 'delete',
      sql,
      description: `Delete row from ${qualifiedTable}`
    }
  }

  async executeMutation(
    profile: DbConnectionProfile,
    plan: MutationPlan
  ): Promise<DataEditResult> {
    const pool = await this.getPool(profile, plan.database || this.getDefaultDatabase(profile))
    const values = Object.values({
      ...plan,
      table: undefined,
      database: undefined,
      schema: undefined,
      type: undefined,
      sql: undefined,
      description: undefined
    })

    try {
      const result = await pool.query(plan.sql, values)
      return {
        success: true,
        sqlPreview: plan.sql,
        affectedRows: result.rowCount || 0,
        message: `${result.rowCount} rows ${plan.type}ed`
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
    const pool = await this.getPool(profile, scope.database || this.getDefaultDatabase(profile))
    const schema = scope.schema || 'public'

    switch (objectType) {
      case 'table': {
        const result = await pool.query(`
          SELECT 
            'CREATE TABLE ' || quote_ident($2) || '.' || quote_ident($1) || ' (' || E'\n' ||
            array_to_string(
              ARRAY(
                SELECT '  ' || quote_ident(column_name) || ' ' || data_type ||
                  CASE 
                    WHEN character_maximum_length IS NOT NULL 
                    THEN '(' || character_maximum_length || ')'
                    ELSE ''
                  END ||
                  CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END ||
                  CASE WHEN column_default IS NOT NULL THEN ' DEFAULT ' || column_default ELSE '' END
                FROM information_schema.columns
                WHERE table_name = $1 AND table_schema = $2
                ORDER BY ordinal_position
              ),
              ',' || E'\n'
            ) || E'\n);' as ddl
        `, [objectName, schema])
        
        if (result.rows.length === 0) {
          throw new Error(`Table ${schema}.${objectName} not found`)
        }
        
        let ddl = (result.rows[0] as { ddl: string }).ddl
        
        const pkResult = await pool.query(`
          SELECT 
            tc.constraint_name,
            array_agg(kcu.column_name ORDER BY kcu.ordinal_position) as columns
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = $1
            AND tc.table_schema = $2
          GROUP BY tc.constraint_name
        `, [objectName, schema])
        
        for (const row of pkResult.rows as { constraint_name: string; columns: string[] }[]) {
          ddl += `\n\nALTER TABLE ${schema}.${objectName} ADD CONSTRAINT ${row.constraint_name} PRIMARY KEY (${row.columns.map(c => `"${c}"`).join(', ')});`
        }
        
        return ddl
      }
      
      case 'view': {
        const result = await pool.query(`
          SELECT definition
          FROM pg_views
          WHERE viewname = $1 AND schemaname = $2
        `, [objectName, schema])
        
        if (result.rows.length === 0) {
          throw new Error(`View ${schema}.${objectName} not found`)
        }
        
        const definition = (result.rows[0] as { definition: string }).definition
        return `CREATE OR REPLACE VIEW ${schema}.${objectName} AS\n${definition}`
      }
      
      case 'index': {
        const result = await pool.query(`
          SELECT 
            indexdef
          FROM pg_indexes
          WHERE indexname = $1 AND schemaname = $2
        `, [objectName, schema])
        
        if (result.rows.length === 0) {
          throw new Error(`Index ${objectName} not found`)
        }
        
        return (result.rows[0] as { indexdef: string }).indexdef
      }
      
      case 'function':
      case 'procedure': {
        const result = await pool.query(`
          SELECT pg_get_functiondef(oid) as definition
          FROM pg_proc
          WHERE proname = $1 AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)
        `, [objectName, schema])
        
        if (result.rows.length === 0) {
          throw new Error(`${objectType} ${schema}.${objectName} not found`)
        }
        
        return (result.rows[0] as { definition: string }).definition
      }
      
      case 'trigger': {
        const result = await pool.query(`
          SELECT pg_get_triggerdef(oid, true) as definition
          FROM pg_trigger
          WHERE tgname = $1
        `, [objectName])
        
        if (result.rows.length === 0) {
          throw new Error(`Trigger ${objectName} not found`)
        }
        
        return (result.rows[0] as { definition: string }).definition
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
