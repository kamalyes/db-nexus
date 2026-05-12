import { ExtensionContext, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode'
import { DbConnectionProfile, SchemaScope } from '@/core/types'
import { DriverRegistry } from '@/drivers/registry'
import { t } from '@/i18n'
import { ConnectionService } from '@/services/connectionService'
import { QueryHistoryService } from '@/services/queryHistoryService'
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
  selectedConnectionId: string
  selectedDatabase: string
  selectedSchema: string
  sql: string
  title: string
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
        database: this.selectedProfile?.database,
        schema: this.getDefaultSchema(this.selectedProfile)
      }
      await this.postState()
      return
    }

    if (message.type === 'selectDatabase' && typeof message.database === 'string') {
      this.scope.database = message.database || undefined
      this.scope.schema = this.getDefaultSchema(this.selectedProfile)
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
    } else if (!this.scope.schema || !schemas.includes(this.scope.schema)) {
      this.scope.schema = schemas.includes('public') ? 'public' : schemas[0]
    }

    return {
      connections: connections.map(profile => ({
        id: profile.id,
        name: profile.name,
        driverId: profile.driverId
      })),
      databases,
      schemas,
      selectedConnectionId: this.selectedProfile?.id || '',
      selectedDatabase: this.scope.database || '',
      selectedSchema: this.scope.schema || '',
      sql: this.sql,
      title: this.uri ? this.getFileName(this.uri) : 'SQL Scratch'
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

  private getDefaultSchema(profile: DbConnectionProfile | undefined): string | undefined {
    if (!profile) return undefined
    return profile.driverId === 'postgresql' || profile.driverId === 'cockroachdb' ? 'public' : undefined
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
    :root { --border: var(--vscode-panel-border, rgba(127, 127, 127, 0.45)); }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--vscode-sideBar-background); }
    .toolbar-group { display: inline-flex; align-items: center; gap: 4px; padding-right: 6px; border-right: 1px solid var(--border); }
    .toolbar-group:last-child { border-right: 0; }
    button, select { height: 28px; border: 1px solid var(--vscode-dropdown-border, var(--border)); color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); font: inherit; }
    button { display: inline-flex; align-items: center; gap: 4px; padding: 0 9px; cursor: pointer; }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }
    button:disabled, select:disabled { opacity: 0.55; cursor: not-allowed; }
    select { min-width: 150px; padding: 0 24px 0 8px; }
    .editor-shell { display: grid; grid-template-columns: 48px minmax(0, 1fr); height: calc(100vh - 69px); }
    .gutter { padding-top: 12px; border-right: 1px solid var(--border); color: var(--vscode-editorLineNumber-foreground); background: var(--vscode-editorGutter-background, var(--vscode-editor-background)); text-align: right; user-select: none; overflow: hidden; }
    .gutter div { height: 20px; padding-right: 9px; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 20px; }
    textarea { width: 100%; height: 100%; resize: none; border: 0; outline: 0; padding: 12px 14px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); line-height: 20px; tab-size: 2; }
    .status { height: 28px; padding: 6px 10px; border-top: 1px solid var(--border); color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  </style>
  <title>DB Nexus SQL</title>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-group">
      <button id="saveButton" title="Save">Save</button>
    </div>
    <div class="toolbar-group">
      <select id="connectionSelect" title="Connection"></select>
      <select id="databaseSelect" title="Database"></select>
      <select id="schemaSelect" title="Schema"></select>
    </div>
    <div class="toolbar-group">
      <button id="runButton" title="Run">Run</button>
      <button id="stopButton" title="Stop" disabled>Stop</button>
      <button id="explainButton" title="Explain">Explain</button>
    </div>
    <div class="toolbar-group">
      <button id="formatButton" title="Beautify SQL">Beautify SQL</button>
      <button id="snippetButton" title="Insert select template">Template</button>
      <button id="askAiButton" title="Ask AI">Ask AI</button>
    </div>
  </div>
  <div class="editor-shell">
    <div class="gutter" id="gutter"></div>
    <textarea id="editor" spellcheck="false"></textarea>
  </div>
  <div class="status" id="status">Ready</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const editor = document.getElementById('editor');
    const gutter = document.getElementById('gutter');
    const status = document.getElementById('status');
    const connectionSelect = document.getElementById('connectionSelect');
    const databaseSelect = document.getElementById('databaseSelect');
    const schemaSelect = document.getElementById('schemaSelect');
    const runButton = document.getElementById('runButton');
    const stopButton = document.getElementById('stopButton');
    const explainButton = document.getElementById('explainButton');
    const saveButton = document.getElementById('saveButton');
    const formatButton = document.getElementById('formatButton');
    const snippetButton = document.getElementById('snippetButton');
    const askAiButton = document.getElementById('askAiButton');
    let initialized = false;

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

    function updateGutter() {
      const lineCount = Math.max(1, editor.value.split('\\n').length);
      let html = '';
      for (let i = 1; i <= lineCount; i++) {
        html += '<div>' + i + '</div>';
      }
      gutter.innerHTML = html;
    }

    function formatSql(sql) {
      return sql
        .replace(/\\s+/g, ' ')
        .replace(/\\b(from|where|group by|order by|having|limit|offset|values|set)\\b/gi, '\\n$1')
        .replace(/\\b(inner join|left join|right join|full join|join)\\b/gi, '\\n$1')
        .replace(/\\b(and|or)\\b/gi, '\\n  $1')
        .trim();
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') {
        const state = message.state;
        setOptions(connectionSelect, state.connections.map(item => ({ label: item.name + ' (' + item.driverId + ')', value: item.id })), state.selectedConnectionId);
        setOptions(databaseSelect, state.databases, state.selectedDatabase, 'Database');
        setOptions(schemaSelect, state.schemas, state.selectedSchema, 'Schema');
        if (!initialized) {
          editor.value = state.sql || '';
          initialized = true;
        }
        updateGutter();
      }
      if (message.type === 'busy') {
        runButton.disabled = Boolean(message.value);
        explainButton.disabled = Boolean(message.value);
        saveButton.disabled = Boolean(message.value);
        stopButton.disabled = true;
      }
      if (message.type === 'status') {
        status.textContent = message.message || 'Ready';
      }
    });

    editor.addEventListener('input', updateGutter);
    editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
    editor.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        vscode.postMessage({ type: 'run', sql: editor.value });
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.slice(0, start) + '  ' + editor.value.slice(end);
        editor.selectionStart = editor.selectionEnd = start + 2;
        updateGutter();
      }
    });
    connectionSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectConnection', connectionId: connectionSelect.value }));
    databaseSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectDatabase', database: databaseSelect.value }));
    schemaSelect.addEventListener('change', () => vscode.postMessage({ type: 'selectSchema', schema: schemaSelect.value }));
    runButton.addEventListener('click', () => vscode.postMessage({ type: 'run', sql: editor.value }));
    explainButton.addEventListener('click', () => vscode.postMessage({ type: 'explain', sql: editor.value }));
    saveButton.addEventListener('click', () => vscode.postMessage({ type: 'save', sql: editor.value }));
    formatButton.addEventListener('click', () => { editor.value = formatSql(editor.value); updateGutter(); });
    snippetButton.addEventListener('click', () => {
      const snippet = 'SELECT *\\nFROM table_name\\nLIMIT 100;';
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = editor.value.slice(0, start) + snippet + editor.value.slice(end);
      editor.selectionStart = editor.selectionEnd = start + snippet.length;
      editor.focus();
      updateGutter();
    });
    askAiButton.addEventListener('click', () => vscode.postMessage({ type: 'askAi', sql: editor.value }));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }
}
