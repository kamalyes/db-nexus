import * as path from 'path'
import {
  CancellationToken,
  Event,
  EventEmitter,
  ProviderResult,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  Uri,
} from 'vscode'
import {
  DbConnectionProfile,
  DatabaseDriverId,
  SchemaObject,
  SchemaScope,
  TableColumn,
  TableForeignKey,
  TableIndex,
  TableSchema
} from '@/core/types'
import { t } from '@/i18n'
import { ConnectionService } from '@/services/connectionService'
import { connectionStatusManager, ConnectionStatusType } from '@/services/connectionStatusManager'

type ConnectionTreeNode =
  | ConnectionNode
  | SchemaNode
  | TablesGroupNode
  | TableDetailGroupNode
  | FieldNode
  | IndexNode
  | ForeignKeyNode
  | PlaceholderNode
  | LoadingNode

export type TableDetailGroupKind = 'columns' | 'indexes' | 'foreignKeys' | 'checks' | 'triggers'

export class ConnectionNode {
  constructor(
    public readonly profile: DbConnectionProfile,
    public readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.Collapsed
  ) {}
}

export class SchemaNode {
  constructor(
    public readonly connectionProfile: DbConnectionProfile,
    public readonly schemaObject: SchemaObject,
    public readonly collapsibleState: TreeItemCollapsibleState,
    public readonly scope: SchemaScope = {}
  ) {}
}

export class TablesGroupNode {
  constructor(
    public readonly connectionProfile: DbConnectionProfile,
    public readonly scope: SchemaScope,
    public readonly tableCount?: number
  ) {}
}

export class TableDetailGroupNode {
  constructor(
    public readonly connectionProfile: DbConnectionProfile,
    public readonly tableName: string,
    public readonly kind: TableDetailGroupKind,
    public readonly scope: SchemaScope,
    public readonly count?: number
  ) {}
}

export class FieldNode {
  constructor(
    public readonly connectionProfile: DbConnectionProfile,
    public readonly tableName: string,
    public readonly column: TableColumn,
    public readonly indexes: TableIndex[],
    public readonly foreignKeys: TableForeignKey[],
    public readonly scope: SchemaScope = {}
  ) {}

  isForeignKey(): boolean {
    return this.foreignKeys.some(fk => 
      fk.columns.includes(this.column.name)
    )
  }

  isUnique(): boolean {
    return this.indexes.some(idx => 
      idx.isUnique && !idx.isPrimary && idx.columns.includes(this.column.name)
    )
  }

  getConstraintType(): 'primary' | 'foreign' | 'unique' | 'notnull' | 'null' {
    if (this.column.isPrimaryKey) {
      return 'primary'
    }
    if (this.isForeignKey()) {
      return 'foreign'
    }
    if (this.isUnique()) {
      return 'unique'
    }
    if (!this.column.nullable) {
      return 'notnull'
    }
    return 'null'
  }
}

class IndexNode {
  constructor(
    public readonly index: TableIndex
  ) {}
}

class ForeignKeyNode {
  constructor(
    public readonly foreignKey: TableForeignKey
  ) {}
}

class PlaceholderNode {
  constructor(public readonly label: string) {}
}

class LoadingNode {
  constructor(public readonly label: string = t('connection.loading')) {}
}

const DRIVER_ICONS: Record<string, string> = {
  postgresql: 'postgresql.svg',
  mysql: 'mysql.svg',
  mariadb: 'mariadb.svg',
  sqlite: 'sqlite.svg',
  duckdb: 'duckdb.svg',
  clickhouse: 'clickhouse.svg',
  cockroachdb: 'cockroachdb.svg',
  mongodb: 'mongodb.svg',
  redis: 'redis.svg',
  sqlserver: 'sqlserver.svg',
  oracle: 'oracle.svg',
  snowflake: 'snowflake.svg',
  bigquery: 'bigquery.svg',
  databricks: 'databricks.svg',
  cassandra: 'cassandra.svg',
  elasticsearch: 'elasticsearch.svg',
  neo4j: 'neo4j.svg',
  firebase: 'firebase.svg',
  dynamodb: 'dynamodb.svg',
  csv: 'csv.svg',
  excel: 'excel.svg',
  json: 'json.svg',
  parquet: 'parquet.svg',
  avro: 'avro.svg'
}

