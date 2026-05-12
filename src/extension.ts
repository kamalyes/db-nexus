import { ExtensionContext, ProgressLocation, TreeItemCollapsibleState, Uri, commands, env, window, workspace } from 'vscode'
import { buildConnectionUrl, parseConnectionUrl } from '@/core/connectionUrl'
import { ConnectionStore } from '@/core/connectionStore'
import { SUPPORTED_DRIVERS } from '@/core/constants'
import { ConnectionTestResult, DatabaseDriverId, DbConnectionProfile, SchemaObject, SchemaScope, TableColumn, TableDesignDraft, TableIndex, TableSchema } from '@/core/types'
import { DriverRegistry } from '@/drivers/registry'
import { getCurrentLanguage, initI18n, reloadI18n, t } from '@/i18n'
import { ConnectionNode, ConnectionsTreeProvider, FieldNode, IndexNode, QueryFileNode, SchemaNode, TableDetailGroupNode, TablesGroupNode } from '@/providers/connectionsTree'
import { ConnectionService } from '@/services/connectionService'
import { connectionStatusManager } from '@/services/connectionStatusManager'
import { QueryService } from '@/services/queryService'
import { QueryFileService } from '@/services/queryFileService'
import { SecretService } from '@/services/secretService'
import { QueryHistoryService } from '@/services/queryHistoryService'
import { ResultPanel } from '@/webviews/resultPanel'
import { TableSchemaPanel } from '@/webviews/tableSchemaPanel'
import { QueryHistoryPanel } from '@/webviews/queryHistoryPanel'
import { ExecutionPlanPanel } from '@/webviews/executionPlanPanel'
import { TableDataPanel } from '@/webviews/tableDataPanel'
import { TableListPanel } from '@/webviews/tableListPanel'
import { DataExportService } from '@/services/dataExportService'
import { ERDiagramPanel } from '@/webviews/erDiagramPanel'
import { BackupRestoreService, BackupOptions, RestoreOptions } from '@/services/backupRestoreService'
import { SchemaComparePanel } from '@/webviews/schemaComparePanel'
import { DataMigrationService, MigrationOptions } from '@/services/dataMigrationService'
import { ConnectionDashboard } from '@/webviews/connectionDashboard'
import { SqlEditorPanel } from '@/webviews/sqlEditorPanel'

let connectionsTreeProvider: ConnectionsTreeProvider | undefined
let connectionsTreeView: ReturnType<typeof window.createTreeView> | undefined

type TableTarget = {
  profile: DbConnectionProfile
  scope: SchemaScope
  tableName: string
  objectType: SchemaObject['type']
  rowCount?: number
  description?: string
  schema?: TableSchema
}

type FieldTarget = {
  profile: DbConnectionProfile
  scope: SchemaScope
  tableName: string
  columnName: string
  columnType: string
}

type TableDesignSaveRequest = {
  profile: DbConnectionProfile
  scope: SchemaScope
  tableName: string
  objectType: SchemaObject['type']
  originalSchema: TableSchema
  draft: TableDesignDraft
  mode: 'design' | 'create'
}

type TableSchemaTab = 'fields' | 'indexes' | 'foreignKeys' | 'checks' | 'triggers' | 'options' | 'comment' | 'sql'

type QueryExecutionContext = {
  profile: DbConnectionProfile
  scope: SchemaScope
  label?: string
}

