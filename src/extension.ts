import { ExtensionContext, ProgressLocation, Uri, commands, window, workspace } from 'vscode'
import { ConnectionStore } from '@/core/connectionStore'
import { SUPPORTED_DRIVERS } from '@/core/constants'
import { DatabaseDriverId, DbConnectionProfile } from '@/core/types'
import { DriverRegistry } from '@/drivers/registry'
import { getCurrentLanguage, initI18n, reloadI18n, t } from '@/i18n'
import { ConnectionNode, ConnectionsTreeProvider, SchemaNode, TablesGroupNode } from '@/providers/connectionsTree'
import { ConnectionService } from '@/services/connectionService'
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
          const result = await connectionService.testConnection(profile)
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

      await connectionStore.remove(profile.id)
      await SecretService.getInstance().deletePassword(profile.id)
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
    commands.registerCommand('dbNexus.showTableSchema', async (node: SchemaNode | undefined) => {
      if (!node || !isTableLikeNode(node)) {
        window.showWarningMessage(t('table.selectTable'))
        return
      }

      const profile = node.connectionProfile
      const driver = driverRegistry.getDriver(profile.driverId)
      if (!driver?.getTableSchema) {
        window.showErrorMessage(t('table.schemaNotSupported'))
        return
      }

      try {
        const schema = await driver.getTableSchema(profile, node.schemaObject.name, node.scope || {})
        TableSchemaPanel.show(context, t('table.schemaTitle', schema.name), schema)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        window.showErrorMessage(t('table.schemaFailed', message))
      }
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
      if (!event.affectsConfiguration('dbNexus.displayLanguage')) return
      reloadI18n()
      connectionsTreeProvider?.refresh()
      window.showInformationMessage(t('i18n.languageChanged', getCurrentLanguage()))
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
