import {
  ConnectionTestResult,
  DatabaseCatalog,
  DatabaseDriverId,
  DbConnectionProfile,
  DriverCapabilities,
  QueryRequest,
  QueryResult,
  SchemaObject,
  SchemaScope,
  TableSchema,
  RowChange,
  DataEditResult,
  MutationPlan,
  DataQueryOptions,
  ExecutionPlan
} from '@/core/types'
import { t } from '@/i18n'

export interface DatabaseDriver {
  id: DatabaseDriverId
  displayName: string
  capabilities: DriverCapabilities

  testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult>
  listDatabases(profile: DbConnectionProfile): Promise<DatabaseCatalog[]>
  listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]>
  executeQuery(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult>
  getTableSchema?(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): Promise<TableSchema>
  getTableData?(profile: DbConnectionProfile, tableName: string, scope: SchemaScope, options?: DataQueryOptions): Promise<QueryResult>
  getDDL?(profile: DbConnectionProfile, objectName: string, objectType: 'table' | 'view' | 'index' | 'trigger' | 'procedure' | 'function', scope: SchemaScope): Promise<string>
  planInsert?(profile: DbConnectionProfile, table: string, row: Record<string, unknown>, scope: SchemaScope): Promise<MutationPlan>
  planUpdate?(profile: DbConnectionProfile, table: string, row: Record<string, unknown>, originalRow: Record<string, unknown>, scope: SchemaScope): Promise<MutationPlan>
  planDelete?(profile: DbConnectionProfile, table: string, row: Record<string, unknown>, scope: SchemaScope): Promise<MutationPlan>
  executeMutation?(profile: DbConnectionProfile, plan: MutationPlan): Promise<DataEditResult>
  getExecutionPlan?(profile: DbConnectionProfile, sql: string, scope: SchemaScope): Promise<ExecutionPlan>
  dispose?(profileId: string): Promise<void>
}

export class PlannedDriver implements DatabaseDriver {
  constructor(
    public readonly id: DatabaseDriverId,
    public readonly displayName: string,
    public readonly capabilities: DriverCapabilities
  ) {}

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      ok: false,
      message: t('driver.plannedMessage', this.displayName)
    }
  }

  async listDatabases(): Promise<DatabaseCatalog[]> {
    return []
  }

  async listObjects(): Promise<SchemaObject[]> {
    return []
  }

  async executeQuery(): Promise<QueryResult> {
    throw new Error(`${this.displayName} driver is not implemented yet.`)
  }
}