export async function activate(context: ExtensionContext): Promise<void> {
  initI18n(context.extensionPath)
  SecretService.init(context)
  QueryHistoryService.init(context)

  const outputChannel = window.createOutputChannel('DB Nexus')
  const connectionStore = await ConnectionStore.create(context)
  const driverRegistry = new DriverRegistry(context.extensionPath)
  const connectionService = new ConnectionService(connectionStore, driverRegistry)
  const queryService = new QueryService(driverRegistry)
  const queryFileService = new QueryFileService(Uri.joinPath(context.globalStorageUri, 'queries'))
  const documentQueryContexts = new Map<string, QueryExecutionContext>()
  let pendingTableOpen: { key: string; timer: ReturnType<typeof setTimeout> } | undefined

  const bindSqlDocumentContext = (uri: Uri, queryContext: QueryExecutionContext): void => {
    documentQueryContexts.set(uri.toString(), queryContext)
  }

  const getTableOpenKey = (node: SchemaNode): string => [
    node.connectionProfile.id,
    node.scope?.database || '',
    node.scope?.schema || '',
    node.scope?.parentName || '',
    node.schemaObject.type,
    node.schemaObject.name
  ].join('\u0000')

  const clearPendingTableOpen = (): void => {
    if (pendingTableOpen) {
      clearTimeout(pendingTableOpen.timer)
      pendingTableOpen = undefined
    }
  }

  const isListOpenModeDoubleClick = (): boolean => (
    workspace.getConfiguration('workbench.list').get<string>('openMode') === 'doubleClick'
  )

  context.subscriptions.push(workspace.onDidCloseTextDocument(document => {
    documentQueryContexts.delete(document.uri.toString())
  }))

  connectionsTreeProvider = new ConnectionsTreeProvider(connectionService, context.extensionPath, queryFileService)
  connectionsTreeView = window.createTreeView('dbNexus.connections', {
    treeDataProvider: connectionsTreeProvider,
    showCollapseAll: true
  })

  const resolveNodeContext = async (
    node: ConnectionNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined
  ): Promise<{ profile: DbConnectionProfile; scope: SchemaScope } | undefined> => {
    if (node instanceof ConnectionNode) {
      return { profile: node.profile, scope: {} }
    }
    if (node instanceof TablesGroupNode) {
      return { profile: node.connectionProfile, scope: node.scope || {} }
    }
    if (node instanceof TableDetailGroupNode) {
      return { profile: node.connectionProfile, scope: node.scope || {} }
    }
    if (node instanceof SchemaNode) {
      return { profile: node.connectionProfile, scope: getContainerScope(node) }
    }

    const profile = await pickConnection(connectionService.getConnections())
    return profile ? { profile, scope: {} } : undefined
  }

  const resolveTableTarget = async (
    node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | TableTarget | undefined
  ): Promise<TableTarget | undefined> => {
    if (isTableTarget(node)) {
      return node
    }

    if (node instanceof SchemaNode && isTableLikeNode(node)) {
      return {
        profile: node.connectionProfile,
        scope: node.scope || {},
        tableName: node.schemaObject.name,
        objectType: node.schemaObject.type,
        rowCount: node.schemaObject.rowCount,
        description: node.schemaObject.description
      }
    }

    if (node instanceof TableDetailGroupNode) {
      return {
        profile: node.connectionProfile,
        scope: node.scope || {},
        tableName: node.tableName,
        objectType: 'table'
      }
    }

    if (node instanceof FieldNode || node instanceof IndexNode) {
      return {
        profile: node.connectionProfile,
        scope: node.scope || {},
        tableName: node.tableName,
        objectType: 'table'
      }
    }

    const dbContext = await resolveNodeContext(node)
    if (!dbContext) return undefined

    const objects = await connectionService.listObjects(dbContext.profile, dbContext.scope)
    const tables = objects.filter(isTableLikeObject)
    if (tables.length === 0) {
      window.showWarningMessage(t('connection.emptySchema'))
      return undefined
    }

    const picked = await window.showQuickPick(
      tables.map(table => ({
        label: table.name,
        description: table.type,
        table
      })),
      { placeHolder: t('table.selectTable') }
    )

    if (!picked) return undefined

    return {
      profile: dbContext.profile,
      scope: dbContext.scope,
      tableName: picked.table.name,
      objectType: picked.table.type,
      rowCount: picked.table.rowCount,
      description: picked.table.description
    }
  }

  const resolveFieldTarget = async (node: FieldNode | FieldTarget | undefined): Promise<FieldTarget | undefined> => {
    if (isFieldTarget(node)) {
      return node
    }

    if (!node) {
      window.showWarningMessage(t('table.selectColumn'))
      return undefined
    }

    return {
      profile: node.connectionProfile,
      scope: node.scope || {},
      tableName: node.tableName,
      columnName: node.column.name,
      columnType: node.column.type
    }
  }

  const executeSql = async (profile: DbConnectionProfile, sql: string, scope: SchemaScope = {}) => {
    return driverRegistry.getDriver(profile.driverId).executeQuery(profile, {
      sql,
      database: scope.database,
      schema: scope.schema
    })
  }

  const openSqlDocument = async (sql: string, queryContext?: QueryExecutionContext): Promise<void> => {
    if (queryContext) {
      SqlEditorPanel.show(context, connectionService, driverRegistry, queryService, {
        sql,
        profile: queryContext.profile,
        scope: queryContext.scope,
        title: getQueryContextLabel(queryContext)
      })
      return
    }

    const document = await workspace.openTextDocument({
      language: 'sql',
      content: sql.endsWith('\n') ? sql : `${sql}\n`
    })
    await window.showTextDocument(document)
  }

  const resolveActiveQueryContext = async (): Promise<QueryExecutionContext | undefined> => {
    const editor = window.activeTextEditor
    if (editor) {
      const queryContext = documentQueryContexts.get(editor.document.uri.toString())
      if (queryContext) {
        return queryContext
      }
    }

    const profile = await pickConnection(connectionService.getConnections())
    return profile ? { profile, scope: getDefaultQueryScope(profile), label: profile.name } : undefined
  }

  const getQueryContextLabel = (queryContext: QueryExecutionContext): string => {
    const parts = [queryContext.profile.name, queryContext.scope.database, queryContext.scope.schema]
      .filter((part): part is string => Boolean(part))
    return queryContext.label || parts.join(' / ')
  }

  const getDefaultQueryScope = (profile: DbConnectionProfile): SchemaScope => ({
    database: profile.database
  })

  const runSqlFileUri = async (
    profile: DbConnectionProfile,
    scope: SchemaScope,
    uri: Uri,
    resultLabel: string = profile.name
  ): Promise<void> => {
    let sql = ''
    try {
      sql = new TextDecoder().decode(await workspace.fs.readFile(uri))
      const result = await window.withProgress(
        { location: ProgressLocation.Notification, title: t('table.runningSqlFile') },
        () => executeSql(profile, sql, scope)
      )
      ResultPanel.show(context, t('query.resultTitle', resultLabel), result)
      await QueryHistoryService.getInstance().add(sql, profile, result)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      outputChannel.appendLine(message)
      window.showErrorMessage(t('query.failed', message))
      if (sql) {
        await QueryHistoryService.getInstance().add(sql, profile, error instanceof Error ? error : new Error(message))
      }
    }
  }

  const openInsertTemplate = async (
    node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined
  ): Promise<void> => {
    const target = await resolveTableTarget(node)
    if (!target) return

    if (target.objectType !== 'table') {
      window.showWarningMessage(t('table.onlyTablesCanGenerateMutation'))
      return
    }

    const driver = driverRegistry.getDriver(target.profile.driverId)
    if (!driver?.getTableSchema) {
      window.showErrorMessage(t('table.schemaNotSupported'))
      return
    }

    try {
      const schema = await driver.getTableSchema(target.profile, target.tableName, target.scope)
      const qualifiedName = getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)
      const columns = schema.columns.filter(column => !column.isAutoIncrement)
      await openSqlDocument(buildInsertTemplate(target.profile.driverId, qualifiedName, columns), {
        profile: target.profile,
        scope: target.scope
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      window.showErrorMessage(t('table.schemaFailed', message))
    }
  }

  const openMockDataTemplate = async (
    node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | TableTarget | undefined
  ): Promise<void> => {
    const target = await resolveTableTarget(node)
    if (!target) return

    if (target.objectType !== 'table') {
      window.showWarningMessage(t('table.onlyTablesCanGenerateMutation'))
      return
    }

    const rowCountText = await window.showInputBox({
      prompt: t('table.mockRowCountPrompt'),
      value: '20',
      validateInput: (value) => {
        const count = Number(value)
        if (!Number.isInteger(count) || count <= 0 || count > 1000) {
          return t('table.mockRowCountInvalid')
        }
        return undefined
      }
    })
    if (!rowCountText) return

    const rowCount = Number(rowCountText)
    const driver = driverRegistry.getDriver(target.profile.driverId)
    if (!driver?.getTableSchema && !target.schema) {
      window.showErrorMessage(t('table.schemaNotSupported'))
      return
    }

    try {
      const schema = target.schema || await driver.getTableSchema!(target.profile, target.tableName, target.scope)
      const sql = buildMockInsertTemplate(target.profile.driverId, target.scope, target.tableName, schema, rowCount)
      await openSqlDocument(sql, {
        profile: target.profile,
        scope: target.scope
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      window.showErrorMessage(t('table.schemaFailed', message))
    }
  }

  const openMutationTemplate = async (
    node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined,
    kind: 'update' | 'delete'
  ): Promise<void> => {
    const target = await resolveTableTarget(node)
    if (!target) return

    if (target.objectType !== 'table') {
      window.showWarningMessage(t('table.onlyTablesCanGenerateMutation'))
      return
    }

    const driver = driverRegistry.getDriver(target.profile.driverId)
    if (!driver?.getTableSchema) {
      window.showErrorMessage(t('table.schemaNotSupported'))
      return
    }

    try {
      const schema = await driver.getTableSchema(target.profile, target.tableName, target.scope)
      const qualifiedName = getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)
      const sql = kind === 'update'
        ? buildUpdateTemplate(target.profile.driverId, qualifiedName, schema.columns)
        : buildDeleteTemplate(target.profile.driverId, qualifiedName, schema.columns)
      await openSqlDocument(sql, {
        profile: target.profile,
        scope: target.scope
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      window.showErrorMessage(t('table.schemaFailed', message))
    }
  }

  const exportTable = async (target: TableTarget, format: 'csv' | 'json' | 'sql'): Promise<void> => {
    try {
      const qualifiedName = getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)
      const result = await executeSql(target.profile, `SELECT * FROM ${qualifiedName}`, target.scope)
      if (format === 'csv') {
        await DataExportService.exportToCSV(result, target.tableName)
      } else if (format === 'json') {
        await DataExportService.exportToJSON(result, target.tableName)
      } else {
        await DataExportService.exportToSQL(result, target.tableName, `${target.tableName}_insert`)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      window.showErrorMessage(t('export.failed', message))
    }
  }

  const importTable = async (target: TableTarget, format: 'csv' | 'json'): Promise<void> => {
    const driver = driverRegistry.getDriver(target.profile.driverId)
    if (!driver?.planInsert || !driver?.executeMutation) {
      window.showErrorMessage(t('import.notSupported'))
      return
    }

    try {
      const rows = format === 'csv'
        ? await DataExportService.importFromCSV()
        : await DataExportService.importFromJSON()
      if (!rows || rows.length === 0) return

      let inserted = 0
      for (const row of rows) {
        const plan = await driver.planInsert(target.profile, target.tableName, row, target.scope)
        const result = await driver.executeMutation(target.profile, plan)
        if (result.success) {
          inserted++
        }
      }

      window.showInformationMessage(t('import.success', String(inserted)))
      connectionsTreeProvider?.refresh()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      window.showErrorMessage(t('import.failed', message))
    }
  }

  const showDataDictionary = async (node: SchemaNode | TablesGroupNode | undefined): Promise<void> => {
    const dbContext = await resolveNodeContext(node)
    if (!dbContext) return

    const driver = driverRegistry.getDriver(dbContext.profile.driverId)
    if (!driver?.getTableSchema) {
      window.showErrorMessage(t('table.schemaNotSupported'))
      return
    }

    const targets: TableTarget[] = []
    if (node instanceof SchemaNode && isTableLikeNode(node)) {
      targets.push({
        profile: node.connectionProfile,
        scope: node.scope || {},
        tableName: node.schemaObject.name,
        objectType: node.schemaObject.type
      })
    } else {
      const tables = await listTablesForScope(dbContext.profile, dbContext.scope)
      targets.push(...tables.map(object => ({
        profile: dbContext.profile,
        scope: object.scope || dbContext.scope,
        tableName: object.name,
        objectType: object.type
      })))
    }

    if (targets.length === 0) {
      window.showWarningMessage(t('connection.emptySchema'))
      return
    }

    const schemas: TableSchema[] = []
    for (const target of targets) {
      schemas.push(await driver.getTableSchema(target.profile, target.tableName, target.scope))
    }

    const document = await workspace.openTextDocument({
      language: 'markdown',
      content: buildDataDictionary(dbContext.profile, dbContext.scope, schemas)
    })
    await window.showTextDocument(document)
  }

  const showTableSchemaForTarget = async (
    target: TableTarget,
    options: { initialTab?: TableSchemaTab; selectedIndexName?: string } = {}
  ): Promise<void> => {
    const driver = driverRegistry.getDriver(target.profile.driverId)
    if (!driver?.getTableSchema) {
      window.showErrorMessage(t('table.schemaNotSupported'))
      return
    }

    try {
      const startedAt = Date.now()
      const schema = await driver.getTableSchema(target.profile, target.tableName, target.scope)
      const schemaLoadMs = Date.now() - startedAt
      TableSchemaPanel.show(context, t('table.schemaTitle', schema.name), schema, {
        profile: target.profile,
        scope: target.scope,
        objectType: target.objectType,
        rowCount: target.rowCount,
        description: target.description,
        schemaLoadMs,
        loadedAt: new Date().toISOString(),
        ...options
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      window.showErrorMessage(t('table.schemaFailed', message))
    }
  }

  const getContainerScope = (node: ConnectionNode | SchemaNode | TablesGroupNode): SchemaScope => {
    if (node instanceof ConnectionNode) {
      return {}
    }
    if (node instanceof TablesGroupNode) {
      return node.scope || {}
    }
    if (node.schemaObject.type === 'database') {
      return {
        ...node.scope,
        database: node.schemaObject.name
      }
    }
    if (node.schemaObject.type === 'schema') {
      if (node.connectionProfile.driverId === 'sqlite') {
        return {
          ...node.scope,
          parentName: node.schemaObject.name
        }
      }
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
    return node.scope || {}
  }

  const getChildContainerScope = (
    profile: DbConnectionProfile,
    scope: SchemaScope,
    object: SchemaObject
  ): SchemaScope => {
    if (object.type === 'database') {
      return {
        ...scope,
        database: object.name
      }
    }

    if (object.type === 'schema') {
      if (profile.driverId === 'sqlite') {
        return {
          ...scope,
          parentName: object.name
        }
      }

      if (scope.database) {
        return {
          ...scope,
          schema: object.name
        }
      }

      return {
        ...scope,
        database: object.name
      }
    }

    return scope
  }

  const listTablesForScope = async (
    profile: DbConnectionProfile,
    scope: SchemaScope,
    visited = new Set<string>()
  ): Promise<SchemaObject[]> => {
    const visitKey = [profile.id, scope.database || '', scope.schema || '', scope.parentName || ''].join('\u0000')
    if (visited.has(visitKey)) {
      return []
    }
    visited.add(visitKey)

    const objects = await connectionService.listObjects(profile, scope)
    const tables = objects
      .filter(isTableLikeObject)
      .map(table => ({ ...table, scope }))

    if (tables.length > 0) {
      return tables
    }

    const containers = objects.filter(object => !isTableLikeObject(object))
    const nestedTables: SchemaObject[] = []
    for (const object of containers) {
      nestedTables.push(...await listTablesForScope(profile, getChildContainerScope(profile, scope, object), visited))
    }
    return nestedTables
  }

  const closeExpandedDatabaseTree = async (
    node: ConnectionNode | SchemaNode | TablesGroupNode | undefined
  ): Promise<void> => {
    const dbContext = await resolveNodeContext(node)
    if (!dbContext) return

    const scope = node ? getContainerScope(node) : dbContext.scope
    TableSchemaPanel.closeFor(dbContext.profile, scope)
    TableDataPanel.closeFor(dbContext.profile)
    connectionsTreeProvider?.collapseAll()
    await commands.executeCommand('workbench.actions.treeView.dbNexus.connections.collapseAll').then(undefined, () => undefined)
  }

  const resolveConnectionProfile = async (
    target?: ConnectionNode | DbConnectionProfile | string
  ): Promise<DbConnectionProfile | undefined> => {
    if (target instanceof ConnectionNode) {
      return target.profile
    }
    if (typeof target === 'string') {
      return connectionStore.getById(target)
    }
    if (target && 'id' in target && 'driverId' in target) {
      return target
    }
    return pickConnection(connectionService.getConnections())
  }

  const runTemporaryConnectionTest = async (profile: DbConnectionProfile): Promise<ConnectionTestResult> => {
    const driver = driverRegistry.getDriver(profile.driverId)
    const secretService = SecretService.getInstance()
    const tempProfile: DbConnectionProfile = {
      ...profile,
      id: `test_${profile.id}_${Date.now()}`
    }
    const password = await secretService.getPassword(profile.id)

    if (password) {
      await secretService.storePassword(tempProfile.id, password)
    }

    try {
      return await connectionService.testConnection(tempProfile)
    } finally {
      if (driver.dispose) {
        await driver.dispose(tempProfile.id).then(undefined, () => undefined)
      }
      if (password) {
        await secretService.deletePassword(tempProfile.id)
      }
    }
  }

  const restoreConnectionStatus = (
    profileId: string,
    previousStatus: ReturnType<typeof connectionStatusManager.getStatus>
  ): void => {
    if (previousStatus) {
      connectionStatusManager.setStatus(
        profileId,
        previousStatus.status,
        previousStatus.latency,
        previousStatus.error
      )
    } else {
      connectionStatusManager.clearStatus(profileId)
    }
  }

  const testConnectionOnly = async (
    target?: ConnectionNode | DbConnectionProfile | string
  ): Promise<void> => {
    const profile = await resolveConnectionProfile(target)
    if (!profile) return

    const previousStatus = connectionStatusManager.getStatus(profile.id)
    await window.withProgress(
      { location: ProgressLocation.Notification, title: t('connection.testing') },
      async () => {
        connectionStatusManager.setStatus(profile.id, 'connecting')
        connectionsTreeProvider?.refresh()

        try {
          const result = await runTemporaryConnectionTest(profile)
          if (result.ok) {
            window.showInformationMessage(t('connection.testSuccess', result.latencyMs || 0))
          } else {
            window.showErrorMessage(t('connection.testFailed', result.message))
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          window.showErrorMessage(t('connection.testFailed', message))
        } finally {
          restoreConnectionStatus(profile.id, previousStatus)
          connectionsTreeProvider?.refresh()
        }
      }
    )
  }

  const addConnectionFromUrl = async (connectionUrl?: string): Promise<void> => {
    const rawUrl = connectionUrl || await window.showInputBox({
      prompt: t('connection.urlPrompt'),
      placeHolder: 'postgresql://user:password@localhost:5432/app?ssl=true',
      ignoreFocusOut: true
    })
    if (!rawUrl) return

    try {
      const parsed = parseConnectionUrl(rawUrl)
      const savedProfile = await connectionStore.add(parsed.profile)
      if (parsed.password) {
        await SecretService.getInstance().storePassword(savedProfile.id, parsed.password)
      }
      connectionsTreeProvider?.refresh()
      ConnectionDashboard.refreshCurrent()
      window.showInformationMessage(t('connection.added', savedProfile.name))
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      window.showErrorMessage(t('connection.urlInvalid', message))
    }
  }

  const copyConnectionUrl = async (
    target?: ConnectionNode | DbConnectionProfile | string
  ): Promise<void> => {
    const profile = await resolveConnectionProfile(target)
    if (!profile) return

    await env.clipboard.writeText(buildConnectionUrl(profile))
    window.showInformationMessage(t('connection.urlCopied'))
  }

  const revealConnectionInTree = async (profile: DbConnectionProfile): Promise<void> => {
    connectionsTreeProvider?.refresh()
    try {
      await connectionsTreeView?.reveal(
        new ConnectionNode(profile, TreeItemCollapsibleState.Expanded),
        { focus: true, select: true, expand: true }
      )
    } catch {
      await commands.executeCommand('dbNexus.refreshConnections')
    }
  }

  const connectConnection = async (
    target?: ConnectionNode | DbConnectionProfile | string,
    options: { reveal?: boolean } = {}
  ): Promise<boolean> => {
    const profile = await resolveConnectionProfile(target)
    if (!profile) return false

    return window.withProgress(
      { location: ProgressLocation.Notification, title: t('connection.connecting', profile.name) },
      async () => {
        const driver = driverRegistry.getDriver(profile.driverId)
        if (driver.dispose) {
          await driver.dispose(profile.id)
        }

        connectionStatusManager.setStatus(profile.id, 'connecting')
        connectionsTreeProvider?.refresh()

        const result = await connectionService.testConnection(profile)
        if (result.ok) {
          connectionStatusManager.setStatus(profile.id, 'connected', result.latencyMs)
          if (options.reveal === false) {
            connectionsTreeProvider?.refresh()
          } else {
            await revealConnectionInTree(profile)
          }
          window.showInformationMessage(t('connection.connected', profile.name))
          return true
        }

        connectionStatusManager.setStatus(profile.id, 'error', undefined, result.message)
        if (driver.dispose) {
          await driver.dispose(profile.id)
        }
        connectionsTreeProvider?.refresh()
        window.showErrorMessage(t('connection.connectFailed', result.message))
        return false
      }
    )
  }

  const disconnectConnection = async (
    target?: ConnectionNode | DbConnectionProfile | string
  ): Promise<void> => {
    const profile = await resolveConnectionProfile(target)
    if (!profile) return

    const driver = driverRegistry.getDriver(profile.driverId)
    if (driver.dispose) {
      await driver.dispose(profile.id)
    }

    connectionStatusManager.setStatus(profile.id, 'disconnected')
    TableSchemaPanel.closeFor(profile)
    TableDataPanel.closeFor(profile)
    connectionsTreeProvider?.collapseAll()
    await commands.executeCommand('workbench.actions.treeView.dbNexus.connections.collapseAll').then(undefined, () => undefined)
    window.showInformationMessage(t('connection.disconnected', profile.name))
  }

  const openDatabase = async (
    target?: ConnectionNode | DbConnectionProfile | string
  ): Promise<void> => {
    const profile = await resolveConnectionProfile(target)
    if (!profile) return

    if (!connectionStatusManager.isConnected(profile.id)) {
      const connected = await connectConnection(profile, { reveal: false })
      if (!connected) return
    }

    await revealConnectionInTree(profile)
  }

  context.subscriptions.push(
    outputChannel,
    connectionsTreeView,
    commands.registerCommand('dbNexus.refreshConnections', () => {
      connectionsTreeProvider?.refresh()
    }),
    commands.registerCommand('dbNexus.connectConnection', async (target?: ConnectionNode | DbConnectionProfile | string) => {
      await connectConnection(target)
    }),
    commands.registerCommand('dbNexus.disconnectConnection', async (target?: ConnectionNode | DbConnectionProfile | string) => {
      await disconnectConnection(target)
    }),
    commands.registerCommand('dbNexus.openDatabase', async (target?: ConnectionNode | DbConnectionProfile | string) => {
      await openDatabase(target)
    }),
    commands.registerCommand('dbNexus.addConnectionFromUrl', async (connectionUrl?: string) => {
      await addConnectionFromUrl(connectionUrl)
    }),
    commands.registerCommand('dbNexus.copyConnectionUrl', async (target?: ConnectionNode | DbConnectionProfile | string) => {
      await copyConnectionUrl(target)
    }),
    commands.registerCommand('dbNexus.openDashboard', () => {
      ConnectionDashboard.show(context, connectionStore, driverRegistry)
    }),
    commands.registerCommand('dbNexus.addConnection', async () => {
      ConnectionDashboard.show(context, connectionStore, driverRegistry)
      setTimeout(() => {
        ConnectionDashboard.showAddForm()
      }, 100)
    }),
    commands.registerCommand('dbNexus.testConnection', async (target: ConnectionNode | DbConnectionProfile | string | undefined) => {
      await testConnectionOnly(target)
    }),
    commands.registerCommand('dbNexus.deleteConnection', async (node: ConnectionNode | undefined) => {
      const profile = node ? node.profile : await pickConnection(connectionService.getConnections())
      if (!profile) return

      const confirm = await window.showWarningMessage(
        t('connection.deleteConfirm', profile.name),
        { modal: true },
        t('common.delete')
      )
      if (confirm !== t('common.delete')) return

      const driver = driverRegistry.getDriver(profile.driverId)
      if (driver.dispose) {
        await driver.dispose(profile.id)
      }
      await connectionStore.remove(profile.id)
      await SecretService.getInstance().deletePassword(profile.id)
      TableSchemaPanel.closeFor(profile)
      TableDataPanel.closeFor(profile)
      connectionStatusManager.clearStatus(profile.id)
      connectionsTreeProvider?.collapseAll()
      await commands.executeCommand('workbench.actions.treeView.dbNexus.connections.collapseAll').then(undefined, () => undefined)
      window.showInformationMessage(t('connection.deleted', profile.name))
    }),
    commands.registerCommand('dbNexus.editConnection', async (node: ConnectionNode | undefined) => {
      const profile = node ? node.profile : await pickConnection(connectionService.getConnections())
      if (!profile) return

      ConnectionDashboard.show(context, connectionStore, driverRegistry)
      setTimeout(() => {
        ConnectionDashboard.showEditForm(profile.id)
      }, 100)
    }),
    commands.registerCommand('dbNexus.openSqlScratch', async () => {
      SqlEditorPanel.show(context, connectionService, driverRegistry, queryService, {
        sql: t('query.scratchContent')
      })
    }),
    commands.registerCommand('dbNexus.runQuery', async () => {
      const editor = window.activeTextEditor
      const sql = editor
        ? editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection)
        : await window.showInputBox({ prompt: t('query.inputPrompt') })

      if (!sql || sql.trim().length === 0) {
        window.showWarningMessage(t('query.empty'))
        return
      }

      const queryContext = await resolveActiveQueryContext()
      if (!queryContext) return

      try {
        const result = await queryService.run(queryContext.profile, {
          sql,
          database: queryContext.scope.database,
          schema: queryContext.scope.schema
        })
        ResultPanel.show(context, t('query.resultTitle', getQueryContextLabel(queryContext)), result)
        await QueryHistoryService.getInstance().add(sql, queryContext.profile, result)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        outputChannel.appendLine(message)
        window.showErrorMessage(t('query.failed', message))
        await QueryHistoryService.getInstance().add(sql, queryContext.profile, error instanceof Error ? error : new Error(message))
      }
    }),
    commands.registerCommand('dbNexus.showQueryHistory', async () => {
      QueryHistoryPanel.show(context)
    }),
    commands.registerCommand('dbNexus.clearQueryHistory', async () => {
      const confirm = await window.showWarningMessage(
        t('history.clearConfirm'),
        { modal: true },
        t('common.delete')
      )
      if (confirm === t('common.delete')) {
        await QueryHistoryService.getInstance().clear()
        window.showInformationMessage(t('history.cleared'))
      }
    }),
    commands.registerCommand('dbNexus.showArchitecture', async () => {
      const uri = Uri.joinPath(context.extensionUri, 'docs', 'architecture.md')
      const document = await workspace.openTextDocument(uri)
      await window.showTextDocument(document)
    }),
    commands.registerCommand('dbNexus.openTable', async (node: SchemaNode | undefined) => {
      await commands.executeCommand('dbNexus.showTableData', node)
    }),
    commands.registerCommand('dbNexus.openTableOnDoubleClick', async (node: SchemaNode | undefined) => {
      if (!node || !isTableLikeNode(node)) {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      if (isListOpenModeDoubleClick()) {
        clearPendingTableOpen()
        await commands.executeCommand('dbNexus.openTable', node)
        return
      }

      const key = getTableOpenKey(node)
      if (pendingTableOpen?.key === key) {
        clearPendingTableOpen()
        await commands.executeCommand('dbNexus.openTable', node)
        return
      }

      clearPendingTableOpen()
      pendingTableOpen = {
        key,
        timer: setTimeout(() => {
          if (pendingTableOpen?.key === key) {
            pendingTableOpen = undefined
          }
        }, 450)
      }
    }),
    commands.registerCommand('dbNexus.showTableSchema', async (node: SchemaNode | undefined) => {
      if (!node || !isTableLikeNode(node)) {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      await showTableSchemaForTarget({
        profile: node.connectionProfile,
        scope: node.scope || {},
        tableName: node.schemaObject.name,
        objectType: node.schemaObject.type,
        rowCount: node.schemaObject.rowCount,
        description: node.schemaObject.description
      })
    }),
    commands.registerCommand('dbNexus.showTableData', async (node: SchemaNode | undefined) => {
      if (!node || !isTableLikeNode(node)) {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      const profile = node.connectionProfile
      const tableName = node.schemaObject.name
      const scope = node.scope || {}
      
      const driver = driverRegistry.getDriver(profile.driverId)
      if (!driver?.getTableData) {
        window.showErrorMessage(t('table.dataNotSupported') || 'Table data not supported for this driver')
        return
      }

      TableDataPanel.show(context, profile, driver, tableName, scope)
    }),
    commands.registerCommand('dbNexus.showTableList', async (node: TablesGroupNode | SchemaNode | undefined) => {
      if (!node) {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      const dbContext = await resolveNodeContext(node)
      if (!dbContext) return

      const profile = dbContext.profile
      const scope = dbContext.scope
      const driver = driverRegistry.getDriver(profile.driverId)

      try {
        const tables = await listTablesForScope(profile, scope)
        TableListPanel.show(context, profile, driver, scope, tables)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('connection.loadError', message))
      }
    }),
    commands.registerCommand('dbNexus.createTable', async (node: TablesGroupNode | SchemaNode | undefined) => {
      const dbContext = await resolveNodeContext(node)
      if (!dbContext) return

      const tableName = await window.showInputBox({
        prompt: t('table.newTableName'),
        value: 'new_table'
      })
      if (!tableName) return

      const schema = buildNewTableDesignSchema(dbContext.profile.driverId, tableName)
      TableSchemaPanel.show(context, t('table.schemaTitle', schema.name), schema, {
        profile: dbContext.profile,
        scope: dbContext.scope,
        objectType: 'table',
        initialTab: 'fields',
        mode: 'create',
        loadedAt: new Date().toISOString()
      })
    }),
    commands.registerCommand('dbNexus.designTable', async (node: SchemaNode | undefined) => {
      await commands.executeCommand('dbNexus.showTableSchema', node)
    }),
    commands.registerCommand('dbNexus.saveTableDesign', async (request: TableDesignSaveRequest): Promise<TableSchema | undefined> => {
      if (!request || request.objectType !== 'table') {
        window.showWarningMessage(t('table.selectTable'))
        return undefined
      }

      const driver = driverRegistry.getDriver(request.profile.driverId)
      if (!driver?.getTableSchema) {
        window.showErrorMessage(t('table.schemaNotSupported'))
        return undefined
      }

      try {
        const sqlStatements = request.mode === 'create'
          ? buildCreateTableDesignSql(request.profile.driverId, request.scope, request.draft)
          : buildAlterTableDesignSql(request.profile.driverId, request.scope, request.originalSchema, request.draft)

        if (sqlStatements.length === 0) {
          window.showInformationMessage(t('table.noPendingChanges'))
          return request.originalSchema
        }

        await window.withProgress(
          { location: ProgressLocation.Notification, title: t('table.savingDesign') },
          async () => {
            for (const sql of sqlStatements) {
              await executeSql(request.profile, sql, request.scope)
            }
          }
        )

        connectionsTreeProvider?.refresh()
        const nextSchema = await driver.getTableSchema!(request.profile, request.draft.tableName, request.scope)
        window.showInformationMessage(t(request.mode === 'create' ? 'table.created' : 'table.designSaved', request.draft.tableName))
        return nextSchema
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t(request.mode === 'create' ? 'table.createTableFailed' : 'table.saveDesignFailed', message))
        return undefined
      }
    }),
    commands.registerCommand('dbNexus.addColumn', async (node: SchemaNode | TableDetailGroupNode | TableTarget | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      if (target.objectType !== 'table') {
        window.showWarningMessage(t('table.onlyTablesCanAddColumn'))
        return
      }

      await showTableSchemaForTarget(target, { initialTab: 'fields' })
    }),
    commands.registerCommand('dbNexus.refreshTable', async (node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      connectionsTreeProvider?.refreshTable(target.profile, target.tableName, target.scope)
      window.showInformationMessage(t('table.refreshed', target.tableName))
    }),
    commands.registerCommand('dbNexus.refreshTableList', () => {
      connectionsTreeProvider?.refresh()
    }),
    commands.registerCommand('dbNexus.closeExpandedDatabaseTree', async (node: ConnectionNode | SchemaNode | TablesGroupNode | undefined) => {
      await closeExpandedDatabaseTree(node)
    }),
    commands.registerCommand('dbNexus.renameTable', async (node: SchemaNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      if (target.objectType !== 'table') {
        window.showWarningMessage(t('table.onlyTablesCanRename'))
        return
      }

      const newName = await window.showInputBox({
        prompt: t('table.renameTableName'),
        value: target.tableName
      })
      if (!newName || newName === target.tableName) return

      try {
        await executeSql(target.profile, buildRenameTableSql(target.profile.driverId, target.scope, target.tableName, newName), target.scope)
        connectionsTreeProvider?.refresh()
        window.showInformationMessage(t('table.renamed', target.tableName, newName))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.renameFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.truncateTable', async (node: SchemaNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      if (target.objectType !== 'table') {
        window.showWarningMessage(t('table.onlyTablesCanTruncate'))
        return
      }

      const confirm = await window.showWarningMessage(
        t('table.truncateConfirm', target.tableName),
        { modal: true },
        t('table.truncate')
      )
      if (confirm !== t('table.truncate')) return

      try {
        await executeSql(target.profile, `TRUNCATE TABLE ${getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)}`, target.scope)
        window.showInformationMessage(t('table.truncated', target.tableName))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.truncateFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.copyTableName', async (node: SchemaNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return
      await env.clipboard.writeText(getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName))
      window.showInformationMessage(t('table.copied'))
    }),
    commands.registerCommand('dbNexus.copySelectSql', async (node: SchemaNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return
      const sql = buildSelectSql(target.profile.driverId, target.scope, target.tableName)
      await env.clipboard.writeText(sql)
      window.showInformationMessage(t('table.copied'))
    }),
    commands.registerCommand('dbNexus.openSelectSql', async (node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      await openSqlDocument(buildSelectTemplate(target.profile.driverId, target.scope, target.tableName), {
        profile: target.profile,
        scope: target.scope
      })
    }),
    commands.registerCommand('dbNexus.openInsertSql', async (node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined) => {
      await openInsertTemplate(node)
    }),
    commands.registerCommand('dbNexus.openUpdateSql', async (node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined) => {
      await openMutationTemplate(node, 'update')
    }),
    commands.registerCommand('dbNexus.openDeleteSql', async (node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined) => {
      await openMutationTemplate(node, 'delete')
    }),
    commands.registerCommand('dbNexus.countRows', async (node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      const sql = `SELECT COUNT(*) AS row_count FROM ${getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)};`

      try {
        const result = await executeSql(target.profile, sql, target.scope)
        ResultPanel.show(context, t('query.resultTitle', `${target.profile.name} / ${target.tableName}`), result)
        await QueryHistoryService.getInstance().add(sql, target.profile, result)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        outputChannel.appendLine(message)
        window.showErrorMessage(t('query.failed', message))
        await QueryHistoryService.getInstance().add(sql, target.profile, error instanceof Error ? error : new Error(message))
      }
    }),
    commands.registerCommand('dbNexus.renameColumn', async (node: FieldNode | undefined) => {
      const target = await resolveFieldTarget(node)
      if (!target) return

      const newName = await window.showInputBox({
        prompt: t('table.renameColumnName'),
        value: target.columnName
      })
      if (!newName || newName === target.columnName) return

      const qualifiedName = getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)
      const sql = buildRenameColumnSql(target.profile.driverId, qualifiedName, target.columnName, newName, target.columnType)

      try {
        await executeSql(target.profile, sql, target.scope)
        connectionsTreeProvider?.refreshTable(target.profile, target.tableName, target.scope)
        window.showInformationMessage(t('table.columnRenamed', target.columnName, newName))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.renameColumnFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.dropColumn', async (node: FieldNode | FieldTarget | undefined) => {
      const target = await resolveFieldTarget(node)
      if (!target) return

      const confirm = await window.showWarningMessage(
        t('table.dropColumnConfirm', target.columnName, target.tableName),
        { modal: true },
        t('common.delete')
      )
      if (confirm !== t('common.delete')) return

      try {
        const qualifiedName = getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)
        await executeSql(target.profile, `ALTER TABLE ${qualifiedName} DROP COLUMN ${quoteSqlIdentifier(target.profile.driverId, target.columnName)}`, target.scope)
        connectionsTreeProvider?.refreshTable(target.profile, target.tableName, target.scope)
        window.showInformationMessage(t('table.columnDropped', target.columnName))
        await showTableSchemaForTarget({
          profile: target.profile,
          scope: target.scope,
          tableName: target.tableName,
          objectType: 'table'
        }, { initialTab: 'fields' })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.dropColumnFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.copyColumnName', async (node: FieldNode | undefined) => {
      const target = await resolveFieldTarget(node)
      if (!target) return
      await env.clipboard.writeText(quoteSqlIdentifier(target.profile.driverId, target.columnName))
      window.showInformationMessage(t('table.copied'))
    }),
    commands.registerCommand('dbNexus.modifyIndex', async (node: IndexNode | undefined) => {
      if (!node) {
        window.showWarningMessage(t('table.selectIndex'))
        return
      }

      await showTableSchemaForTarget({
        profile: node.connectionProfile,
        scope: node.scope || {},
        tableName: node.tableName,
        objectType: 'table'
      }, {
        initialTab: 'indexes',
        selectedIndexName: node.index.name
      })
    }),
    commands.registerCommand('dbNexus.createIndex', async (node: SchemaNode | TableDetailGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      if (target.objectType !== 'table') {
        window.showWarningMessage(t('table.onlyTablesCanCreateIndex'))
        return
      }

      await showTableSchemaForTarget(target, { initialTab: 'indexes' })
    }),
    commands.registerCommand('dbNexus.dropIndex', async (node: IndexNode | undefined) => {
      if (!node) {
        window.showWarningMessage(t('table.selectIndex'))
        return
      }

      const confirm = await window.showWarningMessage(
        t('table.dropIndexConfirm', node.index.name),
        { modal: true },
        t('common.delete')
      )
      if (confirm !== t('common.delete')) return

      try {
        await executeSql(node.connectionProfile, buildDropIndexSql(node.connectionProfile.driverId, node.scope, node.tableName, node.index.name), node.scope)
        connectionsTreeProvider?.refreshTable(node.connectionProfile, node.tableName, node.scope)
        window.showInformationMessage(t('table.indexDropped', node.index.name))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.dropIndexFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.copyIndexName', async (node: IndexNode | undefined) => {
      if (!node) {
        window.showWarningMessage(t('table.selectIndex'))
        return
      }
      await env.clipboard.writeText(quoteSqlIdentifier(node.connectionProfile.driverId, node.index.name))
      window.showInformationMessage(t('table.copied'))
    }),
    commands.registerCommand('dbNexus.deleteTable', async (node: SchemaNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      const confirm = await window.showWarningMessage(
        t('table.deleteConfirm', target.tableName),
        { modal: true },
        t('common.delete')
      )
      if (confirm !== t('common.delete')) return

      try {
        const objectKind = target.objectType === 'view' || target.objectType === 'materializedView'
          ? target.objectType === 'materializedView' ? 'MATERIALIZED VIEW' : 'VIEW'
          : 'TABLE'
        const qualifiedName = getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)
        await executeSql(target.profile, `DROP ${objectKind} ${qualifiedName}`, target.scope)
        connectionsTreeProvider?.refresh()
        window.showInformationMessage(t('table.deleted', target.tableName))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.deleteFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.importWizard', async (node: SchemaNode | TablesGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      const format = await window.showQuickPick(
        [
          { label: 'CSV', value: 'csv' as const },
          { label: 'JSON', value: 'json' as const }
        ],
        { placeHolder: t('table.importWizard') }
      )
      if (!format) return

      await importTable(target, format.value)
    }),
    commands.registerCommand('dbNexus.exportWizard', async (node: SchemaNode | TablesGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      const format = await window.showQuickPick(
        [
          { label: 'CSV', value: 'csv' as const },
          { label: 'JSON', value: 'json' as const },
          { label: 'SQL', value: 'sql' as const }
        ],
        { placeHolder: t('table.exportWizard') }
      )
      if (!format) return

      await exportTable(target, format.value)
    }),
    commands.registerCommand('dbNexus.showDataDictionary', async (node: SchemaNode | TablesGroupNode | undefined) => {
      try {
        await showDataDictionary(node)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.schemaFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.generateData', async (
      node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | TableTarget | undefined
    ) => {
      await openMockDataTemplate(node)
    }),
    commands.registerCommand('dbNexus.createQueryFile', async (node: SchemaNode | TableDetailGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      const fileName = await window.showInputBox({
        prompt: t('table.newQueryFileName'),
        value: `${target.tableName}.sql`,
        validateInput: value => value.trim().length > 0 ? undefined : t('query.empty')
      })
      if (!fileName) return

      try {
        const content = buildSelectTemplate(target.profile.driverId, target.scope, target.tableName)
        const file = await queryFileService.create(
          target.profile,
          target.tableName,
          target.scope,
          fileName,
          content
        )
        bindSqlDocumentContext(file.uri, {
          profile: target.profile,
          scope: target.scope,
          label: `${target.profile.name} / ${file.name}`
        })
        SqlEditorPanel.show(context, connectionService, driverRegistry, queryService, {
          sql: content,
          profile: target.profile,
          scope: target.scope,
          title: file.name,
          uri: file.uri
        })
        connectionsTreeProvider?.refreshTable(target.profile, target.tableName, target.scope)
        window.showInformationMessage(t('table.queryFileCreated', file.name))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.queryFileFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.addQueryFile', async (node: SchemaNode | TableDetailGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      const uris = await window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        filters: {
          'SQL Files': ['sql']
        }
      })
      if (!uris || uris.length === 0) return

      try {
        const files = []
        for (const uri of uris) {
          files.push(await queryFileService.importFile(target.profile, target.tableName, target.scope, uri))
        }
        connectionsTreeProvider?.refreshTable(target.profile, target.tableName, target.scope)
        window.showInformationMessage(
          files.length === 1
            ? t('table.queryFileAdded', files[0].name)
            : t('table.queryFilesAdded', files.length)
        )
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.queryFileFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.openQueryFile', async (node: QueryFileNode | undefined) => {
      if (!node) return
      const sql = new TextDecoder().decode(await workspace.fs.readFile(node.uri))
      bindSqlDocumentContext(node.uri, {
        profile: node.connectionProfile,
        scope: node.scope,
        label: `${node.connectionProfile.name} / ${node.fileName}`
      })
      SqlEditorPanel.show(context, connectionService, driverRegistry, queryService, {
        sql,
        profile: node.connectionProfile,
        scope: node.scope,
        title: node.fileName,
        uri: node.uri
      })
    }),
    commands.registerCommand('dbNexus.deleteQueryFile', async (node: QueryFileNode | undefined) => {
      if (!node) return

      const confirm = await window.showWarningMessage(
        t('table.deleteQueryFileConfirm', node.fileName),
        { modal: true },
        t('common.delete')
      )
      if (confirm !== t('common.delete')) return

      try {
        await queryFileService.delete(node.uri)
        connectionsTreeProvider?.refreshTable(node.connectionProfile, node.tableName, node.scope)
        window.showInformationMessage(t('table.queryFileDeleted', node.fileName))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.queryFileFailed', message))
      }
    }),
    commands.registerCommand('dbNexus.runSqlFile', async (node: ConnectionNode | SchemaNode | TablesGroupNode | QueryFileNode | undefined) => {
      if (node instanceof QueryFileNode) {
        await runSqlFileUri(node.connectionProfile, node.scope, node.uri, `${node.connectionProfile.name} / ${node.fileName}`)
        return
      }

      const dbContext = await resolveNodeContext(node)
      if (!dbContext) return

      const uris = await window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'SQL Files': ['sql']
        }
      })
      if (!uris || uris.length === 0) return

      await runSqlFileUri(dbContext.profile, dbContext.scope, uris[0])
    }),
    commands.registerCommand('dbNexus.searchDatabase', async (node: ConnectionNode | SchemaNode | TablesGroupNode | undefined) => {
      const dbContext = await resolveNodeContext(node)
      if (!dbContext) return

      const keyword = await window.showInputBox({
        prompt: t('table.searchDatabase'),
        placeHolder: t('table.searchTables')
      })
      if (!keyword) return

      try {
        const objects = await connectionService.listObjects(dbContext.profile, dbContext.scope)
        const matches = objects.filter(object => object.name.toLowerCase().includes(keyword.toLowerCase()))
        if (matches.length === 0) {
          window.showInformationMessage(t('table.noMatches'))
          return
        }

        const picked = await window.showQuickPick(
          matches.map(object => ({
            label: object.name,
            description: object.type,
            object
          })),
          { placeHolder: t('table.searchDatabase') }
        )
        if (!picked || !isTableLikeObject(picked.object)) return

        TableDataPanel.show(
          context,
          dbContext.profile,
          driverRegistry.getDriver(dbContext.profile.driverId),
          picked.object.name,
          dbContext.scope
        )
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('connection.loadError', message))
      }
    }),
    commands.registerCommand('dbNexus.createGroup', async () => {
      window.showInformationMessage(t('table.groupNotSupported'))
    }),
    commands.registerCommand('dbNexus.pasteIntoDatabase', async () => {
      window.showInformationMessage(t('table.pasteNotSupported'))
    }),
    commands.registerCommand('dbNexus.showExecutionPlan', async () => {
      const editor = window.activeTextEditor
      const sql = editor
        ? editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection)
        : await window.showInputBox({ prompt: t('query.inputPrompt') })

      if (!sql || sql.trim().length === 0) {
        window.showWarningMessage(t('query.empty'))
        return
      }

      const queryContext = await resolveActiveQueryContext()
      if (!queryContext) return

      const driver = driverRegistry.getDriver(queryContext.profile.driverId)
      if (!driver?.getExecutionPlan) {
        window.showErrorMessage(t('executionPlan.notSupported'))
        return
      }

      try {
        const plan = await driver.getExecutionPlan(queryContext.profile, sql, queryContext.scope)
        ExecutionPlanPanel.show(context, plan, sql)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('executionPlan.failed', message))
      }
    }),
    commands.registerCommand('dbNexus.showDDL', async (node: SchemaNode | undefined) => {
      if (!node) {
        window.showWarningMessage(t('ddl.selectObject'))
        return
      }

      const profile = node.connectionProfile
      const driver = driverRegistry.getDriver(profile.driverId)
      if (!driver?.getDDL) {
        window.showErrorMessage(t('ddl.notSupported'))
        return
      }

      const objectName = node.schemaObject.name
      const objectType = node.schemaObject.type as 'table' | 'view' | 'index' | 'trigger' | 'procedure' | 'function'
      const scope = node.scope || {}

      try {
        const ddl = await driver.getDDL(profile, objectName, objectType, scope)
        const document = await workspace.openTextDocument({
          language: 'sql',
          content: ddl
        })
        await window.showTextDocument(document)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('ddl.failed', message))
      }
    }),
    commands.registerCommand('dbNexus.exportToCSV', async (node: SchemaNode | undefined) => {
      if (!node || node.schemaObject.type !== 'table') {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      const profile = node.connectionProfile
      const tableName = node.schemaObject.name
      const scope = node.scope || {}
      
      let qualifiedName = tableName
      if (scope.database) {
        qualifiedName = `${scope.database}.${tableName}`
      }

      try {
        const result = await queryService.run(profile, { 
          sql: `SELECT * FROM ${qualifiedName}` 
        })
        await DataExportService.exportToCSV(result, tableName)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('export.failed', message))
      }
    }),
    commands.registerCommand('dbNexus.exportToJSON', async (node: SchemaNode | undefined) => {
      if (!node || node.schemaObject.type !== 'table') {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      const profile = node.connectionProfile
      const tableName = node.schemaObject.name
      const scope = node.scope || {}
      
      let qualifiedName = tableName
      if (scope.database) {
        qualifiedName = `${scope.database}.${tableName}`
      }

      try {
        const result = await queryService.run(profile, { 
          sql: `SELECT * FROM ${qualifiedName}` 
        })
        await DataExportService.exportToJSON(result, tableName)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('export.failed', message))
      }
    }),
    commands.registerCommand('dbNexus.exportToSQL', async (node: SchemaNode | undefined) => {
      if (!node || node.schemaObject.type !== 'table') {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      const profile = node.connectionProfile
      const tableName = node.schemaObject.name
      const scope = node.scope || {}
      
      let qualifiedName = tableName
      if (scope.database) {
        qualifiedName = `${scope.database}.${tableName}`
      }

      try {
        const result = await queryService.run(profile, { 
          sql: `SELECT * FROM ${qualifiedName}` 
        })
        await DataExportService.exportToSQL(result, tableName, `${tableName}_insert`)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('export.failed', message))
      }
    }),
    commands.registerCommand('dbNexus.importFromCSV', async (node: SchemaNode | undefined) => {
      if (!node || node.schemaObject.type !== 'table') {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      const profile = node.connectionProfile
      const tableName = node.schemaObject.name
      const scope = node.scope || {}
      const driver = driverRegistry.getDriver(profile.driverId)

      if (!driver?.planInsert || !driver?.executeMutation) {
        window.showErrorMessage(t('import.notSupported'))
        return
      }

      try {
        const rows = await DataExportService.importFromCSV()
        if (!rows || rows.length === 0) return

        let inserted = 0
        for (const row of rows) {
          const plan = await driver.planInsert(profile, tableName, row, scope)
          const result = await driver.executeMutation(profile, plan)
          if (result.success) {
            inserted++
          }
        }

        window.showInformationMessage(t('import.success', String(inserted)))
        connectionsTreeProvider?.refresh()
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('import.failed', message))
      }
    }),
    commands.registerCommand('dbNexus.importFromJSON', async (node: SchemaNode | undefined) => {
      if (!node || node.schemaObject.type !== 'table') {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      const profile = node.connectionProfile
      const tableName = node.schemaObject.name
      const scope = node.scope || {}
      const driver = driverRegistry.getDriver(profile.driverId)

      if (!driver?.planInsert || !driver?.executeMutation) {
        window.showErrorMessage(t('import.notSupported'))
        return
      }

      try {
        const rows = await DataExportService.importFromJSON()
        if (!rows || rows.length === 0) return

        let inserted = 0
        for (const row of rows) {
          const plan = await driver.planInsert(profile, tableName, row, scope)
          const result = await driver.executeMutation(profile, plan)
          if (result.success) {
            inserted++
          }
        }

        window.showInformationMessage(t('import.success', String(inserted)))
        connectionsTreeProvider?.refresh()
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('import.failed', message))
      }
    }),
    commands.registerCommand('dbNexus.showERDiagram', async (node: SchemaNode | undefined) => {
      const profile = node?.connectionProfile || await pickConnection(connectionService.getConnections())
      if (!profile) return

      const driver = driverRegistry.getDriver(profile.driverId)
      if (!driver?.getTableSchema) {
        window.showErrorMessage(t('erd.notSupported'))
        return
      }

      const scope = node?.scope || {}
      await ERDiagramPanel.show(context, profile, driver, scope)
    }),
    commands.registerCommand('dbNexus.backupDatabase', async (node: ConnectionNode | undefined) => {
      const profile = node?.profile || await pickConnection(connectionService.getConnections())
      if (!profile) return

      const driver = driverRegistry.getDriver(profile.driverId)
      if (!driver?.capabilities.backupRestore) {
        window.showErrorMessage(t('backup.notSupported'))
        return
      }

      const includeData = await window.showQuickPick(
        [
          { label: t('backup.schemaAndData'), value: { includeSchema: true, includeData: true } },
          { label: t('backup.schemaOnly'), value: { includeSchema: true, includeData: false } },
          { label: t('backup.dataOnly'), value: { includeSchema: false, includeData: true } }
        ],
        { placeHolder: t('backup.selectContent') }
      )
      if (!includeData) return

      const format = await window.showQuickPick(
        [
          { label: 'SQL', value: 'sql' as const },
          { label: 'JSON', value: 'json' as const }
        ],
        { placeHolder: t('backup.selectFormat') }
      )
      if (!format) return

      const options: BackupOptions = {
        ...includeData.value,
        format: format.value
      }

      await BackupRestoreService.backupDatabase(profile, driver, {}, options)
    }),
    commands.registerCommand('dbNexus.restoreDatabase', async (node: ConnectionNode | undefined) => {
      const profile = node?.profile || await pickConnection(connectionService.getConnections())
      if (!profile) return

      const driver = driverRegistry.getDriver(profile.driverId)
      if (!driver?.capabilities.backupRestore) {
        window.showErrorMessage(t('restore.notSupported'))
        return
      }

      const format = await window.showQuickPick(
        [
          { label: 'SQL', value: 'sql' as const },
          { label: 'JSON', value: 'json' as const }
        ],
        { placeHolder: t('restore.selectFormat') }
      )
      if (!format) return

      const dropExisting = await window.showQuickPick(
        [
          { label: t('restore.dropExisting'), value: true },
          { label: t('restore.keepExisting'), value: false }
        ],
        { placeHolder: t('restore.selectOption') }
      )
      if (dropExisting === undefined) return

      const options: RestoreOptions = {
        format: format.value,
        dropExisting: dropExisting.value
      }

      await BackupRestoreService.restoreDatabase(profile, driver, {}, options)
    }),
    commands.registerCommand('dbNexus.compareSchemas', async () => {
      const connections = connectionService.getConnections()
      if (connections.length < 2) {
        window.showErrorMessage(t('compare.needTwoConnections'))
        return
      }

      const sourcePick = await window.showQuickPick(
        connections.map(c => ({ label: c.name, profile: c })),
        { placeHolder: t('compare.selectSource') }
      )
      if (!sourcePick) return

      const targetConnections = connections.filter(c => c.id !== sourcePick.profile.id)
      const targetPick = await window.showQuickPick(
        targetConnections.map(c => ({ label: c.name, profile: c })),
        { placeHolder: t('compare.selectTarget') }
      )
      if (!targetPick) return

      const sourceDriver = driverRegistry.getDriver(sourcePick.profile.driverId)
      const targetDriver = driverRegistry.getDriver(targetPick.profile.driverId)

      await SchemaComparePanel.show(context, sourcePick.profile, sourceDriver, targetPick.profile, targetDriver)
    }),
    commands.registerCommand('dbNexus.migrateData', async () => {
      const connections = connectionService.getConnections()
      if (connections.length < 2) {
        window.showErrorMessage(t('migration.needTwoConnections'))
        return
      }

      const sourcePick = await window.showQuickPick(
        connections.map(c => ({ label: c.name, profile: c })),
        { placeHolder: t('migration.selectSource') }
      )
      if (!sourcePick) return

      const targetConnections = connections.filter(c => c.id !== sourcePick.profile.id)
      const targetPick = await window.showQuickPick(
        targetConnections.map(c => ({ label: c.name, profile: c })),
        { placeHolder: t('migration.selectTarget') }
      )
      if (!targetPick) return

      const contentPick = await window.showQuickPick(
        [
          { label: t('migration.schemaAndData'), value: { includeSchema: true, includeData: true } },
          { label: t('migration.schemaOnly'), value: { includeSchema: true, includeData: false } },
          { label: t('migration.dataOnly'), value: { includeSchema: false, includeData: true } }
        ],
        { placeHolder: t('migration.selectContent') }
      )
      if (!contentPick) return

      const dropExisting = await window.showQuickPick(
        [
          { label: t('migration.dropExisting'), value: true },
          { label: t('migration.keepExisting'), value: false }
        ],
        { placeHolder: t('migration.selectOption') }
      )
      if (dropExisting === undefined) return

      const batchSize = await window.showInputBox({
        prompt: t('migration.batchSizePrompt'),
        value: '1000',
        validateInput: (value) => {
          const num = parseInt(value, 10)
          if (isNaN(num) || num <= 0) {
            return t('migration.invalidBatchSize')
          }
          return undefined
        }
      })
      if (!batchSize) return

      const options: MigrationOptions = {
        ...contentPick.value,
        dropExisting: dropExisting.value,
        batchSize: parseInt(batchSize, 10)
      }

      const sourceDriver = driverRegistry.getDriver(sourcePick.profile.driverId)
      const targetDriver = driverRegistry.getDriver(targetPick.profile.driverId)

      await DataMigrationService.migrateData(
        sourcePick.profile,
        sourceDriver,
        targetPick.profile,
        targetDriver,
        options
      )
    }),
    workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('dbNexus.displayLanguage')) {
        reloadI18n()
        connectionsTreeProvider?.refresh()
        window.showInformationMessage(t('i18n.languageChanged', getCurrentLanguage()))
      }
    })
  )
}