export class ConnectionsTreeProvider implements TreeDataProvider<ConnectionTreeNode> {
  private readonly onDidChangeTreeDataEmitter = new EventEmitter<ConnectionTreeNode | undefined>()
  readonly onDidChangeTreeData: Event<ConnectionTreeNode | undefined> = this.onDidChangeTreeDataEmitter.event
  private readonly tableSchemaCache = new Map<string, Promise<TableSchema>>()

  constructor(
    private readonly connectionService: ConnectionService,
    private readonly extensionPath: string
  ) {
    connectionStatusManager.onDidChangeStatus(() => {
      this.refresh()
    })
  }

  refresh(): void {
    this.tableSchemaCache.clear()
    this.onDidChangeTreeDataEmitter.fire(undefined)
  }

  refreshTable(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): void {
    this.tableSchemaCache.delete(this.getTableSchemaCacheKey(profile, tableName, scope))
    this.onDidChangeTreeDataEmitter.fire(undefined)
  }

  getTreeItem(element: ConnectionTreeNode): TreeItem {
    if (element instanceof PlaceholderNode) {
      const item = new TreeItem(element.label, TreeItemCollapsibleState.None)
      item.iconPath = new ThemeIcon('info')
      return item
    }

    if (element instanceof LoadingNode) {
      const item = new TreeItem(element.label, TreeItemCollapsibleState.None)
      item.iconPath = new ThemeIcon('loading~spin')
      return item
    }

    if (element instanceof ConnectionNode) {
      return this.getConnectionTreeItem(element)
    }

    if (element instanceof SchemaNode) {
      return this.getSchemaTreeItem(element)
    }

    if (element instanceof TablesGroupNode) {
      return this.getTablesGroupTreeItem(element)
    }

    if (element instanceof TableDetailGroupNode) {
      return this.getTableDetailGroupTreeItem(element)
    }

    if (element instanceof FieldNode) {
      return this.getFieldTreeItem(element)
    }

    if (element instanceof IndexNode) {
      return this.getIndexTreeItem(element)
    }

    if (element instanceof ForeignKeyNode) {
      return this.getForeignKeyTreeItem(element)
    }

    return new TreeItem('Unknown')
  }

  private getConnectionTreeItem(node: ConnectionNode): TreeItem {
    const item = new TreeItem(node.profile.name, node.collapsibleState)
    const status = connectionStatusManager.getStatus(node.profile.id)
    
    item.description = this.getConnectionDescription(node.profile, status)
    item.tooltip = this.getConnectionTooltip(node.profile, status)
    item.iconPath = this.getDriverIcon(node.profile.driverId)
    item.contextValue = status?.status === 'connected' ? 'connection.connected' : 'connection'
    
    if (status?.status === 'connected') {
      item.resourceUri = Uri.parse(`dbnexus://connected/${node.profile.id}`)
    }
    
    return item
  }

  private getConnectionDescription(profile: DbConnectionProfile, status?: { status: ConnectionStatusType; latency?: number }): string {
    const parts: string[] = []
    
    if (status?.status === 'connected') {
      parts.push('●')
    } else if (status?.status === 'error') {
      parts.push('✗')
    } else if (status?.status === 'connecting') {
      parts.push('◐')
    }
    
    parts.push(profile.driverId)
    
    if (status?.latency) {
      parts.push(`${status.latency}ms`)
    }
    
    return parts.join(' ')
  }

