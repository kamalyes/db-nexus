import { ExtensionContext, ProgressLocation, Uri, commands, env, window, workspace } from 'vscode'
import { ConnectionStore } from '@/core/connectionStore'
import { SUPPORTED_DRIVERS } from '@/core/constants'
import { DatabaseDriverId, DbConnectionProfile, SchemaObject, SchemaScope, TableSchema } from '@/core/types'
import { DriverRegistry } from '@/drivers/registry'
import { getCurrentLanguage, initI18n, reloadI18n, t } from '@/i18n'
import { ConnectionNode, ConnectionsTreeProvider, FieldNode, IndexNode, SchemaNode, TableDetailGroupNode, TablesGroupNode } from '@/providers/connectionsTree'
import { ConnectionService } from '@/services/connectionService'
import { connectionStatusManager } from '@/services/connectionStatusManager'
import { QueryService } from '@/services/queryService'
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

let connectionsTreeProvider: ConnectionsTreeProvider | undefined

type TableTarget = {
  profile: DbConnectionProfile
  scope: SchemaScope
  tableName: string
  objectType: SchemaObject['type']
  rowCount?: number
  description?: string
}

type FieldTarget = {
  profile: DbConnectionProfile
  scope: SchemaScope
  tableName: string
  columnName: string
  columnType: string
}

type TableSchemaTab = 'fields' | 'indexes' | 'foreignKeys' | 'checks' | 'triggers' | 'options' | 'comment' | 'sql'