export function deactivate(): void {
  connectionsTreeProvider = undefined
}

interface ConnectionPromptResult {
  profile: Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>
  password?: string
}

async function promptForConnection(existing?: DbConnectionProfile): Promise<ConnectionPromptResult | undefined> {
  const driver = await window.showQuickPick(
    SUPPORTED_DRIVERS.map(item => ({
      label: item.displayName,
      description: item.implemented ? t('driver.statusAvailable') : t('driver.statusPlanned'),
      detail: item.id,
      id: item.id,
      defaultPort: item.defaultPort
    })),
    {
      placeHolder: t('driver.selectType')
    }
  )
  if (!driver) return undefined

  const name = await window.showInputBox({
    prompt: t('form.connectionName'),
    value: existing?.name || driver.label
  })
  if (!name) return undefined

  if (driver.id === 'sqlite' || driver.id === 'duckdb' || isFileDriver(driver.id)) {
    const filePath = await window.showInputBox({
      prompt: t('form.filePath'),
      value: existing?.filePath || '',
      placeHolder: 'C:\\path\\to\\database.sqlite'
    })
    if (!filePath) return undefined
    return {
      profile: {
        name,
        driverId: driver.id,
        filePath,
        ssl: false
      }
    }
  }

  const host = await window.showInputBox({
    prompt: t('form.host'),
    value: existing?.host || 'localhost'
  })
  if (!host) return undefined

  const portText = await window.showInputBox({
    prompt: t('form.port'),
    value: existing?.port ? String(existing.port) : (driver.defaultPort ? String(driver.defaultPort) : '')
  })
  const port = portText ? Number(portText) : undefined

  const database = await window.showInputBox({
    prompt: t('form.database'),
    value: existing?.database || ''
  })

  const username = await window.showInputBox({
    prompt: t('form.username'),
    value: existing?.username || ''
  })

  const password = await window.showInputBox({
    prompt: t('form.password'),
    password: true
  })

  const sslChoice = await window.showQuickPick(
    [t('form.sslDisabled'), t('form.sslEnabled')],
    { placeHolder: t('form.sslPrompt') }
  )
  const ssl = sslChoice === t('form.sslEnabled')

  const profile: Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'> = {
    name,
    driverId: driver.id,
    host,
    port: Number.isFinite(port) ? port : undefined,
    database: database || undefined,
    username: username || undefined,
    ssl
  }

  const testNow = await window.showQuickPick(
    [t('form.testAndSave'), t('form.saveOnly')],
    { placeHolder: t('form.testPrompt') }
  )

  if (testNow === t('form.testAndSave')) {
    const testProfile: DbConnectionProfile = {
      ...profile,
      id: 'temp',
      createdAt: '',
      updatedAt: ''
    }
    const secretService = SecretService.getInstance()
    if (password) {
      await secretService.storePassword('temp', password)
    }
    try {
      const driverRegistry = new DriverRegistry()
      const result = await driverRegistry.getDriver(profile.driverId).testConnection(testProfile)
      await secretService.deletePassword('temp')
      if (!result.ok) {
        window.showErrorMessage(t('connection.testFailed', result.message))
        return undefined
      }
      window.showInformationMessage(t('connection.testSuccess', result.latencyMs || 0))
    } catch (error) {
      await secretService.deletePassword('temp')
      throw error
    }
  }

  return { profile, password }
}

