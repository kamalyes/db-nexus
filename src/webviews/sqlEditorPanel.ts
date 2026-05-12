import { ExtensionContext, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode'
import { DbConnectionProfile, SchemaObject, SchemaScope } from '@/core/types'
import { DriverRegistry } from '@/drivers/registry'
import { t } from '@/i18n'
import { ConnectionService } from '@/services/connectionService'
import { QueryHistoryItem, QueryHistoryService } from '@/services/queryHistoryService'
import { QueryService } from '@/services/queryService'
import { ExecutionPlanPanel } from './executionPlanPanel'
import { ResultPanel } from './resultPanel'

interface SqlEditorOptions {
  sql?: string
  profile?: DbConnectionProfile
  scope?: SchemaScope
  title?: string
  uri?: Uri
}

interface SqlEditorState {
  connections: Array<{ id: string; name: string; driverId: string }>
  databases: string[]
  schemas: string[]
  objects: Array<{ name: string; type: SchemaObject['type']; schema?: string }>
  history: QueryHistoryItem[]
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
  private uri: Uri | undefined

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
      await this.postState()
      return
    }

    if (message.type === 'selectConnection' && typeof message.connectionId === 'string') {
      this.selectedProfile = this.connectionService.getConnections().find(profile => profile.id === message.connectionId)
      this.scope = {
        database: this.selectedProfile?.database
      }
      await this.postState()
      return
    }

    if (message.type === 'selectDatabase' && typeof message.database === 'string') {
      this.scope.database = message.database || undefined
      this.scope.schema = undefined
      await this.postState()
      return
    }

    if (message.type === 'selectSchema' && typeof message.schema === 'string') {
      this.scope.schema = message.schema || undefined
      await this.postState()
      return
    }

    if (message.type === 'run' && typeof message.sql === 'string') {
      this.sql = message.sql
      await this.runSql()
      return
    }

    if (message.type === 'explain' && typeof message.sql === 'string') {
      this.sql = message.sql
      await this.showExecutionPlan()
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

    if (message.type === 'refreshMetadata') {
      await this.postState()
    }
  }

  private async postState(): Promise<void> {
    this.panel.webview.postMessage({
      type: 'state',
      state: await this.getState()
    })
  }

  private async getState(): Promise<SqlEditorState> {
    const connections = this.connectionService.getConnections()
    if (!this.selectedProfile) {
      this.selectedProfile = connections[0]
    }

    const databases = await this.loadDatabases(this.selectedProfile)
    if (!this.scope.database) {
      this.scope.database = this.selectedProfile?.database || databases[0]
    }

    const schemas = await this.loadSchemas(this.selectedProfile, this.scope.database)
    if (schemas.length === 0) {
      this.scope.schema = undefined
    } else if (this.scope.schema && !schemas.includes(this.scope.schema)) {
      this.scope.schema = undefined
    }

    const objects = await this.loadObjects(this.selectedProfile, this.scope.database, this.scope.schema)
    const history = this.getHistory(this.selectedProfile)

    return {
      connections: connections.map(profile => ({
        id: profile.id,
        name: profile.name,
        driverId: profile.driverId
      })),
      databases,
      schemas,
      objects,
      history,
      selectedConnectionId: this.selectedProfile?.id || '',
      selectedDatabase: this.scope.database || '',
      selectedSchema: this.scope.schema || '',
      dialect: this.selectedProfile?.driverId || 'sql',
      sql: this.sql,
      title: this.uri ? this.getFileName(this.uri) : 'SQL Scratch',
      contextLabel: this.selectedProfile ? this.getContextLabel(this.selectedProfile) : ''
    }
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

  private async loadObjects(
    profile: DbConnectionProfile | undefined,
    database: string | undefined,
    schema: string | undefined
  ): Promise<Array<{ name: string; type: SchemaObject['type']; schema?: string }>> {
    if (!profile) return []

    try {
      const driver = this.driverRegistry.getDriver(profile.driverId)
      const objects = await driver.listObjects(profile, { database, schema })
      return objects
        .filter(object => object.type !== 'database')
        .map(object => ({
          name: object.name,
          type: object.type,
          schema: object.scope?.schema || schema
        }))
    } catch {
      return []
    }
  }

  private getHistory(profile: DbConnectionProfile | undefined): QueryHistoryItem[] {
    try {
      const history = QueryHistoryService.getInstance().getRecent(30)
      return profile
        ? history.filter(item => !item.connectionId || item.connectionId === profile.id)
        : history
    } catch {
      return []
    }
  }

  private async runSql(): Promise<void> {
    const profile = this.selectedProfile
    if (!profile || this.sql.trim().length === 0) {
      window.showWarningMessage(t('query.empty'))
      return
    }

    this.panel.webview.postMessage({ type: 'busy', value: true })
    try {
      const result = await this.queryService.run(profile, {
        sql: this.sql,
        database: this.scope.database,
        schema: this.scope.schema
      })
      ResultPanel.show(this.context, t('query.resultTitle', this.getContextLabel(profile)), result)
      await QueryHistoryService.getInstance().add(this.sql, profile, result)
      this.panel.webview.postMessage({ type: 'status', message: `${result.rowCount} rows, ${result.elapsedMs} ms` })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      await QueryHistoryService.getInstance().add(this.sql, profile, error instanceof Error ? error : new Error(message))
      window.showErrorMessage(t('query.failed', message))
      this.panel.webview.postMessage({ type: 'status', message })
    } finally {
      this.panel.webview.postMessage({ type: 'busy', value: false })
    }
  }

  private async showExecutionPlan(): Promise<void> {
    const profile = this.selectedProfile
    if (!profile || this.sql.trim().length === 0) {
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
      const plan = await driver.getExecutionPlan(profile, this.sql, this.scope)
      ExecutionPlanPanel.show(this.context, plan, this.sql)
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
    await this.postState()
  }

  private getContextLabel(profile: DbConnectionProfile): string {
    return [profile.name, this.scope.database, this.scope.schema].filter(Boolean).join(' / ')
  }

  private getFileName(uri: Uri): string {
    return uri.path.split('/').pop() || 'query.sql'
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
    .primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    .primary:hover { background: var(--vscode-button-hoverBackground); }
    select { min-width: 134px; max-width: 210px; padding: 0 24px 0 8px; }
    .wide-select { min-width: 188px; }
    .workbench {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(220px, 26vw) minmax(0, 1fr);
      overflow: hidden;
    }
    .sidebar {
      min-width: 0;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      border-right: 1px solid var(--border);
      background: var(--vscode-sideBar-background);
    }
    .tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      border-bottom: 1px solid var(--border);
    }
    .tab {
      height: 32px;
      border: 0;
      border-right: 1px solid var(--border);
      border-radius: 0;
      background: transparent;
      color: var(--vscode-foreground);
    }
    .tab:last-child { border-right: 0; }
    .tab.active {
      background: var(--vscode-tab-activeBackground, var(--vscode-editor-background));
      border-bottom: 2px solid var(--vscode-focusBorder);
    }
    .side-search {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }
    .side-search input {
      width: 100%;
      min-width: 0;
      padding: 0 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border-color: var(--vscode-input-border, var(--border));
    }
    .side-panel {
      min-height: 0;
      overflow: auto;
      padding: 6px;
    }
    .side-panel.hidden { display: none; }
    .object-row, .history-row {
      display: grid;
      gap: 2px;
      width: 100%;
      padding: 6px 7px;
      border-radius: 4px;
      cursor: pointer;
      user-select: none;
    }
    .object-row:hover, .history-row:hover { background: var(--hover); }
    .object-main, .history-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .object-name, .history-sql {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
    }
    .object-type, .history-meta {
      color: var(--muted);
      font-size: 11px;
      white-space: nowrap;
    }
    .history-error { color: var(--vscode-errorForeground); }
    .empty-state {
      padding: 12px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    .editor-area {
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
      .workbench { grid-template-columns: 1fr; grid-template-rows: minmax(150px, 32vh) minmax(0, 1fr); }
      .sidebar { border-right: 0; border-bottom: 1px solid var(--border); }
      select { min-width: 112px; }
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
  <div class="workbench">
    <aside class="sidebar">
      <div class="tabs">
        <button class="tab active" id="objectsTab">Objects</button>
        <button class="tab" id="historyTab">History</button>
      </div>
      <div class="side-search">
        <input id="sideFilter" type="search" placeholder="Filter objects or history">
        <button id="refreshButton" title="Refresh metadata">Refresh</button>
      </div>
      <div class="side-panel" id="objectsPanel"></div>
      <div class="side-panel hidden" id="historyPanel"></div>
    </aside>
    <main class="editor-area">
      <div class="editor-shell">
        <div class="gutter" id="gutter"></div>
        <textarea id="editor" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
      </div>
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
  </div>
  <div class="status"><span id="status">Ready</span><span id="cursorStatus">Ln 1, Col 1</span></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const editor = document.getElementById('editor');
    const gutter = document.getElementById('gutter');
    const status = document.getElementById('status');
    const cursorStatus = document.getElementById('cursorStatus');
    const contextLabel = document.getElementById('contextLabel');
    const connectionSelect = document.getElementById('connectionSelect');
    const databaseSelect = document.getElementById('databaseSelect');
    const schemaSelect = document.getElementById('schemaSelect');
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
    const refreshButton = document.getElementById('refreshButton');
    const objectsTab = document.getElementById('objectsTab');
    const historyTab = document.getElementById('historyTab');
    const objectsPanel = document.getElementById('objectsPanel');
    const historyPanel = document.getElementById('historyPanel');
    const sideFilter = document.getElementById('sideFilter');
    let initialized = false;
    let currentState = {
      objects: [],
      history: [],
      dialect: 'sql',
      selectedDatabase: '',
      selectedSchema: '',
      contextLabel: ''
    };
    let activeSidePanel = 'objects';

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
      return String(value || '')
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
    }

    function quoteIdentifier(value) {
      const text = String(value || '');
      if (currentState.dialect === 'mysql' || currentState.dialect === 'mariadb' || currentState.dialect === 'clickhouse') {
        const tick = String.fromCharCode(96);
        return tick + text.replace(new RegExp(tick, 'g'), tick + tick) + tick;
      }
      return '"' + text.replace(/"/g, '""') + '"';
    }

    function qualifiedName(object) {
      const parts = [];
      if (currentState.dialect === 'mysql' || currentState.dialect === 'mariadb' || currentState.dialect === 'clickhouse') {
        if (currentState.selectedDatabase) parts.push(currentState.selectedDatabase);
      } else if (currentState.dialect !== 'sqlite') {
        const schema = object.schema || currentState.selectedSchema;
        if (schema) parts.push(schema);
      }
      parts.push(object.name || 'table_name');
      return parts.map(quoteIdentifier).join('.');
    }

    function formatSql(sql) {
      return sql
        .replace(/\\s+/g, ' ')
        .replace(/\\b(from|where|group by|order by|having|limit|offset|values|set)\\b/gi, '\\n$1')
        .replace(/\\b(inner join|left join|right join|full join|join)\\b/gi, '\\n$1')
        .replace(/\\b(and|or)\\b/gi, '\\n  $1')
        .trim();
    }

    function currentTableName() {
      const firstTable = currentState.objects.find(item => item.type === 'table' || item.type === 'view' || item.type === 'materializedView');
      return firstTable ? qualifiedName(firstTable) : 'table_name';
    }

    function snippet(kind, object) {
      const table = object ? qualifiedName(object) : currentTableName();
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
    }

    function setSidePanel(panel) {
      activeSidePanel = panel;
      objectsTab.classList.toggle('active', panel === 'objects');
      historyTab.classList.toggle('active', panel === 'history');
      objectsPanel.classList.toggle('hidden', panel !== 'objects');
      historyPanel.classList.toggle('hidden', panel !== 'history');
      renderSidePanels();
    }

    function renderSidePanels() {
      const filter = sideFilter.value.trim().toLowerCase();
      const objects = currentState.objects.filter(item => {
        return !filter || item.name.toLowerCase().includes(filter) || item.type.toLowerCase().includes(filter);
      });
      objectsPanel.innerHTML = objects.length
        ? objects.map(item => {
            return '<div class="object-row" data-name="' + escapeHtml(item.name) + '" data-type="' + escapeHtml(item.type) + '" data-schema="' + escapeHtml(item.schema || '') + '">' +
              '<div class="object-main"><span class="object-name">' + escapeHtml(item.name) + '</span><span class="object-type">' + escapeHtml(item.type) + '</span></div>' +
              (item.schema ? '<div class="object-type">' + escapeHtml(item.schema) + '</div>' : '') +
            '</div>';
          }).join('')
        : '<div class="empty-state">' + (currentState.selectedSchema ? 'No objects in this schema' : 'Select a schema or database object') + '</div>';

      const history = currentState.history.filter(item => {
        const haystack = (item.sql + ' ' + (item.connectionName || '') + ' ' + (item.error || '')).toLowerCase();
        return !filter || haystack.includes(filter);
      });
      historyPanel.innerHTML = history.length
        ? history.map(item => {
            const sql = item.sql.replace(/\\s+/g, ' ').trim();
            const meta = new Date(item.timestamp).toLocaleString() + (item.success ? ' | ' + (item.rowCount || 0) + ' rows' : ' | failed');
            return '<div class="history-row" data-id="' + escapeHtml(item.id) + '">' +
              '<div class="history-main"><span class="history-sql">' + escapeHtml(sql) + '</span></div>' +
              '<div class="history-meta' + (item.success ? '' : ' history-error') + '">' + escapeHtml(meta) + '</div>' +
            '</div>';
          }).join('')
        : '<div class="empty-state">No query history</div>';
    }

    function closestFromEvent(event, selector) {
      const target = event.target;
      if (!target) return null;
      if (target.closest) return target.closest(selector);
      return target.parentElement ? target.parentElement.closest(selector) : null;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') {
        const state = message.state;
        currentState = state;
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
        renderSidePanels();
      }
      if (message.type === 'busy') {
        runButton.disabled = Boolean(message.value);
        runSelectionButton.disabled = Boolean(message.value);
        explainButton.disabled = Boolean(message.value);
        saveButton.disabled = Boolean(message.value);
        stopButton.disabled = true;
      }
      if (message.type === 'status') {
        status.textContent = message.message || 'Ready';
      }
    });

    editor.addEventListener('input', () => { updateGutter(); updateCursorStatus(); });
    editor.addEventListener('keyup', updateCursorStatus);
    editor.addEventListener('click', updateCursorStatus);
    editor.addEventListener('select', updateCursorStatus);
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        vscode.postMessage({ type: 'run', sql: getSelectedSql() });
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        vscode.postMessage({ type: 'save', sql: editor.value });
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        editor.value = formatSql(editor.value);
        updateGutter();
        updateCursorStatus();
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
      }
    });
    connectionSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectConnection', connectionId: connectionSelect.value }));
    databaseSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectDatabase', database: databaseSelect.value }));
    schemaSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectSchema', schema: schemaSelect.value }));
    runButton.addEventListener('click', () => vscode.postMessage({ type: 'run', sql: getSelectedSql() }));
    runSelectionButton.addEventListener('click', () => vscode.postMessage({ type: 'run', sql: getSelectedSql() }));
    explainButton.addEventListener('click', () => vscode.postMessage({ type: 'explain', sql: getSelectedSql() }));
    saveButton.addEventListener('click', () => vscode.postMessage({ type: 'save', sql: editor.value }));
    copyButton.addEventListener('click', () => {
      navigator.clipboard.writeText(editor.value).then(() => {
        status.textContent = 'Copied SQL';
      }, () => {
        status.textContent = 'Copy failed';
      });
    });
    formatButton.addEventListener('click', () => { editor.value = formatSql(editor.value); updateGutter(); updateCursorStatus(); });
    commentButton.addEventListener('click', toggleComment);
    clearButton.addEventListener('click', () => { editor.value = ''; updateGutter(); updateCursorStatus(); editor.focus(); });
    askAiButton.addEventListener('click', () => vscode.postMessage({ type: 'askAi', sql: editor.value }));
    refreshButton.addEventListener('click', () => vscode.postMessage({ type: 'refreshMetadata' }));
    objectsTab.addEventListener('click', () => setSidePanel('objects'));
    historyTab.addEventListener('click', () => setSidePanel('history'));
    sideFilter.addEventListener('input', renderSidePanels);
    document.querySelectorAll('[data-snippet]').forEach(button => {
      button.addEventListener('click', () => replaceSelection(snippet(button.dataset.snippet)));
    });
    objectsPanel.addEventListener('click', event => {
      const row = closestFromEvent(event, '.object-row');
      if (!row) return;
      const object = {
        name: row.dataset.name,
        type: row.dataset.type,
        schema: row.dataset.schema || currentState.selectedSchema
      };
      if (object.type === 'schema') {
        vscode.postMessage({ type: 'selectSchema', schema: object.name });
        return;
      }
      replaceSelection(qualifiedName(object));
    });
    historyPanel.addEventListener('click', event => {
      const row = closestFromEvent(event, '.history-row');
      if (!row) return;
      const item = currentState.history.find(entry => entry.id === row.dataset.id);
      if (!item) return;
      editor.value = item.sql;
      editor.focus();
      updateGutter();
      updateCursorStatus();
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }
}