  private getConnectionTooltip(profile: DbConnectionProfile, status?: { status: ConnectionStatusType; latency?: number; error?: string }): string {
    const lines: string[] = [profile.name]
    
    if (status?.status === 'connected') {
      lines.push(`Status: Connected${status.latency ? ` (${status.latency}ms)` : ''}`)
    } else if (status?.status === 'error') {
      lines.push(`Status: Error`)
      if (status.error) {
        lines.push(`Error: ${status.error}`)
      }
    } else {
      lines.push('Status: Disconnected')
    }
    
    lines.push(`Driver: ${profile.driverId}`)
    
    if (profile.filePath) {
      lines.push(`File: ${profile.filePath}`)
    } else {
      const host = profile.host || 'localhost'
      lines.push(`Host: ${host}${profile.port ? `:${profile.port}` : ''}`)
      if (profile.database) {
        lines.push(`Database: ${profile.database}`)
      }
    }
    
    return lines.join('\n')
  }

  private getSchemaTreeItem(node: SchemaNode): TreeItem {
    const item = new TreeItem(node.schemaObject.name, node.collapsibleState)
    item.description = this.getSchemaDescription(node.schemaObject)
    item.tooltip = node.schemaObject.description || node.schemaObject.name
    item.iconPath = this.getIconForType(node.schemaObject.type)
    item.contextValue = node.schemaObject.type
    
    if (this.isTableLikeObject(node.schemaObject)) {
      item.contextValue = 'table'
      item.command = {
        command: 'dbNexus.showTableData',
        title: 'Open Table Data',
        arguments: [node]
      }
    }
    
    return item
  }

  private getSchemaDescription(schemaObject: SchemaObject): string | undefined {
    if (schemaObject.rowCount !== undefined) {
      return String(schemaObject.rowCount)
    }
    if (schemaObject.type === 'schema') {
      return 'schema'
    }
    if (schemaObject.type === 'view' || schemaObject.type === 'materializedView') {
      return 'view'
    }
    return undefined
  }

  private getTablesGroupTreeItem(node: TablesGroupNode): TreeItem {
    const item = new TreeItem(t('table.tables'), TreeItemCollapsibleState.Collapsed)
    item.description = node.tableCount === undefined ? undefined : String(node.tableCount)
    item.tooltip = t('table.openTableList')
    item.iconPath = this.getIconUri('table')
    item.contextValue = 'tables.group'
    return item
  }

  private getTableDetailGroupTreeItem(node: TableDetailGroupNode): TreeItem {
    const item = new TreeItem(this.getTableDetailGroupLabel(node.kind), TreeItemCollapsibleState.Collapsed)
    item.description = node.count === undefined ? undefined : String(node.count)
    item.iconPath = this.getTableDetailGroupIcon(node.kind)
    item.contextValue = `table.${node.kind}`
    return item
  }

  private getTableDetailGroupLabel(kind: TableDetailGroupKind): string {
    const labels: Record<TableDetailGroupKind, string> = {
      columns: t('table.columns'),
      indexes: t('table.indexes'),
      foreignKeys: t('table.foreignKeys'),
      checks: t('table.checks'),
      triggers: t('table.triggers')
    }
    return labels[kind]
  }

  private getTableDetailGroupIcon(kind: TableDetailGroupKind): ThemeIcon | { dark: Uri; light: Uri } {
    const icons: Record<TableDetailGroupKind, string> = {
      columns: 'symbol-field',
      indexes: 'list-ordered',
      foreignKeys: 'link',
      checks: 'check',
      triggers: 'zap'
    }
    return new ThemeIcon(icons[kind])
  }

  private getFieldTreeItem(node: FieldNode): TreeItem {
    const label = `${node.column.name}: ${node.column.type}`
    const item = new TreeItem(label, TreeItemCollapsibleState.None)
    item.tooltip = this.getFieldTooltip(node)
    item.iconPath = this.getFieldIcon(node)
    item.contextValue = 'field'
    return item
  }