async function pickConnection(profiles: DbConnectionProfile[]): Promise<DbConnectionProfile | undefined> {
  if (profiles.length === 0) {
    window.showWarningMessage(t('connection.none'))
    return undefined
  }

  const picked = await window.showQuickPick(
    profiles.map(profile => ({
      label: profile.name,
      description: profile.driverId,
      id: profile.id
    })),
    {
      placeHolder: t('connection.select')
    }
  )

  return picked ? profiles.find(profile => profile.id === picked.id) : undefined
}

function isFileDriver(driverId: DatabaseDriverId): boolean {
  return ['csv', 'excel', 'json', 'parquet', 'avro'].includes(driverId)
}

function isTableTarget(value: unknown): value is TableTarget {
  if (!value || typeof value !== 'object') {
    return false
  }

  const target = value as Partial<TableTarget>
  return !!target.profile
    && typeof target.tableName === 'string'
    && !!target.scope
    && typeof target.objectType === 'string'
}

function isFieldTarget(value: unknown): value is FieldTarget {
  if (!value || typeof value !== 'object') {
    return false
  }

  const target = value as Partial<FieldTarget>
  return !!target.profile
    && !!target.scope
    && typeof target.tableName === 'string'
    && typeof target.columnName === 'string'
    && typeof target.columnType === 'string'
}

