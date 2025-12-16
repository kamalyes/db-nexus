export type DatabaseFamily = 'sql' | 'document' | 'keyValue' | 'graph' | 'search' | 'warehouse' | 'file'

export type DatabaseDriverId =
  | 'postgresql'
  | 'mysql'
  | 'mariadb'
  | 'sqlite'
  | 'sqlserver'
  | 'oracle'
  | 'mongodb'
  | 'redis'
  | 'duckdb'
  | 'snowflake'
  | 'bigquery'
  | 'databricks'
  | 'clickhouse'
  | 'cassandra'
  | 'elasticsearch'
  | 'neo4j'
  | 'firebase'
  | 'dynamodb'
  | 'cockroachdb'
  | 'csv'
  | 'excel'
  | 'json'
  | 'parquet'
  | 'avro'

export interface DriverCapabilities {
  schemaBrowse: boolean
  query: boolean
  dataEdit: boolean
  transactions: boolean
  explain: boolean
  erd: boolean
  importExport: boolean
  backupRestore: boolean
  streaming: boolean
}

export interface DriverDefinition {
  id: DatabaseDriverId
  displayName: string
  family: DatabaseFamily
  defaultPort?: number
  implemented: boolean
  capabilities: DriverCapabilities
}

export interface DbConnectionProfile {
  id: string
  name: string
  driverId: DatabaseDriverId
  host?: string
  port?: number
  database?: string
  username?: string
  filePath?: string
  ssl?: boolean
  createdAt: string
  updatedAt: string
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

export interface DatabaseCatalog {
  name: string
  description?: string
}

export interface SchemaScope {
  database?: string
  schema?: string
  parentName?: string
}

export type SchemaObjectType =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'materializedView'
  | 'procedure'
  | 'function'
  | 'index'
  | 'collection'
  | 'keyspace'
  | 'bucket'
  | 'file'

export interface SchemaObject {
  name: string
  type: SchemaObjectType
  scope?: SchemaScope
  rowCount?: number
  description?: string
  hasChildren?: boolean
}

export interface DataFilter {
  column: string
  operator: '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'NOT LIKE' | 'IS NULL' | 'IS NOT NULL' | 'IN' | 'NOT IN'
  value?: unknown
}

export interface DataSort {
  column: string
  direction: 'ASC' | 'DESC'
}

export interface DataQueryOptions {
  filters?: DataFilter[]
  sorts?: DataSort[]
  offset?: number
  limit?: number
}

export interface QueryRequest {
  sql: string
  database?: string
  schema?: string
  limit?: number
  parameters?: Record<string, unknown>
}

export interface QueryColumn {
  name: string
  type?: string
  nullable?: boolean
}

export interface QueryResult {
  columns: QueryColumn[]
  rows: Record<string, unknown>[]
  rowCount: number
  elapsedMs: number
  notices?: string[]
  hasMore?: boolean
  totalRows?: number
}

export interface TableColumn {
  name: string
  type: string
  nullable: boolean
  defaultValue?: string | null
  isPrimaryKey: boolean
  isAutoIncrement: boolean
  comment?: string
  position: number
}

export interface TableIndex {
  name: string
  columns: string[]
  isUnique: boolean
  isPrimary: boolean
  type?: string
}

export interface TableForeignKey {
  name: string
  columns: string[]
  referencedTable: string
  referencedColumns: string[]
  onUpdate?: string
  onDelete?: string
}

export interface TableSchema {
  name: string
  columns: TableColumn[]
  indexes: TableIndex[]
  foreignKeys: TableForeignKey[]
  comment?: string
  metadata?: Record<string, string | number | boolean | null | undefined>
}

export interface RowChange {
  type: 'insert' | 'update' | 'delete'
  table: string
  schema?: string
  row: Record<string, unknown>
  originalRow?: Record<string, unknown>
}

export interface DataEditResult {
  success: boolean
  sqlPreview?: string
  affectedRows: number
  message?: string
  error?: string
}

export interface MutationPlan {
  table: string
  schema?: string
  type: 'insert' | 'update' | 'delete'
  sql: string
  description: string
}

export interface ExecutionPlan {
  nodes: ExecutionPlanNode[]
  totalCost?: number
  totalRows?: number
  executionTime?: number
}

export interface ExecutionPlanNode {
  id: string
  type: string
  name: string
  cost?: number
  rows?: number
  width?: number
  actualTime?: number
  actualRows?: number
  actualLoops?: number
  children?: ExecutionPlanNode[]
  details?: Record<string, unknown>
}