  private getIndexTreeItem(node: IndexNode): TreeItem {
    const item = new TreeItem(node.index.name, TreeItemCollapsibleState.None)
    item.description = node.index.columns.join(', ')
    item.tooltip = [
      node.index.name,
      `Columns: ${node.index.columns.join(', ')}`,
      node.index.isPrimary ? 'PRIMARY KEY' : undefined,
      node.index.isUnique ? 'UNIQUE' : undefined,
      node.index.type ? `Type: ${node.index.type}` : undefined
    ].filter(Boolean).join('\n')
    item.iconPath = new ThemeIcon(node.index.isPrimary ? 'key' : 'list-ordered')
    item.contextValue = 'index'
    return item
  }

  private getForeignKeyTreeItem(node: ForeignKeyNode): TreeItem {
    const fk = node.foreignKey
    const item = new TreeItem(fk.name, TreeItemCollapsibleState.None)
    item.description = `${fk.referencedTable} (${fk.referencedColumns.join(', ')})`
    item.tooltip = [
      fk.name,
      `Columns: ${fk.columns.join(', ')}`,
      `References: ${fk.referencedTable} (${fk.referencedColumns.join(', ')})`,
      fk.onUpdate ? `On update: ${fk.onUpdate}` : undefined,
      fk.onDelete ? `On delete: ${fk.onDelete}` : undefined
    ].filter(Boolean).join('\n')
    item.iconPath = new ThemeIcon('link')
    item.contextValue = 'foreignKey'
    return item
  }

  private getFieldTooltip(node: FieldNode): string {
    const parts: string[] = [
      node.column.name,
      node.column.type
    ]
    
    if (node.column.isPrimaryKey) {
      parts.push('PRIMARY KEY')
    }
    if (node.isForeignKey()) {
      parts.push('FOREIGN KEY')
    }
    if (node.isUnique()) {
      parts.push('UNIQUE')
    }
    if (node.column.nullable) {
      parts.push('NULL')
    } else {
      parts.push('NOT NULL')
    }
    if (node.column.defaultValue !== undefined && node.column.defaultValue !== null) {
      parts.push(`DEFAULT: ${node.column.defaultValue}`)
    }
    
    return parts.join('\n')
  }

  private getFieldIcon(node: FieldNode): { dark: Uri; light: Uri } {
    const constraintType = node.getConstraintType()
    return {
      dark: Uri.file(path.join(this.extensionPath, 'resources', 'icons', 'dark', `${constraintType}.svg`)),
      light: Uri.file(path.join(this.extensionPath, 'resources', 'icons', 'light', `${constraintType}.svg`))
    }
  }

  getChildren(element?: ConnectionTreeNode, _token?: CancellationToken): ProviderResult<ConnectionTreeNode[]> {
    if (!element) {
      return this.getRootChildren()
    }

    if (element instanceof ConnectionNode) {
      return this.getConnectionChildren(element)
    }

    if (element instanceof SchemaNode) {
      return this.getSchemaChildren(element)
    }

    if (element instanceof TablesGroupNode) {
      return this.getTablesGroupChildren(element)
    }

    if (element instanceof TableDetailGroupNode) {
      return this.getTableDetailGroupChildren(element)
    }

    return []
  }

  private getRootChildren(): ConnectionTreeNode[] {
    const connections = this.connectionService.getConnections()
    if (connections.length === 0) {
      return [new PlaceholderNode(t('connection.noConnections'))]
    }
    return connections.map(profile => new ConnectionNode(profile, TreeItemCollapsibleState.Collapsed))
  }