function isTableLikeNode(node: SchemaNode): boolean {
  return node.schemaObject.type === 'table'
    || node.schemaObject.type === 'view'
    || node.schemaObject.type === 'materializedView'
}

function isTableLikeObject(object: SchemaObject): boolean {
  return object.type === 'table'
    || object.type === 'view'
    || object.type === 'materializedView'
}

function getQualifiedObjectName(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  objectName: string
): string {
  const parts: string[] = []

  if (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'clickhouse') {
    if (scope.database) {
      parts.push(scope.database)
    }
  } else if (driverId === 'postgresql' || driverId === 'cockroachdb' || driverId === 'duckdb') {
    if (scope.schema) {
      parts.push(scope.schema)
    }
  } else if (driverId !== 'sqlite') {
    if (scope.schema) {
      parts.push(scope.schema)
    } else if (scope.database) {
      parts.push(scope.database)
    }
  }

  parts.push(objectName)
  return parts.map(part => quoteSqlIdentifier(driverId, part)).join('.')
}

function quoteSqlIdentifier(driverId: DatabaseDriverId, identifier: string): string {
  const text = String(identifier)
  if (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'clickhouse') {
    return `\`${text.replace(/`/g, '``')}\``
  }
  return `"${text.replace(/"/g, '""')}"`
}

