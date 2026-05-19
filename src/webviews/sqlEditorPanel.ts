import { ExtensionContext, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode'
import { DbConnectionProfile, DatabaseDriverId, QueryResult, SchemaObject, SchemaScope } from '@/core/types'
import { DriverRegistry } from '@/drivers/registry'
import { t } from '@/i18n'
import { ConnectionService } from '@/services/connectionService'
import { SqlExecutionLogService } from '@/services/sqlExecutionLogService'
import { QueryService } from '@/services/queryService'
import { ExecutionPlanPanel } from './executionPlanPanel'
import { format as sqlFormat } from 'sql-formatter'

interface SqlEditorOptions {
  sql?: string
  profile?: DbConnectionProfile
  scope?: SchemaScope
  title?: string
  contextLabel?: string
  uri?: Uri
}

interface SqlSuggestion {
  value: string
  insertText: string
  detail: string
  kind: SchemaObject['type'] | 'keyword' | 'column'
  tableName?: string
  schemaName?: string
}

interface SqlEditorState {
  connections: Array<{ id: string; name: string; driverId: string }>
  databases: string[]
  schemas: string[]
  suggestions: SqlSuggestion[]
  selectedConnectionId: string
  selectedDatabase: string
  selectedSchema: string
  dialect: string
  sql: string
  title: string
  contextLabel: string
}

export class SqlEditorPanel {
  private readonly panel: WebviewPanel
  private readonly disposables: Array<{ dispose(): void }> = []
  private selectedProfile: DbConnectionProfile | undefined
  private scope: SchemaScope
  private sql: string
  private readonly title: string | undefined
  private readonly contextLabel: string | undefined
  private uri: Uri | undefined
  private stateRequestId = 0

  static show(
    context: ExtensionContext,
    connectionService: ConnectionService,
    driverRegistry: DriverRegistry,
    queryService: QueryService,
    options: SqlEditorOptions = {}
  ): void {
    const panel = window.createWebviewPanel(
      'dbNexus.sqlEditor',
      options.title || 'DB Nexus SQL',
      ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    new SqlEditorPanel(panel, context, connectionService, driverRegistry, queryService, options)
  }

  private constructor(
    panel: WebviewPanel,
    private readonly context: ExtensionContext,
    private readonly connectionService: ConnectionService,
    private readonly driverRegistry: DriverRegistry,
    private readonly queryService: QueryService,
    options: SqlEditorOptions
  ) {
    this.panel = panel
    this.selectedProfile = options.profile
    this.scope = { ...(options.scope || {}) }
    this.sql = options.sql || t('query.scratchContent')
    this.title = options.title
    this.contextLabel = options.contextLabel
    this.uri = options.uri

    this.panel.webview.html = this.render()
    this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message), null, this.disposables)
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.context.subscriptions.push(this.panel)
  }

  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose()
    }
  }

  private async handleMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    if (message.type === 'ready') {
      await this.postFastStateThenMetadata()
      return
    }

    if (message.type === 'selectConnection' && typeof message.connectionId === 'string') {
      this.selectedProfile = this.connectionService.getConnections().find(profile => profile.id === message.connectionId)
      this.scope = {
        database: this.selectedProfile?.database
      }
      await this.postFastStateThenMetadata()
      return
    }

    if (message.type === 'selectDatabase' && typeof message.database === 'string') {
      this.scope.database = message.database || undefined
      this.scope.schema = undefined
      await this.postFastStateThenMetadata()
      return
    }

    if (message.type === 'selectSchema' && typeof message.schema === 'string') {
      this.scope.schema = message.schema || undefined
      await this.postFastStateThenMetadata()
      return
    }

    if (message.type === 'run' && typeof message.sql === 'string') {
      this.sql = typeof message.editorSql === 'string' ? message.editorSql : message.sql
      await this.runSql(message.sql)
      return
    }

    if (message.type === 'explain' && typeof message.sql === 'string') {
      this.sql = typeof message.editorSql === 'string' ? message.editorSql : message.sql
      await this.showExecutionPlan(message.sql)
      return
    }

    if (message.type === 'save' && typeof message.sql === 'string') {
      this.sql = message.sql
      await this.saveSql()
      return
    }

    if (message.type === 'askAi') {
      window.showInformationMessage('AI assistant is not configured yet.')
    }

    if (message.type === 'format' && typeof message.sql === 'string') {
      try {
        const dialect = this.mapDriverToFormatterDialect(this.selectedProfile?.driverId)
        const formatted = sqlFormat(message.sql, { language: dialect, tabWidth: 2, keywordCase: 'upper' })
        this.panel.webview.postMessage({ type: 'formatted', sql: formatted })
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error)
        this.panel.webview.postMessage({ type: 'status', message: `Format failed: ${msg}` })
      }
      return
    }

    if (message.type === 'refreshMetadata') {
      await this.postState({ includeMetadata: true })
    }
  }

  private async postFastStateThenMetadata(): Promise<void> {
    await this.postState({ includeMetadata: false })
    void this.postState({ includeMetadata: true })
  }

  private async postState(options: { includeMetadata: boolean }): Promise<void> {
    const requestId = ++this.stateRequestId
    const state = await this.getState(options)
    if (requestId !== this.stateRequestId) {
      return
    }
    this.panel.webview.postMessage({
      type: 'state',
      state
    })
  }

  private async getState(options: { includeMetadata: boolean }): Promise<SqlEditorState> {
    const connections = this.connectionService.getConnections()
    if (!this.selectedProfile) {
      this.selectedProfile = connections[0]
    }

    let databases = this.scope.database
      ? [this.scope.database]
      : this.selectedProfile?.database
        ? [this.selectedProfile.database]
        : []
    let schemas = this.scope.schema ? [this.scope.schema] : []
    let suggestions: SqlSuggestion[] = []

    if (options.includeMetadata) {
      databases = await this.loadDatabases(this.selectedProfile)
      if (!this.scope.database) {
        this.scope.database = this.selectedProfile?.database || databases[0]
      }

      schemas = await this.loadSchemas(this.selectedProfile, this.scope.database)
      if (schemas.length === 0) {
        this.scope.schema = undefined
      } else if (this.scope.schema && !schemas.includes(this.scope.schema)) {
        this.scope.schema = undefined
      }

      databases = this.withSelectedValue(databases, this.scope.database)
      schemas = this.withSelectedValue(schemas, this.scope.schema)
      suggestions = await this.loadSuggestions(this.selectedProfile, this.scope.database, this.scope.schema, schemas)
    } else {
      databases = this.withSelectedValue(databases, this.scope.database)
      schemas = this.withSelectedValue(schemas, this.scope.schema)
    }

    return {
      connections: connections.map(profile => ({
        id: profile.id,
        name: profile.name,
        driverId: profile.driverId
      })),
      databases,
      schemas,
      suggestions,
      selectedConnectionId: this.selectedProfile?.id || '',
      selectedDatabase: this.scope.database || '',
      selectedSchema: this.scope.schema || '',
      dialect: this.selectedProfile?.driverId || 'sql',
      sql: this.sql,
      title: this.uri ? this.getFileName(this.uri) : this.title || 'SQL Scratch',
      contextLabel: this.contextLabel || (this.selectedProfile ? this.getContextLabel(this.selectedProfile) : '')
    }
  }

  private withSelectedValue(values: string[], selectedValue: string | undefined): string[] {
    if (!selectedValue || values.includes(selectedValue)) {
      return values
    }
    return [selectedValue, ...values]
  }

  private async loadDatabases(profile: DbConnectionProfile | undefined): Promise<string[]> {
    if (!profile) return []

    try {
      const driver = this.driverRegistry.getDriver(profile.driverId)
      return (await driver.listDatabases(profile)).map(database => database.name)
    } catch {
      return profile.database ? [profile.database] : []
    }
  }

  private async loadSchemas(profile: DbConnectionProfile | undefined, database: string | undefined): Promise<string[]> {
    if (!profile) return []

    try {
      const driver = this.driverRegistry.getDriver(profile.driverId)
      const objects = await driver.listObjects(profile, { database })
      return objects.filter(object => object.type === 'schema').map(object => object.name)
    } catch {
      return []
    }
  }

  private async loadSuggestions(
    profile: DbConnectionProfile | undefined,
    database: string | undefined,
    schema: string | undefined,
    schemas: string[]
  ): Promise<SqlSuggestion[]> {
    if (!profile) return []

    const suggestions: SqlSuggestion[] = []
    const seen = new Set<string>()
    const addSuggestion = (
      value: string,
      kind: SqlSuggestion['kind'],
      detail: string,
      insertText = value,
      tableName?: string,
      schemaName?: string
    ): void => {
      if (!value) return
      const key = `${kind}:${value.toLowerCase()}:${detail.toLowerCase()}:${tableName || ''}:${schemaName || ''}`
      if (seen.has(key)) return
      seen.add(key)
      suggestions.push({ value, insertText, kind, detail, tableName, schemaName })
    }

    schemas.forEach(schemaName => addSuggestion(schemaName, 'schema', 'schema', schemaName, undefined, schemaName))

    try {
      const driver = this.driverRegistry.getDriver(profile.driverId)
      const metadataSchema = schema || this.getAutocompleteSchema(profile, schemas)
      const objects = await driver.listObjects(profile, { database, schema: metadataSchema })

      const tableObjects: SchemaObject[] = []
      for (const object of objects) {
        if (object.type === 'database') continue
        const objectSchema = object.scope?.schema || metadataSchema
        const detail = objectSchema && object.type !== 'schema'
          ? `${object.type} - ${objectSchema}`
          : object.type
        const tableName = object.type === 'table' || object.type === 'view' || object.type === 'materializedView'
          ? object.name
          : undefined
        addSuggestion(object.name, object.type, detail, object.name, tableName, objectSchema)
        if (object.type === 'table' || object.type === 'view' || object.type === 'materializedView') {
          tableObjects.push(object)
        }
      }

      if (driver.getTableSchema) {
        for (const object of this.prioritizeTableObjectsForSql(tableObjects).slice(0, 120)) {
          const objectSchema = object.scope?.schema || metadataSchema
          try {
            const tableSchema = await driver.getTableSchema(profile, object.name, { database, schema: objectSchema })
            for (const column of tableSchema.columns) {
              addSuggestion(
                column.name,
                'column',
                `${object.name} - ${column.type}`,
                column.name,
                object.name,
                objectSchema
              )
            }
          } catch {
            // Column suggestions are best-effort; table suggestions still work.
          }
        }
      }
    } catch {
      return suggestions
    }

    return suggestions
  }

  private prioritizeTableObjectsForSql(tableObjects: SchemaObject[]): SchemaObject[] {
    const referencedTables = this.extractReferencedTables(this.sql)
    if (referencedTables.size === 0) {
      return tableObjects
    }

    return [...tableObjects].sort((left, right) => {
      const leftScore = referencedTables.has(this.normalizeSqlIdentifier(left.name)) ? 0 : 1
      const rightScore = referencedTables.has(this.normalizeSqlIdentifier(right.name)) ? 0 : 1
      if (leftScore !== rightScore) {
        return leftScore - rightScore
      }
      return left.name.localeCompare(right.name)
    })
  }

  private extractReferencedTables(sql: string): Set<string> {
    const tables = new Set<string>()
    const regex = /\b(?:from|join|update|into)\s+([`"\[]?[A-Za-z0-9_$.-]+[`"\]]?)/gi
    let match: RegExpExecArray | null
    while ((match = regex.exec(sql))) {
      const tableName = this.normalizeSqlIdentifier(match[1])
      if (tableName) {
        tables.add(tableName)
      }
    }
    return tables
  }

  private normalizeSqlIdentifier(value: string): string {
    return String(value || '')
      .trim()
      .replace(/^[`"\[]+|[`"\]]+$/g, '')
      .split('.')
      .pop()
      ?.replace(/^[`"\[]+|[`"\]]+$/g, '')
      .toLowerCase() || ''
  }

  private getAutocompleteSchema(profile: DbConnectionProfile, schemas: string[]): string | undefined {
    if (profile.driverId === 'postgresql' || profile.driverId === 'cockroachdb') {
      return schemas.includes('public') ? 'public' : schemas[0]
    }

    return undefined
  }

  private async runSql(querySql: string): Promise<void> {
    const profile = this.selectedProfile
    if (!profile || querySql.trim().length === 0) {
      window.showWarningMessage(t('query.empty'))
      return
    }

    this.panel.webview.postMessage({ type: 'busy', value: true })
    const start = Date.now()
    try {
      const result = await this.queryService.run(profile, {
        sql: querySql,
        database: this.scope.database,
        schema: this.scope.schema
      })
      await SqlExecutionLogService.getInstance().record(querySql, profile, result, Date.now() - start)
      this.panel.webview.postMessage({ type: 'result', result: this.toWebviewResult(result) })
      this.panel.webview.postMessage({ type: 'status', message: `${result.rowCount} rows, ${result.elapsedMs} ms` })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      await SqlExecutionLogService.getInstance().record(querySql, profile, error instanceof Error ? error : new Error(message), Date.now() - start)
      this.panel.webview.postMessage({ type: 'resultError', message })
      this.panel.webview.postMessage({ type: 'status', message })
    } finally {
      this.panel.webview.postMessage({ type: 'busy', value: false })
    }
  }

  private async showExecutionPlan(querySql: string): Promise<void> {
    const profile = this.selectedProfile
    if (!profile || querySql.trim().length === 0) {
      window.showWarningMessage(t('query.empty'))
      return
    }

    const driver = this.driverRegistry.getDriver(profile.driverId)
    if (!driver.getExecutionPlan) {
      window.showErrorMessage(t('executionPlan.notSupported'))
      return
    }

    this.panel.webview.postMessage({ type: 'busy', value: true })
    try {
      const plan = await driver.getExecutionPlan(profile, querySql, this.scope)
      ExecutionPlanPanel.show(this.context, plan, querySql)
      this.panel.webview.postMessage({ type: 'status', message: 'Execution plan opened' })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      window.showErrorMessage(t('executionPlan.failed', message))
      this.panel.webview.postMessage({ type: 'status', message })
    } finally {
      this.panel.webview.postMessage({ type: 'busy', value: false })
    }
  }

  private async saveSql(): Promise<void> {
    if (!this.uri) {
      const uri = await window.showSaveDialog({
        defaultUri: Uri.file('query.sql'),
        filters: {
          'SQL Files': ['sql']
        }
      })
      if (!uri) return
      this.uri = uri
    }

    await workspace.fs.writeFile(this.uri, new TextEncoder().encode(this.sql.endsWith('\n') ? this.sql : `${this.sql}\n`))
    this.panel.title = this.getFileName(this.uri)
    this.panel.webview.postMessage({ type: 'status', message: `Saved ${this.uri.fsPath}` })
    await this.postState({ includeMetadata: false })
  }

  private toWebviewResult(result: QueryResult): QueryResult {
    return {
      ...result,
      rows: result.rows.map(row => {
        const nextRow: Record<string, unknown> = {}
        for (const column of result.columns) {
          nextRow[column.name] = this.formatValueForWebview(row[column.name])
        }
        return nextRow
      })
    }
  }

  private formatValueForWebview(value: unknown): unknown {
    if (value === null) return null
    if (value === undefined) return ''
    if (value instanceof Date) return value.toISOString()
    if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    return value
  }

  private getContextLabel(profile: DbConnectionProfile): string {
    return [profile.name, this.scope.database, this.scope.schema].filter(Boolean).join(' / ')
  }

  private getFileName(uri: Uri): string {
    return uri.path.split('/').pop() || 'query.sql'
  }

  private mapDriverToFormatterDialect(driverId?: DatabaseDriverId): 'sql' | 'postgresql' | 'mysql' | 'mariadb' | 'sqlite' | 'duckdb' | 'clickhouse' {
    switch (driverId) {
      case 'postgresql':
      case 'cockroachdb':
        return 'postgresql'
      case 'mysql':
      case 'mariadb':
        return 'mysql'
      case 'sqlite':
        return 'sqlite'
      case 'duckdb':
        return 'duckdb'
      case 'clickhouse':
        return 'clickhouse'
      default:
        return 'sql'
    }
  }

  private render(): string {
    const nonce = String(Date.now())

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --border: var(--vscode-panel-border, rgba(127, 127, 127, 0.45));
      --toolbar: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
      --muted: var(--vscode-descriptionForeground);
      --active: var(--vscode-list-activeSelectionBackground);
      --active-foreground: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
      --hover: var(--vscode-list-hoverBackground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      overflow: hidden;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      min-height: 42px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--toolbar);
    }
    .toolbar-group {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      padding-right: 6px;
      border-right: 1px solid var(--border);
    }
    .toolbar-group:last-child { border-right: 0; }
    button, select, input {
      height: 28px;
      border: 1px solid var(--vscode-dropdown-border, var(--border));
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      font: inherit;
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      min-width: 30px;
      padding: 0 9px;
      border-radius: 3px;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    button:disabled, select:disabled { opacity: 0.55; cursor: not-allowed; }
    .primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    select {
      min-width: 134px;
      max-width: 210px;
      padding: 0 24px 0 8px;
    }
    .wide-select { min-width: 188px; }
    .workbench {
      min-height: 0;
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      overflow: hidden;
    }
    .workbench.has-result {
      grid-template-rows: minmax(132px, 1fr) minmax(112px, 36vh);
    }
    .editor-area {
      position: relative;
      min-width: 0;
      min-height: 0;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      overflow: hidden;
    }
    .editor-shell {
      min-height: 0;
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr);
      overflow: hidden;
    }
    .gutter {
      padding-top: 12px;
      border-right: 1px solid var(--border);
      color: var(--vscode-editorLineNumber-foreground);
      background: var(--vscode-editorGutter-background, var(--vscode-editor-background));
      text-align: right;
      user-select: none;
      overflow: hidden;
    }
    .gutter div {
      height: 20px;
      padding-right: 9px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 20px;
    }
    textarea {
      width: 100%;
      height: 100%;
      resize: none;
      border: 0;
      outline: 0;
      padding: 12px 14px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 20px;
      tab-size: 2;
      white-space: pre;
      overflow: auto;
    }
    .suggestions {
      position: absolute;
      z-index: 20;
      min-width: 168px;
      max-width: min(420px, calc(100% - 68px));
      max-height: 180px;
      overflow: auto;
      border: 1px solid var(--vscode-widget-border, var(--border));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-editor-background)));
      box-shadow: 0 6px 18px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
    }
    .suggestions.hidden,
    .results-panel.hidden {
      display: none;
    }
    .suggestion {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 12px;
      padding: 5px 8px;
      cursor: pointer;
    }
    .suggestion:hover { background: var(--hover); }
    .suggestion.active {
      color: var(--active-foreground);
      background: var(--active);
    }
    .suggestion-value {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
    }
    .suggestion-detail {
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .suggestion.active .suggestion-detail {
      color: inherit;
      opacity: 0.8;
    }
    .snippet-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 38px;
      padding: 5px 8px;
      border-top: 1px solid var(--border);
      background: var(--toolbar);
    }
    .snippet-bar button { height: 26px; font-size: 12px; }
    .spacer { flex: 1; min-width: 12px; }
    #contextLabel {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 12px;
    }
    .results-panel {
      min-height: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      border-top: 1px solid var(--border);
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    .results-header {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 32px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--border);
      background: var(--toolbar);
    }
    .results-header strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .results-wrap {
      min-height: 0;
      overflow: auto;
    }
    table {
      width: max-content;
      min-width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    th, td {
      max-width: 360px;
      border: 1px solid var(--border);
      padding: 5px 7px;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    }
    tbody tr:hover { background: var(--hover); }
    .result-empty,
    .result-error {
      padding: 12px;
      color: var(--muted);
      white-space: pre-wrap;
    }
    .result-error { color: var(--vscode-errorForeground); }
    .status {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      min-height: 28px;
      padding: 6px 10px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
    }
    .status span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @media (max-width: 720px) {
      .toolbar { align-content: start; }
      select { min-width: 112px; max-width: 160px; }
      .wide-select { min-width: 150px; }
      .workbench.has-result {
        grid-template-rows: minmax(120px, 1fr) minmax(104px, 34vh);
      }
      th, td { max-width: 240px; }
    }
  </style>
  <title>DB Nexus SQL</title>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-group">
      <button id="saveButton" title="Save SQL (Ctrl+S)">Save</button>
      <button id="copyButton" title="Copy SQL">Copy</button>
    </div>
    <div class="toolbar-group">
      <select id="connectionSelect" class="wide-select" title="Connection"></select>
      <select id="databaseSelect" title="Database"></select>
      <select id="schemaSelect" title="Schema"></select>
      <button id="refreshButton" title="Refresh metadata">Refresh</button>
    </div>
    <div class="toolbar-group">
      <button id="runButton" class="primary" title="Run selected SQL or whole editor (Ctrl+Enter)">Run</button>
      <button id="runSelectionButton" title="Run selection">Selection</button>
      <button id="stopButton" title="Stop" disabled>Stop</button>
      <button id="explainButton" title="Explain selected SQL or whole editor">Explain</button>
    </div>
    <div class="toolbar-group">
      <button id="formatButton" title="Beautify SQL (Ctrl+Shift+F)">Format</button>
      <button id="commentButton" title="Toggle line comment (Ctrl+/)">Comment</button>
      <button id="clearButton" title="Clear editor">Clear</button>
      <button id="askAiButton" title="Ask AI">Ask AI</button>
    </div>
  </div>
  <div class="workbench" id="workbench">
    <main class="editor-area" id="editorArea">
      <div class="editor-shell">
        <div class="gutter" id="gutter"></div>
        <textarea id="editor" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
      </div>
      <div class="suggestions hidden" id="suggestions"></div>
      <div class="snippet-bar">
        <button data-snippet="select">SELECT</button>
        <button data-snippet="insert">INSERT</button>
        <button data-snippet="update">UPDATE</button>
        <button data-snippet="delete">DELETE</button>
        <button data-snippet="create">CREATE</button>
        <div class="spacer"></div>
        <span id="contextLabel"></span>
      </div>
    </main>
    <section class="results-panel hidden" id="resultPanel">
      <div class="results-header">
        <strong id="resultSummary">Results</strong>
        <div class="spacer"></div>
        <button id="closeResultButton" title="Hide results">Close</button>
      </div>
      <div class="results-wrap" id="resultBody"></div>
    </section>
  </div>
  <div class="status"><span id="status">Ready</span><span id="cursorStatus">Ln 1, Col 1</span></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const workbench = document.getElementById('workbench');
    const editorArea = document.getElementById('editorArea');
    const editor = document.getElementById('editor');
    const gutter = document.getElementById('gutter');
    const suggestions = document.getElementById('suggestions');
    const status = document.getElementById('status');
    const cursorStatus = document.getElementById('cursorStatus');
    const contextLabel = document.getElementById('contextLabel');
    const connectionSelect = document.getElementById('connectionSelect');
    const databaseSelect = document.getElementById('databaseSelect');
    const schemaSelect = document.getElementById('schemaSelect');
    const refreshButton = document.getElementById('refreshButton');
    const runButton = document.getElementById('runButton');
    const runSelectionButton = document.getElementById('runSelectionButton');
    const stopButton = document.getElementById('stopButton');
    const explainButton = document.getElementById('explainButton');
    const saveButton = document.getElementById('saveButton');
    const copyButton = document.getElementById('copyButton');
    const formatButton = document.getElementById('formatButton');
    const commentButton = document.getElementById('commentButton');
    const clearButton = document.getElementById('clearButton');
    const askAiButton = document.getElementById('askAiButton');
    const resultPanel = document.getElementById('resultPanel');
    const resultSummary = document.getElementById('resultSummary');
    const resultBody = document.getElementById('resultBody');
    const closeResultButton = document.getElementById('closeResultButton');
    const sqlKeywords = [
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'FROM', 'WHERE',
      'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'ORDER', 'BY', 'HAVING',
      'LIMIT', 'OFFSET', 'VALUES', 'SET', 'INTO', 'AND', 'OR', 'NOT', 'NULL', 'IS',
      'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
      'AS', 'ASC', 'DESC', 'UNION', 'ALL', 'EXISTS', 'BETWEEN', 'LIKE', 'IN', 'TRUE', 'FALSE',
      'COALESCE', 'CAST', 'CURRENT_TIMESTAMP', 'NOW'
    ];
    const sqlKeywordSet = new Set(sqlKeywords.map(keyword => keyword.toLowerCase()));
    let initialized = false;
    let currentState = {
      suggestions: [],
      dialect: 'sql',
      selectedDatabase: '',
      selectedSchema: '',
      contextLabel: ''
    };
    let allSuggestions = [];
    let visibleSuggestions = [];
    let activeSuggestionIndex = 0;

    function setOptions(select, values, selectedValue, emptyLabel) {
      select.innerHTML = '';
      if (emptyLabel) {
        select.appendChild(new Option(emptyLabel, ''));
      }
      values.forEach(item => {
        const option = new Option(item.label || item, item.value || item);
        select.appendChild(option);
      });
      select.value = selectedValue || '';
      select.disabled = select.options.length === 0 || (select.options.length === 1 && select.options[0].value === '');
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function updateGutter() {
      const lineCount = Math.max(1, editor.value.split('\\n').length);
      let html = '';
      for (let i = 1; i <= lineCount; i++) {
        html += '<div>' + i + '</div>';
      }
      gutter.innerHTML = html;
    }

    function updateCursorStatus() {
      const before = editor.value.slice(0, editor.selectionStart);
      const lines = before.split('\\n');
      const line = lines.length;
      const column = lines[lines.length - 1].length + 1;
      const selected = Math.abs(editor.selectionEnd - editor.selectionStart);
      cursorStatus.textContent = selected > 0
        ? 'Ln ' + line + ', Col ' + column + ' | ' + selected + ' selected'
        : 'Ln ' + line + ', Col ' + column;
    }

    function getSelectedSql() {
      if (editor.selectionStart === editor.selectionEnd) {
        return editor.value;
      }
      return editor.value.slice(editor.selectionStart, editor.selectionEnd);
    }

    function replaceSelection(text) {
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
      editor.selectionStart = editor.selectionEnd = start + text.length;
      editor.focus();
      updateGutter();
      updateCursorStatus();
      updateSuggestions();
    }

    function buildSuggestions(state) {
      const combined = [];
      const seen = new Set();
      const add = item => {
        const value = String(item.value || '').trim();
        if (!value) return;
        const key = value.toLowerCase() + ':' + String(item.detail || item.kind || '').toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        combined.push({
          value,
          insertText: String(item.insertText || value),
          detail: String(item.detail || item.kind || ''),
          kind: String(item.kind || ''),
          tableName: String(item.tableName || ''),
          schemaName: String(item.schemaName || '')
        });
      };

      sqlKeywords.forEach(keyword => add({ value: keyword, insertText: keyword, detail: 'keyword', kind: 'keyword' }));
      (state.suggestions || []).forEach(add);
      return combined;
    }

    function getCurrentWordRange() {
      const position = editor.selectionStart;
      const text = editor.value;
      let start = position;
      let end = position;

      while (start > 0 && /[A-Za-z0-9_$]/.test(text.charAt(start - 1))) {
        start--;
      }
      while (end < text.length && /[A-Za-z0-9_$]/.test(text.charAt(end))) {
        end++;
      }

      let qualifier = '';
      let qualifierStart = start;
      if (start > 0 && text.charAt(start - 1) === '.') {
        let qStart = start - 1;
        while (qStart > 0 && /[A-Za-z0-9_$]/.test(text.charAt(qStart - 1))) {
          qStart--;
        }
        qualifier = text.slice(qStart, start - 1);
        qualifierStart = qStart;
      }

      return {
        start,
        end,
        prefix: text.slice(start, position),
        qualifier,
        qualifierStart,
        previousChar: text.charAt(start - 1)
      };
    }

    function normalizeIdentifier(value) {
      const tick = String.fromCharCode(96);
      const wrapperPattern = new RegExp('^[' + tick + '"\\\\[]+|[' + tick + '"\\\\]]+$', 'g');
      return String(value || '')
        .trim()
        .replace(wrapperPattern, '')
        .split('.')
        .pop()
        .replace(wrapperPattern, '')
        .toLowerCase();
    }

    function statementBeforeCursor(range) {
      const anchor = range.qualifier ? range.qualifierStart : range.start;
      const before = editor.value.slice(0, anchor);
      const lastSemicolon = before.lastIndexOf(';');
      return before.slice(lastSemicolon + 1);
    }

    function isSqlKeyword(value) {
      return sqlKeywordSet.has(String(value || '').toLowerCase());
    }

    function isTableLike(item) {
      return item.kind === 'table' || item.kind === 'view' || item.kind === 'materializedView';
    }

    function tableReferences(range) {
      const statement = statementBeforeCursor(range);
      const references = [];
      const tick = String.fromCharCode(96);
      const identifier = '[' + tick + '"\\\\[]?[A-Za-z0-9_$-]+[' + tick + '"\\\\]]?';
      const qualifiedIdentifier = identifier + '(?:\\\\s*\\\\.\\\\s*' + identifier + '){0,2}';
      const aliasStop = '(?!(?:on|where|join|left|right|inner|outer|full|cross|group|order|having|limit|offset|set|values)\\\\b)';
      const regex = new RegExp('\\\\b(?:from|join|update|into)\\\\s+(' + qualifiedIdentifier + ')(?:\\\\s+(?:as\\\\s+)?' + aliasStop + '([A-Za-z_][A-Za-z0-9_$]*))?', 'gi');
      let match;
      while ((match = regex.exec(statement))) {
        const table = normalizeIdentifier(match[1]);
        const alias = match[2] && !isSqlKeyword(match[2]) ? normalizeIdentifier(match[2]) : '';
        if (table) {
          references.push({ table, alias, raw: match[1] });
        }
      }
      return references;
    }

    function referencedTables(range) {
      const tables = [];
      tableReferences(range).forEach(reference => {
        if (reference.table && !tables.includes(reference.table)) {
          tables.push(reference.table);
        }
      });
      return tables;
    }

    function isTableNameContext(range) {
      const before = statementBeforeCursor(range);
      const tick = String.fromCharCode(96);
      const regex = new RegExp('\\\\b(from|join|update|into)\\\\s+[' + tick + '"\\\\[]?[A-Za-z0-9_$.-]*$', 'i');
      return regex.test(before);
    }

    function currentClause(range) {
      const before = statementBeforeCursor(range).toLowerCase();
      const clauseRegex = /\\b(select|from|join|on|where|group\\s+by|order\\s+by|having|set|values|into|update)\\b/g;
      let match;
      let clause = '';
      while ((match = clauseRegex.exec(before))) {
        clause = match[1].replace(/\\s+/g, ' ');
      }
      return clause;
    }

    function qualifierTarget(range) {
      const qualifier = normalizeIdentifier(range.qualifier);
      if (!qualifier) return '';

      const references = tableReferences(range);
      const reference = references.find(item => item.alias === qualifier || item.table === qualifier);
      if (reference) {
        return reference.table;
      }

      const table = allSuggestions.find(item => isTableLike(item) && normalizeIdentifier(item.value) === qualifier);
      return table ? normalizeIdentifier(table.value) : '';
    }

    function columnsForTables(tables) {
      return allSuggestions.filter(item => {
        if (item.kind !== 'column') return false;
        if (tables.length === 0) return true;
        return tables.includes(normalizeIdentifier(item.tableName));
      });
    }

    function isColumnNameContext(range) {
      if (range.qualifier) return true;
      if (isTableNameContext(range)) return false;

      const clause = currentClause(range);
      if (['select', 'where', 'on', 'group by', 'order by', 'having', 'set'].includes(clause)) {
        return true;
      }

      return referencedTables(range).length > 0;
    }

    function shouldShowEmptyPrefix(range) {
      if (range.qualifier) return true;
      if (isTableNameContext(range)) return true;
      if (!isColumnNameContext(range)) return false;

      const before = statementBeforeCursor(range);
      return /(?:^|[\\s,(=<>+\\-*])$/.test(before);
    }

    function suggestionPoolForContext(range) {
      const tableContext = isTableNameContext(range);
      const tables = referencedTables(range);
      const keywords = allSuggestions.filter(item => item.kind === 'keyword');
      const tableLike = allSuggestions.filter(isTableLike);
      const schemaLike = allSuggestions.filter(item => item.kind === 'schema');

      if (tableContext) {
        const schemaQualifier = normalizeIdentifier(range.qualifier);
        const scopedTables = schemaQualifier
          ? tableLike.filter(item => normalizeIdentifier(item.schemaName) === schemaQualifier)
          : tableLike;
        return (scopedTables.length > 0 ? scopedTables : tableLike).concat(schemaLike, keywords);
      }

      if (range.qualifier) {
        const target = qualifierTarget(range);
        const qualifiedColumns = target ? columnsForTables([target]) : columnsForTables([normalizeIdentifier(range.qualifier)]);
        return qualifiedColumns.concat(keywords);
      }

      const scopedColumns = columnsForTables(tables);
      if (isColumnNameContext(range) && scopedColumns.length > 0) {
        return scopedColumns.concat(keywords, tableLike);
      }
      return allSuggestions;
    }

    function hideSuggestions() {
      suggestions.classList.add('hidden');
      visibleSuggestions = [];
      activeSuggestionIndex = 0;
    }

    function renderSuggestions() {
      suggestions.innerHTML = visibleSuggestions.map((item, index) => {
        return '<div class="suggestion' + (index === activeSuggestionIndex ? ' active' : '') + '" data-index="' + index + '">' +
          '<span class="suggestion-value">' + escapeHtml(item.value) + '</span>' +
          '<span class="suggestion-detail">' + escapeHtml(item.detail) + '</span>' +
        '</div>';
      }).join('');
      positionSuggestions();
    }

    function positionSuggestions() {
      const range = getCurrentWordRange();
      const before = editor.value.slice(0, range.start);
      const lines = before.split('\\n');
      const lineIndex = lines.length - 1;
      const column = lines[lines.length - 1].length;
      const style = window.getComputedStyle(editor);
      const fontSize = parseFloat(style.fontSize) || 13;
      const lineHeight = parseFloat(style.lineHeight) || 20;
      const paddingLeft = parseFloat(style.paddingLeft) || 14;
      const paddingTop = parseFloat(style.paddingTop) || 12;
      const charWidth = Math.max(7, fontSize * 0.62);
      const minLeft = 56;
      const maxLeft = Math.max(minLeft, editorArea.clientWidth - 188);
      const maxTop = Math.max(8, editorArea.clientHeight - suggestions.offsetHeight - 42);
      const left = minLeft + paddingLeft + column * charWidth - editor.scrollLeft;
      const top = paddingTop + (lineIndex + 1) * lineHeight - editor.scrollTop;

      suggestions.style.left = Math.max(minLeft, Math.min(left, maxLeft)) + 'px';
      suggestions.style.top = Math.max(8, Math.min(top, maxTop)) + 'px';
    }

    function updateSuggestions() {
      if (editor.selectionStart !== editor.selectionEnd) {
        hideSuggestions();
        return;
      }

      const range = getCurrentWordRange();
      const prefix = range.prefix.trim();
      if (prefix.length === 0 && !shouldShowEmptyPrefix(range)) {
        hideSuggestions();
        return;
      }

      const lower = prefix.toLowerCase();
      visibleSuggestions = suggestionPoolForContext(range)
        .filter(item => {
          const value = item.value.toLowerCase();
          if (lower.length === 0) return true;
          return value.includes(lower) && value !== lower;
        })
        .sort((a, b) => {
          const tableContext = isTableNameContext(range);
          const columnContext = isColumnNameContext(range);
          const kindRank = tableContext
            ? { table: 0, view: 0, materializedView: 0, schema: 1, keyword: 2, column: 3 }
            : columnContext
              ? { column: 0, keyword: 1, table: 2, view: 2, materializedView: 2, schema: 3 }
              : { keyword: 0, table: 1, view: 1, materializedView: 1, column: 2, schema: 3 };
          const aRank = kindRank[a.kind] == null ? 3 : kindRank[a.kind];
          const bRank = kindRank[b.kind] == null ? 3 : kindRank[b.kind];
          if (aRank !== bRank) return aRank - bRank;
          const aStarts = a.value.toLowerCase().startsWith(lower) ? 0 : 1;
          const bStarts = b.value.toLowerCase().startsWith(lower) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
          const aSameTable = range.qualifier && normalizeIdentifier(a.tableName) === qualifierTarget(range) ? 0 : 1;
          const bSameTable = range.qualifier && normalizeIdentifier(b.tableName) === qualifierTarget(range) ? 0 : 1;
          if (aSameTable !== bSameTable) return aSameTable - bSameTable;
          return a.value.localeCompare(b.value);
        })
        .slice(0, 12);

      if (visibleSuggestions.length === 0) {
        hideSuggestions();
        return;
      }

      activeSuggestionIndex = 0;
      suggestions.classList.remove('hidden');
      renderSuggestions();
    }

    function acceptSuggestion(index) {
      const item = visibleSuggestions[index];
      if (!item) return false;
      const range = getCurrentWordRange();
      editor.value = editor.value.slice(0, range.start) + item.insertText + editor.value.slice(range.end);
      editor.selectionStart = editor.selectionEnd = range.start + item.insertText.length;
      hideSuggestions();
      editor.focus();
      updateGutter();
      updateCursorStatus();
      return true;
    }

    function formatSql(sql) {
      vscode.postMessage({ type: 'format', sql });
    }

    function currentTableName() {
      const firstTable = currentState.suggestions.find(item => {
        return item.kind === 'table' || item.kind === 'view' || item.kind === 'materializedView';
      });
      return firstTable ? firstTable.insertText : 'table_name';
    }

    function snippet(kind) {
      const table = currentTableName();
      if (kind === 'insert') return 'INSERT INTO ' + table + ' (\\n  column_name\\n) VALUES (\\n  value\\n);';
      if (kind === 'update') return 'UPDATE ' + table + '\\nSET\\n  column_name = value\\nWHERE\\n  id = value;';
      if (kind === 'delete') return 'DELETE FROM ' + table + '\\nWHERE\\n  id = value;';
      if (kind === 'create') return 'CREATE TABLE ' + table + ' (\\n  id BIGINT PRIMARY KEY\\n);';
      return 'SELECT\\n  *\\nFROM ' + table + '\\nLIMIT 100;';
    }

    function toggleComment() {
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const value = editor.value;
      const lineStart = value.lastIndexOf('\\n', Math.max(0, start - 1)) + 1;
      const lineEndIndex = value.indexOf('\\n', end);
      const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
      const block = value.slice(lineStart, lineEnd);
      const lines = block.split('\\n');
      const shouldUncomment = lines.every(line => line.trimStart().startsWith('--'));
      const nextBlock = lines.map(line => {
        if (shouldUncomment) {
          return line.replace(/^(\\s*)--\\s?/, '$1');
        }
        return line.length === 0 ? '--' : '-- ' + line;
      }).join('\\n');
      editor.value = value.slice(0, lineStart) + nextBlock + value.slice(lineEnd);
      editor.selectionStart = lineStart;
      editor.selectionEnd = lineStart + nextBlock.length;
      updateGutter();
      updateCursorStatus();
      updateSuggestions();
    }

    function getDisplayColumnName(name) {
      return String(name || '').trim() === '?column?' ? '' : String(name || '');
    }

    function formatValue(value) {
      if (value === null) return 'NULL';
      if (value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    }

    function renderResult(result) {
      workbench.classList.add('has-result');
      resultPanel.classList.remove('hidden');
      resultSummary.textContent = (result.rowCount || 0) + ' rows, ' + (result.elapsedMs || 0) + ' ms';

      const columns = result.columns || [];
      if (columns.length === 0) {
        resultBody.innerHTML = '<div class="result-empty">Done</div>';
        return;
      }

      const showHeaders = columns.some(column => getDisplayColumnName(column.name) !== '');
      const headers = showHeaders
        ? '<thead><tr>' + columns.map(column => '<th>' + escapeHtml(getDisplayColumnName(column.name)) + '</th>').join('') + '</tr></thead>'
        : '';
      const rows = (result.rows || []).map(row => {
        const cells = columns.map(column => {
          return '<td title="' + escapeHtml(formatValue(row[column.name])) + '">' + escapeHtml(formatValue(row[column.name])) + '</td>';
        }).join('');
        return '<tr>' + cells + '</tr>';
      }).join('');

      resultBody.innerHTML = '<table>' + headers + '<tbody>' + rows + '</tbody></table>';
    }

    function renderResultError(message) {
      workbench.classList.add('has-result');
      resultPanel.classList.remove('hidden');
      resultSummary.textContent = 'Error';
      resultBody.innerHTML = '<div class="result-error">' + escapeHtml(message || 'Query failed') + '</div>';
    }

    function hideResult() {
      workbench.classList.remove('has-result');
      resultPanel.classList.add('hidden');
    }

    function postRun(sql) {
      vscode.postMessage({ type: 'run', sql, editorSql: editor.value });
    }

    function postExplain(sql) {
      vscode.postMessage({ type: 'explain', sql, editorSql: editor.value });
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') {
        const state = message.state;
        currentState = state;
        allSuggestions = buildSuggestions(state);
        setOptions(connectionSelect, state.connections.map(item => ({ label: item.name + ' (' + item.driverId + ')', value: item.id })), state.selectedConnectionId);
        setOptions(databaseSelect, state.databases, state.selectedDatabase, 'Database');
        setOptions(schemaSelect, state.schemas, state.selectedSchema, 'Default schema');
        contextLabel.textContent = state.contextLabel || state.title || '';
        if (!initialized) {
          editor.value = state.sql || '';
          initialized = true;
        }
        updateGutter();
        updateCursorStatus();
        updateSuggestions();
      }
      if (message.type === 'busy') {
        const busy = Boolean(message.value);
        runButton.disabled = busy;
        runSelectionButton.disabled = busy;
        explainButton.disabled = busy;
        saveButton.disabled = busy;
        stopButton.disabled = true;
        if (busy) {
          status.textContent = 'Running...';
        }
      }
      if (message.type === 'status') {
        status.textContent = message.message || 'Ready';
      }
      if (message.type === 'result') {
        renderResult(message.result || {});
      }
      if (message.type === 'resultError') {
        renderResultError(message.message);
      }
      if (message.type === 'formatted' && typeof message.sql === 'string') {
        editor.value = message.sql;
        updateGutter();
        updateCursorStatus();
        updateSuggestions();
        status.textContent = 'SQL formatted';
      }
    });

    editor.addEventListener('input', () => { updateGutter(); updateCursorStatus(); updateSuggestions(); });
    editor.addEventListener('keyup', event => {
      updateCursorStatus();
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
        updateSuggestions();
      }
    });
    editor.addEventListener('click', () => { updateCursorStatus(); updateSuggestions(); });
    editor.addEventListener('select', () => { updateCursorStatus(); updateSuggestions(); });
    editor.addEventListener('scroll', () => {
      gutter.scrollTop = editor.scrollTop;
      if (!suggestions.classList.contains('hidden')) positionSuggestions();
    });
    editor.addEventListener('keydown', event => {
      if (!suggestions.classList.contains('hidden')) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          activeSuggestionIndex = Math.min(visibleSuggestions.length - 1, activeSuggestionIndex + 1);
          renderSuggestions();
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          activeSuggestionIndex = Math.max(0, activeSuggestionIndex - 1);
          renderSuggestions();
          return;
        }
        if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey) || event.key === 'Tab') {
          event.preventDefault();
          acceptSuggestion(activeSuggestionIndex);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          hideSuggestions();
          return;
        }
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        postRun(getSelectedSql());
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        vscode.postMessage({ type: 'save', sql: editor.value });
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        formatSql(editor.value);
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '/') {
        event.preventDefault();
        toggleComment();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.slice(0, start) + '  ' + editor.value.slice(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        updateGutter();
        updateCursorStatus();
        updateSuggestions();
      }
    });
    connectionSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectConnection', connectionId: connectionSelect.value }));
    databaseSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectDatabase', database: databaseSelect.value }));
    schemaSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectSchema', schema: schemaSelect.value }));
    refreshButton.addEventListener('click', () => vscode.postMessage({ type: 'refreshMetadata' }));
    runButton.addEventListener('click', () => postRun(getSelectedSql()));
    runSelectionButton.addEventListener('click', () => postRun(getSelectedSql()));
    explainButton.addEventListener('click', () => postExplain(getSelectedSql()));
    saveButton.addEventListener('click', () => vscode.postMessage({ type: 'save', sql: editor.value }));
    copyButton.addEventListener('click', () => {
      navigator.clipboard.writeText(editor.value).then(() => {
        status.textContent = 'Copied SQL';
      }, () => {
        status.textContent = 'Copy failed';
      });
    });
    formatButton.addEventListener('click', () => {
      formatSql(editor.value);
    });
    commentButton.addEventListener('click', toggleComment);
    clearButton.addEventListener('click', () => {
      editor.value = '';
      updateGutter();
      updateCursorStatus();
      hideSuggestions();
      editor.focus();
    });
    askAiButton.addEventListener('click', () => vscode.postMessage({ type: 'askAi', sql: editor.value }));
    closeResultButton.addEventListener('click', hideResult);
    suggestions.addEventListener('mousedown', event => {
      const row = event.target && event.target.closest ? event.target.closest('.suggestion') : null;
      if (!row) return;
      event.preventDefault();
      acceptSuggestion(Number(row.dataset.index || 0));
    });
    document.addEventListener('mousedown', event => {
      if (event.target !== editor && !suggestions.contains(event.target)) {
        hideSuggestions();
      }
    });
    window.addEventListener('resize', () => {
      if (!suggestions.classList.contains('hidden')) positionSuggestions();
    });
    document.querySelectorAll('[data-snippet]').forEach(button => {
      button.addEventListener('click', () => replaceSelection(snippet(button.dataset.snippet)));
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }
}
