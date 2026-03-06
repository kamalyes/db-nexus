import { ExtensionContext, ViewColumn, WebviewPanel, window, commands, Uri } from 'vscode'
import { DbConnectionProfile, DatabaseDriverId } from '@/core/types'
import { ConnectionStore } from '@/core/connectionStore'
import { DriverRegistry } from '@/drivers/registry'
import { SecretService } from '@/services/secretService'
import { t } from '@/i18n'
import { SUPPORTED_DRIVERS } from '@/core/constants'
import { connectionStatusManager } from '@/services/connectionStatusManager'

export class ConnectionDashboard {
  private static currentPanel: ConnectionDashboard | undefined
  private static _context: ExtensionContext | undefined
  private static _connectionStore: ConnectionStore | undefined
  private static _driverRegistry: DriverRegistry | undefined
  private readonly _panel: WebviewPanel
  private _disposables: any[] = []

  static show(
    context: ExtensionContext,
    connectionStore: ConnectionStore,
    driverRegistry: DriverRegistry
  ): void {
    ConnectionDashboard._context = context
    ConnectionDashboard._connectionStore = connectionStore
    ConnectionDashboard._driverRegistry = driverRegistry

    const column = ViewColumn.One

    if (ConnectionDashboard.currentPanel) {
      ConnectionDashboard.currentPanel._panel.reveal()
      ConnectionDashboard.currentPanel._refresh()
      return
    }

    const panel = window.createWebviewPanel(
      'dbNexus.connectionDashboard',
      t('dashboard.title'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    ConnectionDashboard.currentPanel = new ConnectionDashboard(
      panel,
      connectionStore,
      driverRegistry
    )
  }

  static showAddForm(): void {
    if (ConnectionDashboard.currentPanel) {
      ConnectionDashboard.currentPanel._showAddForm()
    }
  }

  static showEditForm(id: string): void {
    if (ConnectionDashboard.currentPanel) {
      ConnectionDashboard.currentPanel._showEditForm(id)
    }
  }

  private constructor(
    panel: WebviewPanel,
    connectionStore: ConnectionStore,
    driverRegistry: DriverRegistry
  ) {
    this._panel = panel

    this._refresh()

    this._panel.webview.onDidReceiveMessage(async (message) => {
      await this._handleMessage(message)
    })

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)
  }

  private async _handleMessage(message: { type: string; id?: string; profile?: Partial<DbConnectionProfile> }): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const registry = ConnectionDashboard._driverRegistry!

    switch (message.type) {
      case 'refresh':
        await this._refresh()
        break

      case 'addConnection':
        await this._showAddForm()
        break

      case 'editConnection':
        if (message.id) {
          await this._showEditForm(message.id)
        }
        break

      case 'deleteConnection':
        if (message.id) {
          await this._deleteConnection(message.id)
        }
        break

      case 'testConnection':
        if (message.id) {
          await this._testConnection(message.id)
        }
        break

      case 'connect':
        if (message.id) {
          await this._connect(message.id)
        }
        break

      case 'disconnect':
        if (message.id) {
          await this._disconnect(message.id)
        }
        break

      case 'saveConnection':
        if (message.profile) {
          await this._saveConnection(message.profile as DbConnectionProfile)
        }
        break

      case 'cancelForm':
        this._refresh()
        break

      case 'openQuery':
        if (message.id) {
          const profile = store.getAll().find(c => c.id === message.id)
          if (profile) {
            await commands.executeCommand('dbNexus.openSqlScratch')
          }
        }
        break

      case 'openSchema':
        if (message.id) {
          await commands.executeCommand('dbNexus.refreshConnections')
        }
        break
    }
  }

  private async _refresh(): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const connections = store.getAll()
    const statuses = connectionStatusManager.getAllStatuses()