function buildInsertTemplate(
  driverId: DatabaseDriverId,
  qualifiedName: string,
  columns: TableSchema['columns']
): string {
  if (columns.length === 0) {
    return `INSERT INTO ${qualifiedName} DEFAULT VALUES;\n`
  }

  const columnList = columns
    .map(column => `  ${quoteSqlIdentifier(driverId, column.name)}`)
    .join(',\n')
  const valueList = columns
    .map(column => `  ${sampleSqlValue(column.type, column.nullable)}`)
    .join(',\n')

  return [
    `INSERT INTO ${qualifiedName} (`,
    columnList,
    ') VALUES (',
    valueList,
    ');',
    ''
  ].join('\n')
}

interface ColumnIndexHint {
  primary: boolean
  unique: boolean
  indexed: boolean
  leading: boolean
  composite: boolean
  indexNames: string[]
}

function buildMockInsertTemplate(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  tableName: string,
  schema: TableSchema,
  rowCount: number
): string {
  const qualifiedName = getQualifiedObjectName(driverId, scope, tableName)
  const writableColumns = schema.columns.filter(column => !column.isAutoIncrement)
  const indexHints = buildColumnIndexHints(schema)
  const header = buildMockHeader(schema, rowCount, writableColumns)

  if (writableColumns.length === 0) {
    return [
      header,
      ...Array.from({ length: rowCount }, () => `INSERT INTO ${qualifiedName} DEFAULT VALUES;`),
      ''
    ].join('\n')
  }

  const columnList = writableColumns
    .map(column => `  ${quoteSqlIdentifier(driverId, column.name)}`)
    .join(',\n')
  const values = Array.from({ length: rowCount }, (_, rowIndex) => {
    const rowValues = writableColumns.map(column => {
      const hint = indexHints.get(column.name) || createEmptyIndexHint()
      return mockSqlValue(column, hint, rowIndex, schema, rowCount)
    })
    return `  (${rowValues.join(', ')})`
  })

  return [
    header,
    `INSERT INTO ${qualifiedName} (`,
    columnList,
    ') VALUES',
    `${values.join(',\n')};`,
    ''
  ].join('\n')
}

function buildMockHeader(
  schema: TableSchema,
  rowCount: number,
  writableColumns: TableSchema['columns']
): string {
  const skippedColumns = schema.columns
    .filter(column => column.isAutoIncrement)
    .map(column => column.name)
  const indexLines = schema.indexes.length > 0
    ? schema.indexes.map(index => {
        const kind = index.isPrimary ? 'PRIMARY' : index.isUnique ? 'UNIQUE' : 'INDEX'
        return `-- ${kind} ${index.name}: ${index.columns.join(', ')}`
      })
    : ['-- No indexes detected; values are generated from column names and data types.']

  return [
    `-- DB Nexus mock data for ${schema.name}`,
    `-- Rows: ${rowCount}`,
    `-- Writable columns: ${writableColumns.map(column => column.name).join(', ') || 'DEFAULT VALUES'}`,
    skippedColumns.length > 0 ? `-- Skipped auto-increment columns: ${skippedColumns.join(', ')}` : '',
    '-- Index-aware generation:',
    '-- Primary and unique index columns receive unique values; ordinary index columns use repeatable low-cardinality values.',
    ...indexLines,
    ''
  ].filter(Boolean).join('\n')
}

function buildColumnIndexHints(schema: TableSchema): Map<string, ColumnIndexHint> {
  const hints = new Map<string, ColumnIndexHint>()

  for (const column of schema.columns) {
    if (column.isPrimaryKey) {
      const hint = getColumnIndexHint(hints, column.name)
      hint.primary = true
      hint.unique = true
      hint.indexed = true
      hint.leading = true
    }
  }

  for (const index of schema.indexes) {
    index.columns.forEach((columnName, columnIndex) => {
      const hint = getColumnIndexHint(hints, columnName)
      hint.indexed = true
      hint.leading = hint.leading || columnIndex === 0
      hint.composite = hint.composite || index.columns.length > 1
      hint.primary = hint.primary || index.isPrimary
      hint.unique = hint.unique || index.isUnique || index.isPrimary
      hint.indexNames.push(index.name)
    })
  }

  return hints
}

function getColumnIndexHint(hints: Map<string, ColumnIndexHint>, columnName: string): ColumnIndexHint {
  if (!hints.has(columnName)) {
    hints.set(columnName, createEmptyIndexHint())
  }
  return hints.get(columnName)!
}

function createEmptyIndexHint(): ColumnIndexHint {
  return {
    primary: false,
    unique: false,
    indexed: false,
    leading: false,
    composite: false,
    indexNames: []
  }
}

function mockSqlValue(
  column: TableSchema['columns'][number],
  hint: ColumnIndexHint,
  rowIndex: number,
  schema: TableSchema,
  rowCount: number
): string {
  if (column.nullable && !hint.indexed && rowIndex % 11 === 10) {
    return 'NULL'
  }

  const type = column.type.toLowerCase()
  const name = column.name.toLowerCase()
  const baseNumber = getMockBaseNumber(schema)
  const sequence = baseNumber + rowIndex
  const groupNumber = (rowIndex % Math.min(Math.max(rowCount, 1), 5)) + 1
  const unique = hint.primary || hint.unique

  if (isBooleanType(type) || name.startsWith('is_') || name.startsWith('has_')) {
    return rowIndex % 2 === 0 ? 'TRUE' : 'FALSE'
  }

  if (isDateTimeType(type) || /(^|_)(created|updated|deleted|logged|modified)_?at$/.test(name)) {
    return sqlString(buildMockDateTime(rowIndex))
  }

  if (isDateType(type) || name.endsWith('_date') || name === 'date') {
    return sqlString(buildMockDate(rowIndex))
  }

  if (isTimeType(type)) {
    return sqlString(`${String(8 + (rowIndex % 10)).padStart(2, '0')}:30:00`)
  }

  if (isJsonType(type)) {
    return sqlString(JSON.stringify({ mock: true, row: sequence }))
  }

  if (isNumericType(type) || name === 'id' || name.endsWith('_id')) {
    return mockNumericValue(type, name, sequence, groupNumber, hint, unique)
  }

  if (isUuidType(type, name)) {
    return sqlString(buildMockUuid(sequence))
  }

  if (isBinaryType(type)) {
    return column.nullable ? 'NULL' : sqlString(`mock_${sequence}`)
  }

  return sqlString(mockTextValue(name, sequence, groupNumber, hint, unique))
}

function mockNumericValue(
  type: string,
  name: string,
  sequence: number,
  groupNumber: number,
  hint: ColumnIndexHint,
  unique: boolean
): string {
  if (unique || hint.primary || name === 'id') {
    return String(sequence)
  }

  if (hint.indexed) {
    return String(groupNumber)
  }

  if (/(price|amount|total|balance|cost|salary|rate|ratio)/.test(name) || /(decimal|numeric|float|double|real)/.test(type)) {
    return (19.9 + sequence * 1.37).toFixed(2)
  }

  if (/(count|qty|quantity|stock|age|score|level)/.test(name)) {
    return String((sequence % 90) + 1)
  }

  return String(sequence)
}

function mockTextValue(
  name: string,
  sequence: number,
  groupNumber: number,
  hint: ColumnIndexHint,
  unique: boolean
): string {
  if (name.includes('email')) {
    return `user${sequence}@example.com`
  }
  if (name.includes('phone') || name.includes('mobile')) {
    return `1380000${String(sequence % 10000).padStart(4, '0')}`
  }
  if (name.includes('url') || name.includes('website')) {
    return `https://example.com/mock/${sequence}`
  }
  if (name.includes('status') || name.includes('state')) {
    return ['active', 'pending', 'disabled', 'archived', 'draft'][groupNumber - 1]
  }
  if (name.includes('type') || name.includes('category') || name.includes('kind')) {
    return ['standard', 'premium', 'internal', 'external', 'trial'][groupNumber - 1]
  }
  if (name.includes('code') || name.includes('sku')) {
    return unique ? `MOCK-${sequence}` : `MOCK-G${groupNumber}`
  }
  if (name.includes('first_name')) {
    return ['Alex', 'Sam', 'Taylor', 'Jordan', 'Casey'][groupNumber - 1]
  }
  if (name.includes('last_name')) {
    return ['Chen', 'Wang', 'Li', 'Zhang', 'Liu'][groupNumber - 1]
  }
  if (name === 'name' || name.endsWith('_name') || name.includes('title')) {
    return unique ? `Mock ${toTitleToken(name)} ${sequence}` : `Mock ${toTitleToken(name)} ${groupNumber}`
  }
  if (name.includes('city')) {
    return ['Shanghai', 'Beijing', 'Shenzhen', 'Hangzhou', 'Chengdu'][groupNumber - 1]
  }
  if (name.includes('country')) {
    return ['CN', 'US', 'JP', 'SG', 'DE'][groupNumber - 1]
  }
  if (name.includes('address')) {
    return `Mock Road ${sequence}`
  }
  if (name.includes('note') || name.includes('comment') || name.includes('description')) {
    return `Mock ${toTitleToken(name)} for row ${sequence}`
  }

  if (hint.indexed && !unique) {
    return `${toSnakeToken(name)}_${groupNumber}`
  }

  return unique ? `${toSnakeToken(name)}_${sequence}` : `${toSnakeToken(name)} sample ${sequence}`
}

function getMockBaseNumber(schema: TableSchema): number {
  const rowCount = Number(schema.metadata?.tableRows)
  return Number.isFinite(rowCount) && rowCount >= 0 ? Math.floor(rowCount) + 1 : 1
}