  private async getConnectionChildren(node: ConnectionNode): Promise<ConnectionTreeNode[]> {
    try {
      if (this.shouldShowDatabaseCatalog(node.profile.driverId)) {
        const databases = await this.connectionService.listDatabases(node.profile)
        if (databases.length > 0) {
          return databases.map(db => new SchemaNode(
            node.profile,
            {
              name: db.name,
              type: 'database',
              description: db.description,
              hasChildren: true
            },
            TreeItemCollapsibleState.Collapsed,
            { database: db.name }
          ))
        }
      }

      const objects = await this.connectionService.listObjects(node.profile, {})
      if (objects.length === 0) {
        return [new PlaceholderNode(t('connection.emptySchema'))]
      }
      return this.toSchemaNodes(node.profile, objects, {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return [new PlaceholderNode(t('connection.loadError', message))]
    }
  }

  private async getSchemaChildren(node: SchemaNode): Promise<ConnectionTreeNode[]> {
    try {
      if (this.isTableLikeObject(node.schemaObject)) {
        return this.getTableDetailGroups(node)
      }

      const scope = this.getScopeForContainerNode(node)
      const objects = await this.connectionService.listObjects(node.connectionProfile, scope)
      const children = this.groupContainerChildren(node.connectionProfile, objects, scope)
      if (children.length === 0 && node.schemaObject.type === 'database') {
        const fallbackScope = { parentName: node.schemaObject.name }
        const fallbackObjects = await this.connectionService.listObjects(node.connectionProfile, fallbackScope)
        return this.groupContainerChildren(node.connectionProfile, fallbackObjects, fallbackScope)
      }
      return children.length > 0 ? children : [new PlaceholderNode(t('connection.emptySchema'))]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return [new PlaceholderNode(t('connection.loadError', message))]
    }
  }

  private async getTablesGroupChildren(node: TablesGroupNode): Promise<ConnectionTreeNode[]> {
    try {
      const objects = await this.connectionService.listObjects(node.connectionProfile, node.scope)
      const tableObjects = objects.filter(obj => this.isTableLikeObject(obj))
      if (tableObjects.length === 0) {
        return [new PlaceholderNode(t('connection.emptySchema'))]
      }
      return this.toSchemaNodes(node.connectionProfile, tableObjects, node.scope)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return [new PlaceholderNode(t('connection.loadError', message))]
    }
  }

  private async getTableDetailGroups(node: SchemaNode): Promise<ConnectionTreeNode[]> {
    try {
      const schema = await this.getCachedTableSchema(node.connectionProfile, node.schemaObject.name, node.scope)
      return [
        new TableDetailGroupNode(node.connectionProfile, node.schemaObject.name, 'columns', node.scope, schema.columns.length),
        new TableDetailGroupNode(node.connectionProfile, node.schemaObject.name, 'indexes', node.scope, schema.indexes.length),
        new TableDetailGroupNode(node.connectionProfile, node.schemaObject.name, 'foreignKeys', node.scope, schema.foreignKeys.length),
        new TableDetailGroupNode(node.connectionProfile, node.schemaObject.name, 'checks', node.scope),
        new TableDetailGroupNode(node.connectionProfile, node.schemaObject.name, 'triggers', node.scope)
      ]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return [new PlaceholderNode(`Error: ${message}`)]
    }
  }

  private async getTableDetailGroupChildren(node: TableDetailGroupNode): Promise<ConnectionTreeNode[]> {
    try {
      if (node.kind === 'checks' || node.kind === 'triggers') {
        return [new PlaceholderNode(t('table.notSupportedYet'))]
      }

      const schema = await this.getCachedTableSchema(node.connectionProfile, node.tableName, node.scope)

      if (node.kind === 'columns') {
        if (schema.columns.length === 0) {
          return [new PlaceholderNode(t('connection.emptySchema'))]
        }
        return schema.columns.map((col: TableColumn) => new FieldNode(
          node.connectionProfile,
          node.tableName,
          col,
          schema.indexes,
          schema.foreignKeys,
          node.scope
        ))
      }

      if (node.kind === 'indexes') {
        return schema.indexes.length > 0
          ? schema.indexes.map(index => new IndexNode(index))
          : [new PlaceholderNode(t('table.noIndexes'))]
      }

      return schema.foreignKeys.length > 0
        ? schema.foreignKeys.map(foreignKey => new ForeignKeyNode(foreignKey))
        : [new PlaceholderNode(t('table.noForeignKeys'))]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return [new PlaceholderNode(`Error: ${message}`)]
    }
  }

  private groupContainerChildren(
    profile: DbConnectionProfile,
    objects: SchemaObject[],
    scope: SchemaScope
  ): ConnectionTreeNode[] {
    if (objects.length === 0) {
      return []
    }

    const tableObjects = objects.filter(obj => this.isTableLikeObject(obj))
    const containerObjects = objects.filter(obj => !this.isTableLikeObject(obj))
    const nodes: ConnectionTreeNode[] = []

    if (tableObjects.length > 0) {
      nodes.push(new TablesGroupNode(profile, scope, tableObjects.length))
    }

    nodes.push(...this.toSchemaNodes(profile, containerObjects, scope))
    return nodes
  }

  private toSchemaNodes(
    profile: DbConnectionProfile,
    objects: SchemaObject[],
    scope: SchemaScope
  ): SchemaNode[] {
    return objects.map(obj => new SchemaNode(
      profile,
      { ...obj, scope },
      obj.hasChildren !== false ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
      scope
    ))
  }

  private getScopeForContainerNode(node: SchemaNode): SchemaScope {
    if (node.schemaObject.type === 'database') {
      return {
        ...node.scope,
        database: node.schemaObject.name
      }
    }

    if (node.schemaObject.type === 'schema') {
      if (node.scope.database) {
        return {
          ...node.scope,
          schema: node.schemaObject.name
        }
      }

      return {
        ...node.scope,
        database: node.schemaObject.name
      }
    }

    return node.scope
  }

  private async getCachedTableSchema(
    profile: DbConnectionProfile,
    tableName: string,
    scope: SchemaScope
  ): Promise<TableSchema> {
    const driver = this.connectionService.getDriver(profile.driverId)
    if (!driver?.getTableSchema) {
      throw new Error('Schema not supported')
    }

    const key = this.getTableSchemaCacheKey(profile, tableName, scope)

    if (!this.tableSchemaCache.has(key)) {
      this.tableSchemaCache.set(key, driver.getTableSchema(profile, tableName, scope))
    }

    return this.tableSchemaCache.get(key)!
  }

  private getTableSchemaCacheKey(
    profile: DbConnectionProfile,
    tableName: string,
    scope: SchemaScope
  ): string {
    return [
      profile.id,
      scope.database || '',
      scope.schema || '',
      scope.parentName || '',
      tableName
    ].join('\u0000')
  }

  private shouldShowDatabaseCatalog(driverId: DatabaseDriverId): boolean {
    return ['mysql', 'mariadb', 'clickhouse', 'sqlite', 'duckdb'].includes(driverId)
  }

  private isTableLikeObject(object: SchemaObject): boolean {
    return object.type === 'table' || object.type === 'view' || object.type === 'materializedView'
  }

  private getDriverIcon(driverId: DatabaseDriverId): Uri | ThemeIcon | { dark: Uri; light: Uri } {
    const iconFile = DRIVER_ICONS[driverId]
    if (iconFile) {
      return Uri.file(path.join(this.extensionPath, 'assets', 'icons', iconFile))
    }
    return this.getIconUri('database')
  }

  private getIconForType(type: string): Uri | ThemeIcon | { dark: Uri; light: Uri } {
    const iconTypes = ['database', 'table']
    if (iconTypes.includes(type)) {
      return this.getIconUri(type)
    }
    const iconMap: Record<string, string> = {
      schema: 'folder',
      view: 'eye',
      materializedView: 'eye',
      procedure: 'code',
      function: 'symbol-function',
      index: 'list-ordered',
      collection: 'folder-library',
      keyspace: 'key',
      bucket: 'package',
      file: 'file'
    }
    return new ThemeIcon(iconMap[type] || 'symbol-misc')
  }

  private getIconUri(name: string): { dark: Uri; light: Uri } {
    return {
      dark: Uri.file(path.join(this.extensionPath, 'resources', 'icons', 'dark', `${name}.svg`)),
      light: Uri.file(path.join(this.extensionPath, 'resources', 'icons', 'light', `${name}.svg`))
    }
  }
}