    this._panel.webview.html = this._getHtml(connections, statuses)
  }

  private async _showAddForm(): Promise<void> {
    this._panel.webview.html = this._getFormHtml()
  }

  private async _showEditForm(id: string): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const profile = store.getAll().find(c => c.id === id)
    if (profile) {
      this._panel.webview.html = this._getFormHtml(profile)
    }
  }

  private async _deleteConnection(id: string): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const profile = store.getAll().find(c => c.id === id)
    if (!profile) return

    const confirm = await window.showWarningMessage(
      t('connection.deleteConfirm', profile.name),
      { modal: true },
      t('common.delete')
    )

    if (confirm === t('common.delete')) {
      const driver = ConnectionDashboard._driverRegistry?.getDriver(profile.driverId)
      if (driver?.dispose) {
        await driver.dispose(id)
      }
      await store.remove(id)
      connectionStatusManager.clearStatus(id)
      await commands.executeCommand('dbNexus.refreshConnections')
      await this._refresh()
      window.showInformationMessage(t('connection.deleted', profile.name))
    }
  }

  private async _testConnection(id: string): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const registry = ConnectionDashboard._driverRegistry!
    const profile = store.getAll().find(c => c.id === id)
    if (!profile) return

    const driver = registry.getDriver(profile.driverId)
    if (driver.dispose) {
      await driver.dispose(id)
    }
    
    connectionStatusManager.setStatus(id, 'connecting')
    await this._refresh()

    const result = await driver.testConnection(profile)
    
    connectionStatusManager.setStatus(
      id,
      result.ok ? 'connected' : 'error',
      result.latencyMs,
      result.ok ? undefined : result.message
    )

    if (!result.ok && driver.dispose) {
      await driver.dispose(id)
    }

    await commands.executeCommand('dbNexus.refreshConnections')
    await this._refresh()

    if (result.ok) {
      window.showInformationMessage(t('connection.testSuccess', String(result.latencyMs)))
    } else {
      window.showErrorMessage(t('connection.testFailed', result.message))
    }
  }

  private async _connect(id: string): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const registry = ConnectionDashboard._driverRegistry!
    const profile = store.getAll().find(c => c.id === id)
    if (!profile) return

    const driver = registry.getDriver(profile.driverId)
    if (driver.dispose) {
      await driver.dispose(id)
    }

    connectionStatusManager.setStatus(id, 'connecting')
    await this._refresh()
    
    const result = await driver.testConnection(profile)

    if (result.ok) {
      connectionStatusManager.setStatus(id, 'connected', result.latencyMs)
      await commands.executeCommand('dbNexus.refreshConnections')
      await this._refresh()
      window.showInformationMessage(t('connection.connected', profile.name))
    } else {
      connectionStatusManager.setStatus(id, 'error', undefined, result.message)
      if (driver.dispose) {
        await driver.dispose(id)
      }
      await commands.executeCommand('dbNexus.refreshConnections')
      await this._refresh()
      window.showErrorMessage(t('connection.connectFailed', result.message))
    }
  }

  private async _disconnect(id: string): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const registry = ConnectionDashboard._driverRegistry!
    const profile = store.getAll().find(c => c.id === id)
    if (!profile) return

    const driver = registry.getDriver(profile.driverId)
    if (driver.dispose) {
      await driver.dispose(id)
    }

    connectionStatusManager.setStatus(id, 'disconnected')

    await this._refresh()
    window.showInformationMessage(t('connection.disconnected', profile.name))
  }

  private async _saveConnection(profileData: Partial<DbConnectionProfile>): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const registry = ConnectionDashboard._driverRegistry!
    const isEdit = !!profileData.id
    const previousProfile = isEdit
      ? store.getAll().find(connection => connection.id === profileData.id)
      : undefined
    const profile: DbConnectionProfile = {
      id: profileData.id || this._generateId(),
      name: profileData.name || '',
      driverId: profileData.driverId || 'postgresql',
      host: profileData.host,
      port: profileData.port,
      database: profileData.database,
      username: profileData.username,
      filePath: profileData.filePath,
      ssl: profileData.ssl,
      createdAt: profileData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }

    if (isEdit) {
      const previousDriver = previousProfile ? registry.getDriver(previousProfile.driverId) : undefined
      if (previousDriver?.dispose) {
        await previousDriver.dispose(profile.id)
      }
      connectionStatusManager.clearStatus(profile.id)

      const connections = store.getAll()
      const updated = connections.map(c => c.id === profile.id ? profile : c)
      await store.saveAll(updated)
      window.showInformationMessage(t('connection.updated', profile.name))
    } else {
      await store.add(profile)
      window.showInformationMessage(t('connection.added', profile.name))
    }

    await commands.executeCommand('dbNexus.refreshConnections')
    await this._refresh()
  }

  private _generateId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private _getHtml(connections: DbConnectionProfile[], statuses: { profileId: string; status: string; latency?: number; error?: string }[]): string {
    const statusMap = new Map(statuses.map(s => [s.profileId, s]))
    
    const connectionCards = connections.map((profile) => {
      const statusObj = statusMap.get(profile.id)
      const status = statusObj || { status: 'disconnected' as const, latency: undefined, error: undefined }
      const driverDef = SUPPORTED_DRIVERS.find(d => d.id === profile.driverId)
      const statusColor = status.status === 'connected' ? '#4CAF50' : status.status === 'error' ? '#f48771' : status.status === 'connecting' ? '#fbbf24' : '#888'
      const statusText = status.status === 'connected' ? '● Connected' : status.status === 'error' ? '● Error' : status.status === 'connecting' ? '◐ Connecting' : '○ Disconnected'

      return `
        <div class="connection-card" data-id="${profile.id}">
          <div class="card-header">
            <div class="card-title">
              <span class="driver-icon">${this._getDriverEmoji(profile.driverId)}</span>
              <span class="connection-name">${this._escapeHtml(profile.name)}</span>
            </div>
            <div class="card-status" style="color: ${statusColor}">
              ${statusText}
              ${status.latency ? `<span class="latency">(${status.latency}ms)</span>` : ''}
            </div>
          </div>
          <div class="card-body">
            <div class="connection-info">
              <div class="info-row">
                <span class="info-label">Driver:</span>
                <span class="info-value">${driverDef?.displayName || profile.driverId}</span>
              </div>
              ${profile.host ? `
                <div class="info-row">
                  <span class="info-label">Host:</span>
                  <span class="info-value">${this._escapeHtml(profile.host)}${profile.port ? ':' + profile.port : ''}</span>
                </div>
              ` : ''}
              ${profile.database ? `
                <div class="info-row">
                  <span class="info-label">Database:</span>
                  <span class="info-value">${this._escapeHtml(profile.database)}</span>
                </div>
              ` : ''}
              ${profile.filePath ? `
                <div class="info-row">
                  <span class="info-label">File:</span>
                  <span class="info-value">${this._escapeHtml(profile.filePath)}</span>
                </div>
              ` : ''}
              ${status.error ? `
                <div class="error-message">
                  ${this._escapeHtml(status.error)}
                </div>
              ` : ''}
            </div>
          </div>
          <div class="card-actions">
            ${status.status === 'connected' ? `
              <button class="btn btn-primary" onclick="disconnect('${profile.id}')">Disconnect</button>
              <button class="btn btn-secondary" onclick="openQuery('${profile.id}')">Query</button>
            ` : `
              <button class="btn btn-primary" onclick="connect('${profile.id}')">Connect</button>
            `}
            <button class="btn btn-secondary" onclick="testConnection('${profile.id}')">Test</button>
            <button class="btn btn-icon" onclick="editConnection('${profile.id}')" title="Edit">✏️</button>
            <button class="btn btn-icon btn-danger" onclick="deleteConnection('${profile.id}')" title="Delete">🗑️</button>
          </div>
        </div>
      `
    }).join('')

    const emptyState = connections.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">🗄️</div>
        <div class="empty-title">No Connections Yet</div>
        <div class="empty-desc">Add your first database connection to get started</div>
        <button class="btn btn-primary btn-large" onclick="addConnection()">+ Add Connection</button>
      </div>
    ` : ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('dashboard.title')}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-foreground, #d4d4d4);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 20px;
      min-height: 100vh;
    }
    .dashboard { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .header h1 {
      color: var(--vscode-textLink-foreground, #4CAF50);
      font-size: 22px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header-actions { display: flex; gap: 8px; }
    .btn {
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      transition: all 0.15s;
      border: 1px solid transparent;
      background: var(--vscode-button-secondaryBackground, #2d2d2d);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .btn:hover { opacity: 0.9; }
    .btn-primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border-color: var(--vscode-button-background, #0e639c);
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #2d2d2d);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .btn-icon {
      padding: 6px 10px;
      font-size: 14px;
    }
    .btn-danger:hover {
      background: rgba(244, 135, 113, 0.2);
      border-color: #f48771;
    }
    .btn-large {
      padding: 12px 24px;
      font-size: 15px;
    }
    .connections-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
      gap: 16px;
    }
    .connection-card {
      background: var(--vscode-editor-inactiveSelectionBackground, #252526);
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 8px;
      overflow: hidden;
      transition: all 0.15s;
    }
    .connection-card:hover {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .card-header {
      padding: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .card-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }
    .driver-icon { font-size: 20px; }
    .connection-name { font-size: 15px; }
    .card-status {
      font-size: 12px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .latency { opacity: 0.7; font-size: 11px; }
    .card-body { padding: 12px 16px; }
    .connection-info { font-size: 13px; }
    .info-row {
      display: flex;
      gap: 8px;
      margin-bottom: 4px;
    }
    .info-label {
      color: var(--vscode-descriptionForeground, #888);
      min-width: 70px;
    }
    .info-value {
      color: var(--vscode-foreground, #d4d4d4);
      word-break: break-all;
    }
    .error-message {
      margin-top: 8px;
      padding: 8px;
      background: rgba(244, 135, 113, 0.1);
      border: 1px solid rgba(244, 135, 113, 0.3);
      border-radius: 4px;
      font-size: 12px;
      color: #f48771;
    }
    .card-actions {
      padding: 12px 16px;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    .empty-state {
      text-align: center;
      padding: 60px 20px;
    }
    .empty-icon { font-size: 64px; margin-bottom: 16px; }
    .empty-title {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground, #d4d4d4);
    }
    .empty-desc {
      color: var(--vscode-descriptionForeground, #888);
      margin-bottom: 24px;
    }
    .stats {
      display: flex;
      gap: 24px;
      margin-bottom: 20px;
    }
    .stat-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .stat-value {
      font-weight: 600;
      color: var(--vscode-foreground, #d4d4d4);
    }
  </style>
</head>
<body>
  <div class="dashboard">
    <div class="header">
      <h1>🗄️ ${t('dashboard.title')}</h1>
      <div class="header-actions">
        <button class="btn btn-secondary" onclick="refresh()">🔄 Refresh</button>
        <button class="btn btn-primary" onclick="addConnection()">+ Add Connection</button>
      </div>
    </div>

    ${connections.length > 0 ? `
      <div class="stats">
        <div class="stat-item">
          <span>Total:</span>
          <span class="stat-value">${connections.length}</span>
        </div>
        <div class="stat-item">
          <span>Connected:</span>
          <span class="stat-value">${statuses.filter(s => s.status === 'connected').length}</span>
        </div>
      </div>
      <div class="connections-grid">
        ${connectionCards}
      </div>
    ` : emptyState}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function addConnection() {
      vscode.postMessage({ type: 'addConnection' });
    }

    function editConnection(id) {
      vscode.postMessage({ type: 'editConnection', id });
    }

    function deleteConnection(id) {
      vscode.postMessage({ type: 'deleteConnection', id });
    }

    function testConnection(id) {
      vscode.postMessage({ type: 'testConnection', id });
    }

    function connect(id) {
      vscode.postMessage({ type: 'connect', id });
    }

    function disconnect(id) {
      vscode.postMessage({ type: 'disconnect', id });
    }

    function openQuery(id) {
      vscode.postMessage({ type: 'openQuery', id });
    }
  </script>
</body>
</html>`
  }

  private _getFormHtml(existingProfile?: DbConnectionProfile): string {
    const isEdit = !!existingProfile
    const title = isEdit ? t('form.editConnection') : t('form.addConnection')
    const selectedDriver = existingProfile?.driverId || 'postgresql'
    const selectedDriverName = SUPPORTED_DRIVERS.find(driver => driver.id === selectedDriver)?.displayName || selectedDriver
    
    const driverIcons = SUPPORTED_DRIVERS
      .filter(d => d.implemented)
      .map(d => {
        const isSelected = d.id === selectedDriver
        return `
          <div class="driver-card ${isSelected ? 'selected' : ''}" data-driver="${d.id}" onclick="selectDriver('${d.id}')">
            <div class="driver-icon">${this._getDriverEmoji(d.id as DatabaseDriverId)}</div>
            <div class="driver-name">${d.displayName}</div>
          </div>
        `
      }).join('')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-foreground, #d4d4d4);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      padding: 20px;
    }
    .form-container { max-width: 600px; margin: 0 auto; }
    .form-header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .form-header h1 {
      color: var(--vscode-textLink-foreground, #4CAF50);
      font-size: 22px;
    }
    .form-group { margin-bottom: 16px; }
    .form-label {
      display: block;
      margin-bottom: 8px;
      font-size: 13px;
      color: var(--vscode-foreground, #d4d4d4);
    }
    .form-label .required { color: #f48771; }
    .form-input {
      width: 100%;
      padding: 10px 12px;
      background: var(--vscode-input-background, #3c3c3c);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px;
      color: var(--vscode-input-foreground, #d4d4d4);
      font-size: 14px;
      transition: border-color 0.15s;
    }
    .form-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .form-checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .form-checkbox input {
      width: 18px;
      height: 18px;
      cursor: pointer;
    }
    .form-actions {
      display: flex;
      gap: 12px;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    .btn {
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.15s;
      border: 1px solid transparent;
    }
    .btn-primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #2d2d2d);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      margin: 20px 0 12px;
      color: var(--vscode-foreground, #d4d4d4);
    }
    .driver-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .driver-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px 8px;
      background: var(--vscode-editor-inactiveSelectionBackground, #252526);
      border: 2px solid var(--vscode-panel-border, #333);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .driver-card:hover {
      border-color: var(--vscode-focusBorder, #007fd4);
      background: var(--vscode-editor-selectionBackground, #264f78);
    }
    .driver-card.selected {
      border-color: var(--vscode-button-background, #0e639c);
      background: rgba(14, 99, 156, 0.2);
    }
    .driver-icon {
      font-size: 28px;
      margin-bottom: 6px;
    }
    .driver-name {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      text-align: center;
    }
    .driver-card.selected .driver-name {
      color: var(--vscode-foreground, #d4d4d4);
    }
  </style>
</head>
<body>
  <div class="form-container">
    <div class="form-header">
      <h1>${isEdit ? '✏️' : '➕'} ${title}</h1>
    </div>

    <form id="connectionForm">
      <input type="hidden" id="id" value="${existingProfile?.id || ''}">
      <input type="hidden" id="createdAt" value="${existingProfile?.createdAt || ''}">
      <input type="hidden" id="driverId" value="${selectedDriver}">

      <div class="form-group">
        <label class="form-label">${t('form.connectionName')} <span class="required">*</span></label>
        <input type="text" id="name" class="form-input" value="${this._escapeHtml(existingProfile?.name || selectedDriverName)}" required placeholder="My Database">
      </div>

      <div class="form-group">
        <label class="form-label">${t('driver.selectType')} <span class="required">*</span></label>
        <div class="driver-grid">
          ${driverIcons}
        </div>
      </div>

      <div id="serverFields">
        <div class="section-title">Server Settings</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">${t('form.host')}</label>
            <input type="text" id="host" class="form-input" value="${existingProfile?.host || 'localhost'}" placeholder="localhost">
          </div>
          <div class="form-group">
            <label class="form-label">${t('form.port')}</label>
            <input type="number" id="port" class="form-input" value="${existingProfile?.port || ''}" placeholder="Auto">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">${t('form.database')}</label>
            <input type="text" id="database" class="form-input" value="${this._escapeHtml(existingProfile?.database || '')}" placeholder="Database name">
          </div>
          <div class="form-group">
            <label class="form-label">${t('form.username')}</label>
            <input type="text" id="username" class="form-input" value="${this._escapeHtml(existingProfile?.username || '')}" placeholder="Username">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">${t('form.password')}</label>
          <input type="password" id="password" class="form-input" placeholder="Password (stored securely)">
        </div>
        <div class="form-group">
          <div class="form-checkbox">
            <input type="checkbox" id="ssl" ${existingProfile?.ssl ? 'checked' : ''}>
            <label for="ssl">${t('form.sslEnabled')}</label>
          </div>
        </div>
      </div>

      <div id="fileFields" style="display: none;">
        <div class="section-title">File Settings</div>
        <div class="form-group">
          <label class="form-label">${t('form.filePath')} <span class="required">*</span></label>
          <input type="text" id="filePath" class="form-input" value="${this._escapeHtml(existingProfile?.filePath || '')}" placeholder="/path/to/database.db">
        </div>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">${isEdit ? t('form.saveOnly') : 'Add Connection'}</button>
        <button type="button" class="btn btn-secondary" onclick="cancel()">Cancel</button>
      </div>
    </form>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const fileDrivers = ['sqlite', 'duckdb'];
    const isEdit = ${JSON.stringify(isEdit)};
    const driverNames = ${JSON.stringify(Object.fromEntries(SUPPORTED_DRIVERS.map(driver => [driver.id, driver.displayName])))};
    let nameWasEdited = isEdit;

    document.getElementById('name').addEventListener('input', function() {
      nameWasEdited = true;
    });

    function selectDriver(driverId) {
      const previousDriverId = document.getElementById('driverId').value;
      document.getElementById('driverId').value = driverId;
      
      document.querySelectorAll('.driver-card').forEach(card => {
        card.classList.remove('selected');
      });
      document.querySelector('.driver-card[data-driver="' + driverId + '"]').classList.add('selected');

      const nameInput = document.getElementById('name');
      const previousDriverName = driverNames[previousDriverId] || previousDriverId;
      if (!isEdit && (!nameWasEdited || nameInput.value === previousDriverName)) {
        nameInput.value = driverNames[driverId] || driverId;
        nameWasEdited = false;
      }
      
      updateDriverFields();
    }

    function updateDriverFields() {
      const driverId = document.getElementById('driverId').value;
      const serverFields = document.getElementById('serverFields');
      const fileFields = document.getElementById('fileFields');
      
      if (fileDrivers.includes(driverId)) {
        serverFields.style.display = 'none';
        fileFields.style.display = 'block';
      } else {
        serverFields.style.display = 'block';
        fileFields.style.display = 'none';
      }

      const defaultPorts = {
        'postgresql': 5432,
        'mysql': 3306,
        'mariadb': 3306,
        'cockroachdb': 26257,
        'clickhouse': 8123
      };
      
      const portInput = document.getElementById('port');
      if (defaultPorts[driverId] && !portInput.value) {
        portInput.value = defaultPorts[driverId];
      }
    }

    function cancel() {
      vscode.postMessage({ type: 'cancelForm' });
    }

    document.getElementById('connectionForm').addEventListener('submit', function(e) {
      e.preventDefault();
      
      const driverId = document.getElementById('driverId').value;
      const isFileDriver = fileDrivers.includes(driverId);
      
      const profile = {
        id: document.getElementById('id').value || undefined,
        name: document.getElementById('name').value,
        driverId: driverId,
        host: isFileDriver ? undefined : document.getElementById('host').value,
        port: isFileDriver ? undefined : parseInt(document.getElementById('port').value) || undefined,
        database: isFileDriver ? undefined : document.getElementById('database').value,
        username: isFileDriver ? undefined : document.getElementById('username').value,
        filePath: isFileDriver ? document.getElementById('filePath').value : undefined,
        ssl: isFileDriver ? false : document.getElementById('ssl').checked,
        createdAt: document.getElementById('createdAt').value || undefined
      };

      vscode.postMessage({ type: 'saveConnection', profile });
    });

    updateDriverFields();
  </script>
</body>
</html>`
  }

  private _getDriverEmoji(driverId: DatabaseDriverId): string {
    const emojis: Record<string, string> = {
      'postgresql': '🐘',
      'mysql': '🐬',
      'mariadb': '🐬',
      'sqlite': '📦',
      'duckdb': '🦆',
      'clickhouse': '⚡',
      'cockroachdb': '🪳'
    }
    return emojis[driverId] || '🗄️'
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  private dispose(): void {
    ConnectionDashboard.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }
}