function isNumericType(type: string): boolean {
  return /(int|serial|number|numeric|decimal|float|double|real)/.test(type)
}

function isBooleanType(type: string): boolean {
  return /(bool|boolean|bit\(1\))/.test(type)
}

function isDateTimeType(type: string): boolean {
  return /(timestamp|datetime)/.test(type)
}

function isDateType(type: string): boolean {
  return /\bdate\b/.test(type) && !isDateTimeType(type)
}

function isTimeType(type: string): boolean {
  return /\btime\b/.test(type) && !isDateTimeType(type)
}

function isJsonType(type: string): boolean {
  return /json/.test(type)
}

function isBinaryType(type: string): boolean {
  return /(blob|binary|bytea|varbinary)/.test(type)
}

function isUuidType(type: string, name: string): boolean {
  return type.includes('uuid') || name.includes('uuid') || name.includes('guid')
}

function buildMockDate(rowIndex: number): string {
  const day = (rowIndex % 28) + 1
  return `2026-01-${String(day).padStart(2, '0')}`
}

function buildMockDateTime(rowIndex: number): string {
  const day = (rowIndex % 28) + 1
  const hour = rowIndex % 24
  return `2026-01-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00:00`
}

function buildMockUuid(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0').slice(-12)}`
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function toSnakeToken(value: string): string {
  return value.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value'
}

function toTitleToken(value: string): string {
  return toSnakeToken(value)
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Value'
}

function buildSelectTemplate(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  tableName: string
): string {
  const qualifiedName = getQualifiedObjectName(driverId, scope, tableName)
  if (driverId === 'sqlserver') {
    return [
      'SELECT TOP (100)',
      '  *',
      `FROM ${qualifiedName};`,
      ''
    ].join('\n')
  }

  if (driverId === 'oracle') {
    return [
      'SELECT',
      '  *',
      `FROM ${qualifiedName}`,
      'FETCH FIRST 100 ROWS ONLY;',
      ''
    ].join('\n')
  }

  return [
    'SELECT',
    '  *',
    `FROM ${qualifiedName}`,
    'LIMIT 100;',
    ''
  ].join('\n')
}

function buildSelectSql(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  tableName: string
): string {
  return buildSelectTemplate(driverId, scope, tableName).trim()
}

function buildUpdateTemplate(
  driverId: DatabaseDriverId,
  qualifiedName: string,
  columns: TableSchema['columns']
): string {
  const writableColumns = columns.filter(column => !column.isPrimaryKey && !column.isAutoIncrement)
  const setColumns = writableColumns.length > 0 ? writableColumns : columns.slice(0, 1)
  const whereColumns = getPredicateColumns(columns)

  if (setColumns.length === 0) {
    return [
      `UPDATE ${qualifiedName}`,
      'SET',
      '  -- column_name = value',
      'WHERE 1 = 0;',
      ''
    ].join('\n')
  }

  return [
    `UPDATE ${qualifiedName}`,
    'SET',
    setColumns
      .map((column, index) => {
        const suffix = index === setColumns.length - 1 ? '' : ','
        return `  ${quoteSqlIdentifier(driverId, column.name)} = ${sampleSqlValue(column.type, column.nullable)}${suffix}`
      })
      .join('\n'),
    'WHERE',
    buildWhereClause(driverId, whereColumns),
    ''
  ].join('\n')
}

function buildDeleteTemplate(
  driverId: DatabaseDriverId,
  qualifiedName: string,
  columns: TableSchema['columns']
): string {
  return [
    `DELETE FROM ${qualifiedName}`,
    'WHERE',
    buildWhereClause(driverId, getPredicateColumns(columns)),
    ''
  ].join('\n')
}

function getPredicateColumns(columns: TableSchema['columns']): TableSchema['columns'] {
  const primaryColumns = columns.filter(column => column.isPrimaryKey)
  if (primaryColumns.length > 0) {
    return primaryColumns
  }

  return columns.length > 0 ? [columns[0]] : []
}

function buildWhereClause(driverId: DatabaseDriverId, columns: TableSchema['columns']): string {
  if (columns.length === 0) {
    return '  1 = 0;'
  }

  return columns
    .map((column, index) => {
      const prefix = index === 0 ? '  ' : '  AND '
      const suffix = index === columns.length - 1 ? ';' : ''
      return `${prefix}${quoteSqlIdentifier(driverId, column.name)} = ${sampleSqlValue(column.type, column.nullable)}${suffix}`
    })
    .join('\n')
}

function buildAddColumnSql(
  driverId: DatabaseDriverId,
  qualifiedName: string,
  columnName: string,
  columnType: string,
  nullable: boolean,
  defaultValue?: string
): string {
  const parts = [
    'ALTER TABLE',
    qualifiedName,
    'ADD COLUMN',
    quoteSqlIdentifier(driverId, columnName),
    columnType.trim()
  ]

  if (!nullable) {
    parts.push('NOT NULL')
  }
  if (defaultValue && defaultValue.trim()) {
    parts.push('DEFAULT', defaultValue.trim())
  }

  return `${parts.join(' ')};`
}

function buildCreateTableSql(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  tableName: string
): string {
  const qualifiedName = getQualifiedObjectName(driverId, scope, tableName)
  const idColumn = driverId === 'postgresql' || driverId === 'cockroachdb'
    ? `${quoteSqlIdentifier(driverId, 'id')} BIGSERIAL PRIMARY KEY`
    : driverId === 'sqlite' || driverId === 'duckdb'
      ? `${quoteSqlIdentifier(driverId, 'id')} INTEGER PRIMARY KEY`
      : driverId === 'mysql' || driverId === 'mariadb'
        ? `${quoteSqlIdentifier(driverId, 'id')} INT PRIMARY KEY AUTO_INCREMENT`
        : `${quoteSqlIdentifier(driverId, 'id')} INT PRIMARY KEY`

  return [
    `CREATE TABLE ${qualifiedName} (`,
    `  ${idColumn}`,
    ');',
    ''
  ].join('\n')
}

function buildNewTableDesignSchema(driverId: DatabaseDriverId, tableName: string): TableSchema {
  const idType = driverId === 'postgresql' || driverId === 'cockroachdb'
    ? 'BIGSERIAL'
    : driverId === 'mysql' || driverId === 'mariadb'
      ? 'INT'
      : 'INTEGER'

  return {
    name: tableName,
    columns: [{
      name: 'id',
      type: idType,
      nullable: false,
      defaultValue: null,
      isPrimaryKey: true,
      isAutoIncrement: true,
      comment: '',
      position: 1
    }],
    indexes: [],
    foreignKeys: [],
    comment: '',
    metadata: {
      createSql: buildCreateTableSql(driverId, {}, tableName)
    }
  }
}

function buildCreateTableDesignSql(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  draft: TableDesignDraft
): string[] {
  const qualifiedName = getQualifiedObjectName(driverId, scope, draft.tableName)
  const columnLines = draft.columns.map(column => `  ${buildColumnDefinitionSql(driverId, column, true)}`)
  const primaryKeys = draft.columns
    .filter(column => column.isPrimaryKey)
    .map(column => quoteSqlIdentifier(driverId, column.name))

  if (primaryKeys.length > 0) {
    columnLines.push(`  PRIMARY KEY (${primaryKeys.join(', ')})`)
  }

  const statements = [
    [
      `CREATE TABLE ${qualifiedName} (`,
      columnLines.join(',\n'),
      ');'
    ].join('\n')
  ]

  statements.push(...buildCommentStatements(driverId, qualifiedName, draft, undefined))
  statements.push(...draft.indexes
    .filter(index => !index.isPrimary)
    .map(index => buildCreateIndexSql(driverId, index.name, scope, draft.tableName, index.columns, index.isUnique)))

  return statements
}

function buildAlterTableDesignSql(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  originalSchema: TableSchema,
  draft: TableDesignDraft
): string[] {
  const statements: string[] = []
  const renamed = draft.tableName !== originalSchema.name

  if (renamed) {
    statements.push(buildRenameTableSql(driverId, scope, originalSchema.name, draft.tableName))
  }

  const qualifiedName = getQualifiedObjectName(driverId, scope, draft.tableName)
  const originalColumns = new Map(originalSchema.columns.map(column => [column.name, column]))
  const draftColumnsByOriginal = new Map(
    draft.columns
      .filter(column => column.originalName)
      .map(column => [column.originalName!, column])
  )

  const primaryKeyChanged = !sameStringArray(
    originalSchema.columns.filter(column => column.isPrimaryKey).map(column => column.name),
    draft.columns.filter(column => column.isPrimaryKey).map(column => column.originalName || column.name)
  )

  statements.push(...buildIndexDropStatements(driverId, scope, originalSchema, draft))

  if (primaryKeyChanged) {
    statements.push(...buildDropPrimaryKeySql(driverId, qualifiedName, originalSchema))
  }

  for (const originalColumn of originalSchema.columns) {
    if (!draftColumnsByOriginal.has(originalColumn.name)) {
      statements.push(`ALTER TABLE ${qualifiedName} DROP COLUMN ${quoteSqlIdentifier(driverId, originalColumn.name)};`)
    }
  }

  for (const column of draft.columns) {
    const originalColumn = column.originalName ? originalColumns.get(column.originalName) : undefined
    if (!originalColumn) {
      statements.push(`ALTER TABLE ${qualifiedName} ADD COLUMN ${buildColumnDefinitionSql(driverId, column, true)};`)
      continue
    }

    statements.push(...buildAlterColumnSql(driverId, qualifiedName, originalColumn, column))
  }

  if (primaryKeyChanged) {
    const primaryColumns = draft.columns.filter(column => column.isPrimaryKey).map(column => column.name)
    if (primaryColumns.length > 0) {
      statements.push(buildAddPrimaryKeySql(driverId, qualifiedName, primaryColumns))
    }
  }

  statements.push(...buildIndexCreateStatements(driverId, scope, originalSchema, draft))
  statements.push(...buildCommentStatements(driverId, qualifiedName, draft, originalSchema))

  return statements.filter(statement => statement.trim().length > 0)
}

function buildColumnDefinitionSql(
  driverId: DatabaseDriverId,
  column: TableDesignDraft['columns'][number],
  includeName: boolean
): string {
  const parts = includeName ? [quoteSqlIdentifier(driverId, column.name), composeColumnType(column)] : [composeColumnType(column)]

  if (!column.nullable || column.isPrimaryKey) {
    parts.push('NOT NULL')
  }
  if (column.defaultValue !== undefined && column.defaultValue !== null && String(column.defaultValue).trim() !== '') {
    parts.push('DEFAULT', String(column.defaultValue).trim())
  }
  if (column.isAutoIncrement && (driverId === 'mysql' || driverId === 'mariadb')) {
    parts.push('AUTO_INCREMENT')
  }
  if (column.comment && (driverId === 'mysql' || driverId === 'mariadb')) {
    parts.push('COMMENT', sqlString(column.comment))
  }

  return parts.join(' ')
}

function composeColumnType(column: TableDesignDraft['columns'][number]): string {
  const baseType = String(column.type || '').trim() || 'varchar'
  const length = String(column.length || '').trim()
  const decimals = String(column.decimals || '').trim()
  if (length && decimals) {
    return `${baseType}(${length}, ${decimals})`
  }
  if (length) {
    return `${baseType}(${length})`
  }
  return baseType
}

function buildAlterColumnSql(
  driverId: DatabaseDriverId,
  qualifiedName: string,
  originalColumn: TableColumn,
  draftColumn: TableDesignDraft['columns'][number]
): string[] {
  const statements: string[] = []
  const oldName = draftColumn.originalName || originalColumn.name
  const newName = draftColumn.name
  const typeChanged = normalizeSqlFragment(originalColumn.type) !== normalizeSqlFragment(composeColumnType(draftColumn))
  const nullableChanged = originalColumn.nullable !== draftColumn.nullable
  const defaultChanged = normalizeSqlFragment(originalColumn.defaultValue) !== normalizeSqlFragment(draftColumn.defaultValue)
  const autoIncrementChanged = originalColumn.isAutoIncrement !== draftColumn.isAutoIncrement
  const commentChanged = String(originalColumn.comment || '') !== String(draftColumn.comment || '')
  const nameChanged = oldName !== newName

  if (driverId === 'mysql' || driverId === 'mariadb') {
    if (nameChanged || typeChanged || nullableChanged || defaultChanged || autoIncrementChanged || commentChanged) {
      statements.push([
        'ALTER TABLE',
        qualifiedName,
        'CHANGE COLUMN',
        quoteSqlIdentifier(driverId, oldName),
        buildColumnDefinitionSql(driverId, draftColumn, true)
      ].join(' ') + ';')
    }
    return statements
  }

  if (nameChanged) {
    statements.push(`ALTER TABLE ${qualifiedName} RENAME COLUMN ${quoteSqlIdentifier(driverId, oldName)} TO ${quoteSqlIdentifier(driverId, newName)};`)
  }

  if (typeChanged) {
    statements.push(buildAlterColumnTypeSql(driverId, qualifiedName, newName, composeColumnType(draftColumn)))
  }
  if (nullableChanged) {
    statements.push(buildAlterColumnNullSql(driverId, qualifiedName, newName, draftColumn.nullable))
  }
  if (defaultChanged) {
    statements.push(buildAlterColumnDefaultSql(driverId, qualifiedName, newName, draftColumn.defaultValue))
  }
  if (autoIncrementChanged && driverId !== 'postgresql' && driverId !== 'cockroachdb') {
    throw new Error(t('table.autoIncrementAlterNotSupported'))
  }
  return statements
}

function buildAlterColumnTypeSql(driverId: DatabaseDriverId, qualifiedName: string, columnName: string, columnType: string): string {
  if (driverId === 'postgresql' || driverId === 'cockroachdb') {
    return `ALTER TABLE ${qualifiedName} ALTER COLUMN ${quoteSqlIdentifier(driverId, columnName)} TYPE ${columnType};`
  }
  if (driverId === 'duckdb') {
    return `ALTER TABLE ${qualifiedName} ALTER COLUMN ${quoteSqlIdentifier(driverId, columnName)} SET DATA TYPE ${columnType};`
  }
  if (driverId === 'clickhouse') {
    return `ALTER TABLE ${qualifiedName} MODIFY COLUMN ${quoteSqlIdentifier(driverId, columnName)} ${columnType};`
  }
  throw new Error(t('table.columnAlterNotSupported', driverId))
}

function buildAlterColumnNullSql(driverId: DatabaseDriverId, qualifiedName: string, columnName: string, nullable: boolean): string {
  if (driverId === 'postgresql' || driverId === 'cockroachdb' || driverId === 'duckdb') {
    const action = nullable ? 'DROP NOT NULL' : 'SET NOT NULL'
    return `ALTER TABLE ${qualifiedName} ALTER COLUMN ${quoteSqlIdentifier(driverId, columnName)} ${action};`
  }
  throw new Error(t('table.columnAlterNotSupported', driverId))
}

function buildAlterColumnDefaultSql(
  driverId: DatabaseDriverId,
  qualifiedName: string,
  columnName: string,
  defaultValue: string | null | undefined
): string {
  if (driverId === 'postgresql' || driverId === 'cockroachdb' || driverId === 'duckdb') {
    const column = quoteSqlIdentifier(driverId, columnName)
    if (defaultValue === undefined || defaultValue === null || String(defaultValue).trim() === '') {
      return `ALTER TABLE ${qualifiedName} ALTER COLUMN ${column} DROP DEFAULT;`
    }
    return `ALTER TABLE ${qualifiedName} ALTER COLUMN ${column} SET DEFAULT ${String(defaultValue).trim()};`
  }
  throw new Error(t('table.columnAlterNotSupported', driverId))
}

function buildDropPrimaryKeySql(driverId: DatabaseDriverId, qualifiedName: string, originalSchema: TableSchema): string[] {
  const originalPrimaryKeys = originalSchema.columns.filter(column => column.isPrimaryKey)
  if (originalPrimaryKeys.length === 0) {
    return []
  }

  if (driverId === 'mysql' || driverId === 'mariadb') {
    return [`ALTER TABLE ${qualifiedName} DROP PRIMARY KEY;`]
  }
  if (driverId === 'postgresql' || driverId === 'cockroachdb') {
    const primaryIndex = originalSchema.indexes.find(index => index.isPrimary)
    const constraintName = primaryIndex?.name || `${originalSchema.name}_pkey`
    return [`ALTER TABLE ${qualifiedName} DROP CONSTRAINT ${quoteSqlIdentifier(driverId, constraintName)};`]
  }

  throw new Error(t('table.primaryKeyAlterNotSupported', driverId))
}

function buildAddPrimaryKeySql(driverId: DatabaseDriverId, qualifiedName: string, columns: string[]): string {
  if (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'postgresql' || driverId === 'cockroachdb') {
    return `ALTER TABLE ${qualifiedName} ADD PRIMARY KEY (${columns.map(column => quoteSqlIdentifier(driverId, column)).join(', ')});`
  }
  throw new Error(t('table.primaryKeyAlterNotSupported', driverId))
}

function buildIndexDropStatements(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  originalSchema: TableSchema,
  draft: TableDesignDraft
): string[] {
  const draftByOriginal = new Map(
    draft.indexes
      .filter(index => index.originalName)
      .map(index => [index.originalName!, index])
  )

  return originalSchema.indexes
    .filter(index => !index.isPrimary)
    .filter(index => {
      const draftIndex = draftByOriginal.get(index.name)
      return !draftIndex || hasIndexChanged(index, draftIndex)
    })
    .map(index => buildDropIndexSql(driverId, scope, draft.tableName, index.name))
}

function buildIndexCreateStatements(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  originalSchema: TableSchema,
  draft: TableDesignDraft
): string[] {
  return draft.indexes
    .filter(index => !index.isPrimary)
    .filter(index => {
      if (!index.originalName) {
        return true
      }
      const originalIndex = originalSchema.indexes.find(item => item.name === index.originalName)
      return originalIndex ? hasIndexChanged(originalIndex, index) : true
    })
    .map(index => buildCreateIndexSql(driverId, index.name, scope, draft.tableName, index.columns, index.isUnique))
}

function hasIndexChanged(originalIndex: TableIndex, draftIndex: TableDesignDraft['indexes'][number]): boolean {
  return originalIndex.name !== draftIndex.name
    || originalIndex.isUnique !== draftIndex.isUnique
    || !sameStringArray(originalIndex.columns, draftIndex.columns)
    || String(originalIndex.type || '') !== String(draftIndex.type || '')
}

function buildCommentStatements(
  driverId: DatabaseDriverId,
  qualifiedName: string,
  draft: TableDesignDraft,
  originalSchema: TableSchema | undefined
): string[] {
  const statements: string[] = []
  if (String(draft.comment || '') !== String(originalSchema?.comment || '')) {
    statements.push(...buildTableCommentStatements(driverId, qualifiedName, draft.comment || ''))
  }

  for (const column of draft.columns) {
    const originalColumn = originalSchema?.columns.find(item => item.name === (column.originalName || column.name))
    if (String(column.comment || '') !== String(originalColumn?.comment || '')) {
      statements.push(...buildColumnCommentStatements(driverId, qualifiedName, column.name, column.comment || ''))
    }
  }

  return statements
}

function buildTableCommentStatements(driverId: DatabaseDriverId, qualifiedName: string, comment: string): string[] {
  if (driverId === 'mysql' || driverId === 'mariadb') {
    return [`ALTER TABLE ${qualifiedName} COMMENT = ${sqlString(comment)};`]
  }
  if (driverId === 'postgresql' || driverId === 'cockroachdb') {
    return [`COMMENT ON TABLE ${qualifiedName} IS ${comment ? sqlString(comment) : 'NULL'};`]
  }
  return []
}

function buildColumnCommentStatements(driverId: DatabaseDriverId, qualifiedName: string, columnName: string, comment: string): string[] {
  if (driverId === 'postgresql' || driverId === 'cockroachdb') {
    return [`COMMENT ON COLUMN ${qualifiedName}.${quoteSqlIdentifier(driverId, columnName)} IS ${comment ? sqlString(comment) : 'NULL'};`]
  }
  return []
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function normalizeSqlFragment(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function buildRenameTableSql(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  oldName: string,
  newName: string
): string {
  const oldQualifiedName = getQualifiedObjectName(driverId, scope, oldName)
  if (driverId === 'mysql' || driverId === 'mariadb') {
    const newQualifiedName = getQualifiedObjectName(driverId, scope, newName)
    return `RENAME TABLE ${oldQualifiedName} TO ${newQualifiedName};`
  }

  return `ALTER TABLE ${oldQualifiedName} RENAME TO ${quoteSqlIdentifier(driverId, newName)};`
}

function buildRenameColumnSql(
  driverId: DatabaseDriverId,
  qualifiedName: string,
  oldName: string,
  newName: string,
  columnType: string
): string {
  if (driverId === 'mysql' || driverId === 'mariadb') {
    return [
      'ALTER TABLE',
      qualifiedName,
      'CHANGE COLUMN',
      quoteSqlIdentifier(driverId, oldName),
      quoteSqlIdentifier(driverId, newName),
      columnType,
      ';'
    ].join(' ')
  }

  return `ALTER TABLE ${qualifiedName} RENAME COLUMN ${quoteSqlIdentifier(driverId, oldName)} TO ${quoteSqlIdentifier(driverId, newName)};`
}

function buildCreateIndexSql(
  driverId: DatabaseDriverId,
  indexName: string,
  scope: SchemaScope,
  tableName: string,
  columns: string[],
  unique: boolean
): string {
  const qualifiedTableName = getQualifiedObjectName(driverId, scope, tableName)
  const columnList = columns.map(column => quoteSqlIdentifier(driverId, column)).join(', ')
  const uniqueKeyword = unique ? 'UNIQUE ' : ''
  return `CREATE ${uniqueKeyword}INDEX ${quoteSqlIdentifier(driverId, indexName)} ON ${qualifiedTableName} (${columnList});`
}

function buildDropIndexSql(
  driverId: DatabaseDriverId,
  scope: SchemaScope,
  tableName: string,
  indexName: string
): string {
  if (driverId === 'mysql' || driverId === 'mariadb') {
    return `DROP INDEX ${quoteSqlIdentifier(driverId, indexName)} ON ${getQualifiedObjectName(driverId, scope, tableName)};`
  }

  const indexParts: string[] = []
  if (driverId === 'postgresql' || driverId === 'cockroachdb' || driverId === 'duckdb') {
    if (scope.schema) {
      indexParts.push(scope.schema)
    }
  } else if (driverId !== 'sqlite') {
    if (scope.schema) {
      indexParts.push(scope.schema)
    } else if (scope.database) {
      indexParts.push(scope.database)
    }
  }
  indexParts.push(indexName)

  return `DROP INDEX ${indexParts.map(part => quoteSqlIdentifier(driverId, part)).join('.')};`
}

function sampleSqlValue(type: string, nullable: boolean): string {
  const lowerType = type.toLowerCase()
  if (nullable) {
    return 'NULL'
  }
  if (lowerType.includes('int') || lowerType.includes('decimal') || lowerType.includes('number') || lowerType.includes('float') || lowerType.includes('double')) {
    return '0'
  }
  if (lowerType.includes('bool')) {
    return 'FALSE'
  }
  if (lowerType.includes('date') || lowerType.includes('time')) {
    return 'CURRENT_TIMESTAMP'
  }
  return "'sample'"
}

function buildDataDictionary(
  profile: DbConnectionProfile,
  scope: SchemaScope,
  schemas: TableSchema[]
): string {
  const title = [profile.name, scope.database, scope.schema].filter(Boolean).join(' / ')
  const lines: string[] = [
    `# Data Dictionary: ${title}`,
    ''
  ]

  for (const schema of schemas) {
    lines.push(`## ${schema.name}`, '')
    if (schema.comment) {
      lines.push(schema.comment, '')
    }

    lines.push('| Column | Type | Nullable | Key | Default | Comment |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const column of schema.columns) {
      lines.push([
        escapeMarkdownCell(column.name),
        escapeMarkdownCell(column.type),
        column.nullable ? 'YES' : 'NO',
        column.isPrimaryKey ? 'PRIMARY' : '',
        escapeMarkdownCell(column.defaultValue || ''),
        escapeMarkdownCell(column.comment || '')
      ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'))
    }
    lines.push('')

    if (schema.indexes.length > 0) {
      lines.push('### Indexes', '')
      lines.push('| Name | Columns | Unique | Primary | Type |')
      lines.push('| --- | --- | --- | --- | --- |')
      for (const index of schema.indexes) {
        lines.push(`| ${escapeMarkdownCell(index.name)} | ${escapeMarkdownCell(index.columns.join(', '))} | ${index.isUnique ? 'YES' : 'NO'} | ${index.isPrimary ? 'YES' : 'NO'} | ${escapeMarkdownCell(index.type || '')} |`)
      }
      lines.push('')
    }

    if (schema.foreignKeys.length > 0) {
      lines.push('### Foreign Keys', '')
      lines.push('| Name | Columns | References | On Update | On Delete |')
      lines.push('| --- | --- | --- | --- | --- |')
      for (const foreignKey of schema.foreignKeys) {
        lines.push(`| ${escapeMarkdownCell(foreignKey.name)} | ${escapeMarkdownCell(foreignKey.columns.join(', '))} | ${escapeMarkdownCell(`${foreignKey.referencedTable} (${foreignKey.referencedColumns.join(', ')})`)} | ${escapeMarkdownCell(foreignKey.onUpdate || '')} | ${escapeMarkdownCell(foreignKey.onDelete || '')} |`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function escapeMarkdownCell(value: string): string {
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