export function activate(context: ExtensionContext): void {
  initI18n(context.extensionPath)
  SecretService.init(context)
  QueryHistoryService.init(context)

  const outputChannel = window.createOutputChannel('DB Nexus')
  const connectionStore = new ConnectionStore()
  const driverRegistry = new DriverRegistry()
  const connectionService = new ConnectionService(connectionStore, driverRegistry)
  const queryService = new QueryService(driverRegistry)

  connectionsTreeProvider = new ConnectionsTreeProvider(connectionService, context.extensionPath)

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
      return { profile: node.connectionProfile, scope: node.scope || {} }
    }

    const profile = await pickConnection(connectionService.getConnections())
    return profile ? { profile, scope: {} } : undefined
  }

  const resolveTableTarget = async (
    node: FieldNode | IndexNode | SchemaNode | TableDetailGroupNode | TablesGroupNode | undefined
  ): Promise<TableTarget | undefined> => {
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

  const resolveFieldTarget = async (node: FieldNode | undefined): Promise<FieldTarget | undefined> => {
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

  const openSqlDocument = async (sql: string): Promise<void> => {
    const document = await workspace.openTextDocument({
      language: 'sql',
      content: sql.endsWith('\n') ? sql : `${sql}\n`
    })
    await window.showTextDocument(document)
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
      await openSqlDocument(buildInsertTemplate(target.profile.driverId, qualifiedName, columns))
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
      await openSqlDocument(sql)
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
      const objects = await connectionService.listObjects(dbContext.profile, dbContext.scope)
      targets.push(...objects.filter(isTableLikeObject).map(object => ({
        profile: dbContext.profile,
        scope: dbContext.scope,
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
      const schema = await driver.getTableSchema(target.profile, target.tableName, target.scope)
      TableSchemaPanel.show(context, t('table.schemaTitle', schema.name), schema, {
        profile: target.profile,
        scope: target.scope,
        objectType: target.objectType,
        rowCount: target.rowCount,
        description: target.description,
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

  const closeExpandedDatabaseTree = async (
    node: ConnectionNode | SchemaNode | TablesGroupNode | undefined
  ): Promise<void> => {
    const dbContext = await resolveNodeContext(node)
    if (!dbContext) return

    const scope = node ? getContainerScope(node) : dbContext.scope
    TableSchemaPanel.closeFor(dbContext.profile, scope)
    connectionsTreeProvider?.refreshNode(node)
  }

  context.subscriptions.push(
    outputChannel,
    window.createTreeView('dbNexus.connections', {
      treeDataProvider: connectionsTreeProvider,
      showCollapseAll: true
    }),
    commands.registerCommand('dbNexus.refreshConnections', () => {
      connectionsTreeProvider?.refresh()
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
    commands.registerCommand('dbNexus.testConnection', async (node: ConnectionNode | undefined) => {
      const profile = node ? node.profile : await pickConnection(connectionService.getConnections())
      if (!profile) return

      await window.withProgress(
        { location: ProgressLocation.Notification, title: t('connection.testing') },
        async () => {
          const driver = driverRegistry.getDriver(profile.driverId)
          if (driver.dispose) {
            await driver.dispose(profile.id)
          }

          connectionStatusManager.setStatus(profile.id, 'connecting')
          const result = await connectionService.testConnection(profile)
          connectionStatusManager.setStatus(
            profile.id,
            result.ok ? 'connected' : 'error',
            result.latencyMs,
            result.ok ? undefined : result.message
          )

          if (!result.ok && driver.dispose) {
            await driver.dispose(profile.id)
          }

          connectionsTreeProvider?.refresh()
          if (result.ok) {
            window.showInformationMessage(t('connection.testSuccess', result.latencyMs || 0))
          } else {
            window.showErrorMessage(t('connection.testFailed', result.message))
          }
        }
      )
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
      connectionStatusManager.clearStatus(profile.id)
      connectionsTreeProvider?.refresh()
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
      const document = await workspace.openTextDocument({
        language: 'sql',
        content: t('query.scratchContent')
      })
      await window.showTextDocument(document)
    }),
    commands.registerCommand('dbNexus.runQuery', async () => {
      const profile = await pickConnection(connectionService.getConnections())
      if (!profile) return

      const editor = window.activeTextEditor
      const sql = editor
        ? editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection)
        : await window.showInputBox({ prompt: t('query.inputPrompt') })

      if (!sql || sql.trim().length === 0) {
        window.showWarningMessage(t('query.empty'))
        return
      }

      try {
        const result = await queryService.run(profile, { sql })
        ResultPanel.show(context, t('query.resultTitle', profile.name), result)
        await QueryHistoryService.getInstance().add(sql, profile, result)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        outputChannel.appendLine(message)
        window.showErrorMessage(t('query.failed', message))
        await QueryHistoryService.getInstance().add(sql, profile, error instanceof Error ? error : new Error(message))
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

      const profile = node.connectionProfile
      const scope = node.scope || {}
      const driver = driverRegistry.getDriver(profile.driverId)

      try {
        const objects = await connectionService.listObjects(profile, scope)
        const tables = objects.filter(object =>
          object.type === 'table' || object.type === 'view' || object.type === 'materializedView'
        )
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

      const qualifiedName = getQualifiedObjectName(dbContext.profile.driverId, dbContext.scope, tableName)
      const document = await workspace.openTextDocument({
        language: 'sql',
        content: [
          `CREATE TABLE ${qualifiedName} (`,
          '  id INT PRIMARY KEY',
          ');',
          ''
        ].join('\n')
      })
      await window.showTextDocument(document)
    }),
    commands.registerCommand('dbNexus.designTable', async (node: SchemaNode | undefined) => {
      await commands.executeCommand('dbNexus.showTableSchema', node)
    }),
    commands.registerCommand('dbNexus.addColumn', async (node: SchemaNode | TableDetailGroupNode | undefined) => {
      const target = await resolveTableTarget(node)
      if (!target) return

      if (target.objectType !== 'table') {
        window.showWarningMessage(t('table.onlyTablesCanAddColumn'))
        return
      }

      const columnName = await window.showInputBox({
        prompt: t('table.addColumnName'),
        placeHolder: 'status'
      })
      if (!columnName) return

      const columnType = await window.showInputBox({
        prompt: t('table.addColumnType'),
        value: 'VARCHAR(255)'
      })
      if (!columnType) return

      const nullableChoice = await window.showQuickPick(
        [
          { label: t('table.nullableYes'), nullable: true },
          { label: t('table.nullableNo'), nullable: false }
        ],
        { placeHolder: t('table.addColumnNullable') }
      )
      if (!nullableChoice) return

      const defaultValue = await window.showInputBox({
        prompt: t('table.addColumnDefault'),
        placeHolder: t('table.defaultExpressionPlaceholder')
      })

      const qualifiedName = getQualifiedObjectName(target.profile.driverId, target.scope, target.tableName)
      const sql = buildAddColumnSql(
        target.profile.driverId,
        qualifiedName,
        columnName,
        columnType,
        nullableChoice.nullable,
        defaultValue || undefined
      )

      const mode = await window.showQuickPick(
        [
          { label: t('table.runNow'), value: 'run' as const },
          { label: t('table.openSqlToReview'), value: 'open' as const }
        ],
        { placeHolder: t('table.addColumnMode') }
      )
      if (!mode) return

      if (mode.value === 'open') {
        const document = await workspace.openTextDocument({
          language: 'sql',
          content: `${sql}\n`
        })
        await window.showTextDocument(document)
        return
      }

      try {
        await executeSql(target.profile, sql, target.scope)
        connectionsTreeProvider?.refreshTable(target.profile, target.tableName, target.scope)
        window.showInformationMessage(t('table.columnAdded', columnName))
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.addColumnFailed', message))
      }
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

      await openSqlDocument(buildSelectTemplate(target.profile.driverId, target.scope, target.tableName))
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
    commands.registerCommand('dbNexus.dropColumn', async (node: FieldNode | undefined) => {
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

      const columnsText = await window.showInputBox({
        prompt: t('table.indexColumns'),
        placeHolder: 'column_a, column_b'
      })
      if (!columnsText) return

      const columns = columnsText.split(',').map(column => column.trim()).filter(Boolean)
      if (columns.length === 0) return

      const indexName = await window.showInputBox({
        prompt: t('table.indexNamePrompt'),
        value: `idx_${target.tableName}_${columns.join('_')}`
      })
      if (!indexName) return

      const uniqueChoice = await window.showQuickPick(
        [
          { label: t('table.indexNormal'), unique: false },
          { label: t('table.indexUnique'), unique: true }
        ],
        { placeHolder: t('table.indexTypePrompt') }
      )
      if (!uniqueChoice) return

      const sql = buildCreateIndexSql(
        target.profile.driverId,
        indexName,
        target.scope,
        target.tableName,
        columns,
        uniqueChoice.unique
      )

      try {
        await executeSql(target.profile, sql, target.scope)
        connectionsTreeProvider?.refreshTable(target.profile, target.tableName, target.scope)
        window.showInformationMessage(t('table.indexCreated', indexName))
        await showTableSchemaForTarget(target, {
          initialTab: 'indexes',
          selectedIndexName: indexName
        })
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.createIndexFailed', message))
      }
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
    commands.registerCommand('dbNexus.generateData', async (node: SchemaNode | TablesGroupNode | undefined) => {
      await openInsertTemplate(node)
    }),
    commands.registerCommand('dbNexus.runSqlFile', async (node: ConnectionNode | SchemaNode | TablesGroupNode | undefined) => {
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

      try {
        const sql = new TextDecoder().decode(await workspace.fs.readFile(uris[0]))
        const result = await window.withProgress(
          { location: ProgressLocation.Notification, title: t('table.runningSqlFile') },
          () => executeSql(dbContext.profile, sql, dbContext.scope)
        )
        ResultPanel.show(context, t('query.resultTitle', dbContext.profile.name), result)
        await QueryHistoryService.getInstance().add(sql, dbContext.profile, result)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        outputChannel.appendLine(message)
        window.showErrorMessage(t('query.failed', message))
      }
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
      const profile = await pickConnection(connectionService.getConnections())
      if (!profile) return

      const editor = window.activeTextEditor
      const sql = editor
        ? editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection)
        : await window.showInputBox({ prompt: t('query.inputPrompt') })

      if (!sql || sql.trim().length === 0) {
        window.showWarningMessage(t('query.empty'))
        return
      }

      const driver = driverRegistry.getDriver(profile.driverId)
      if (!driver?.getExecutionPlan) {
        window.showErrorMessage(t('executionPlan.notSupported'))
        return
      }

      try {
        const plan = await driver.getExecutionPlan(profile, sql, {})
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
      if (event.affectsConfiguration('dbNexus.connections')) {
        connectionsTreeProvider?.refresh()
      }

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
  } else if (driverId !== 'sqlite' && driverId !== 'duckdb') {
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
  if (driverId !== 'sqlite' && driverId !== 'duckdb') {
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
