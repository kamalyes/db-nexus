import { ExtensionContext, ViewColumn, WebviewPanel, window, commands, Uri } from 'vscode'
import { DbConnectionProfile, DatabaseDriverId } from '@/core/types'
import { ConnectionStore } from '@/core/connectionStore'
import { DriverRegistry } from '@/drivers/registry'
import { SecretService } from '@/services/secretService'
import { t } from '@/i18n'
import { SUPPORTED_DRIVERS } from '@/core/constants'
import { connectionStatusManager } from '@/services/connectionStatusManager'
import { TableDataPanel } from '@/webviews/tableDataPanel'
import { TableSchemaPanel } from '@/webviews/tableSchemaPanel'

interface ConnectionDashboardMessage {
  type: string
  id?: string
  driverId?: DatabaseDriverId
  profile?: Partial<DbConnectionProfile>
  password?: string
  savePassword?: boolean
  requestId?: number
}

export class ConnectionDashboard {
  private static currentPanel: ConnectionDashboard | undefined
  private static _context: ExtensionContext | undefined
  private static _connectionStore: ConnectionStore | undefined
  private static _driverRegistry: DriverRegistry | undefined
  private readonly _panel: WebviewPanel
  private _disposables: any[] = []
  private _viewMode: 'dashboard' | 'form' = 'dashboard'

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

  static refreshCurrent(): void {
    if (ConnectionDashboard.currentPanel) {
      void ConnectionDashboard.currentPanel._refresh()
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

    connectionStatusManager.onDidChangeStatus(() => {
      if (this._viewMode === 'dashboard') {
        void this._refresh()
      }
    }, null, this._disposables)

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)
  }

  private async _handleMessage(message: ConnectionDashboardMessage): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const registry = ConnectionDashboard._driverRegistry!

    switch (message.type) {
      case 'refresh':
        await this._refresh()
        break

      case 'addConnection':
        await this._showAddForm()
        break

      case 'addConnectionFromUrl':
        await commands.executeCommand('dbNexus.addConnectionFromUrl')
        await this._refresh()
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

      case 'copyConnectionUrl':
        if (message.id) {
          await commands.executeCommand('dbNexus.copyConnectionUrl', message.id)
        }
        break

      case 'testDraftConnection':
        if (message.profile) {
          await this._testDraftConnection(message.profile, message.password, message.requestId)
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
          await this._saveConnection(message.profile, message.password, message.savePassword)
        }
        break

      case 'browseFile':
        await this._browseConnectionFile(message.driverId)
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

    this._viewMode = 'dashboard'
    this._panel.webview.html = this._getDashboardHtml(connections, statuses)
  }

  private async _showAddForm(): Promise<void> {
    this._viewMode = 'form'
    this._panel.webview.html = this._getConnectionWizardHtml()
  }

  private async _showEditForm(id: string): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const profile = store.getAll().find(c => c.id === id)
    if (profile) {
      this._viewMode = 'form'
      this._panel.webview.html = this._getConnectionWizardHtml(profile)
    }
  }

  private async _browseConnectionFile(driverId?: DatabaseDriverId): Promise<void> {
    const filters: Record<string, string[]> = driverId === 'duckdb'
      ? { DuckDB: ['duckdb', 'ddb', 'db'], 'All files': ['*'] }
      : { SQLite: ['sqlite', 'sqlite3', 'db'], DuckDB: ['duckdb', 'ddb'], 'All files': ['*'] }
    const picked = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters
    })
    const filePath = picked?.[0]?.fsPath
    if (filePath) {
      await this._panel.webview.postMessage({ type: 'fileSelected', filePath })
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
      await SecretService.getInstance().deletePassword(id)
      TableSchemaPanel.closeFor(profile)
      TableDataPanel.closeFor(profile)
      connectionStatusManager.clearStatus(id)
      await commands.executeCommand('dbNexus.refreshConnections')
      await commands.executeCommand('workbench.actions.treeView.dbNexus.connections.collapseAll').then(undefined, () => undefined)
      await this._refresh()
      window.showInformationMessage(t('connection.deleted', profile.name))
    }
  }

  private async _testConnection(id: string): Promise<void> {
    await commands.executeCommand('dbNexus.testConnection', id)
    await this._refresh()
  }

  private async _testDraftConnection(profileData: Partial<DbConnectionProfile>, password?: string, requestId?: number): Promise<void> {
    const registry = ConnectionDashboard._driverRegistry!
    const driverId = profileData.driverId || 'mysql'
    const sourceProfileId = profileData.id
    const profile = this._normalizeProfile(profileData, this._generateId())
    const driver = registry.getDriver(driverId)
    const secretService = SecretService.getInstance()
    const existingPassword = !password && sourceProfileId
      ? await secretService.getPassword(sourceProfileId)
      : undefined
    const testPassword = password || existingPassword

    if (testPassword) {
      await secretService.storePassword(profile.id, testPassword)
    }

    try {
      const result = await driver.testConnection(profile)
      if (result.ok) {
        const message = t('connection.testSuccess', String(result.latencyMs || 0))
        await this._panel.webview.postMessage({ type: 'draftConnectionTestResult', ok: true, message, requestId })
        window.showInformationMessage(message)
      } else {
        const message = t('connection.testFailed', result.message)
        await this._panel.webview.postMessage({ type: 'draftConnectionTestResult', ok: false, message, requestId })
        window.showErrorMessage(message)
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      const message = t('connection.testFailed', detail)
      await this._panel.webview.postMessage({ type: 'draftConnectionTestResult', ok: false, message, requestId })
      window.showErrorMessage(message)
    } finally {
      if (testPassword) {
        await secretService.deletePassword(profile.id)
      }
      if (driver.dispose) {
        await driver.dispose(profile.id).then(undefined, () => undefined)
      }
    }
  }

  private async _connect(id: string): Promise<void> {
    await commands.executeCommand('dbNexus.connectConnection', id)
    await this._refresh()
  }

  private async _disconnect(id: string): Promise<void> {
    await commands.executeCommand('dbNexus.disconnectConnection', id)
    await this._refresh()
  }

  private async _saveConnection(profileData: Partial<DbConnectionProfile>, password?: string, savePassword = true): Promise<void> {
    const store = ConnectionDashboard._connectionStore!
    const registry = ConnectionDashboard._driverRegistry!
    const isEdit = !!profileData.id
    const previousProfile = isEdit
      ? store.getAll().find(connection => connection.id === profileData.id)
      : undefined
    const profile = this._normalizeProfile(profileData, profileData.id || this._generateId())
    let savedProfile = profile

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
      const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = profile
      savedProfile = await store.add(input)
      window.showInformationMessage(t('connection.added', savedProfile.name))
    }

    const secretService = SecretService.getInstance()
    if (!savePassword) {
      await secretService.deletePassword(savedProfile.id)
    } else if (password) {
      await secretService.storePassword(savedProfile.id, password)
    }

    await commands.executeCommand('dbNexus.refreshConnections')
    await this._refresh()
  }

  private _normalizeProfile(profileData: Partial<DbConnectionProfile>, id: string): DbConnectionProfile {
    return {
      id,
      name: profileData.name || '',
      driverId: profileData.driverId || 'mysql',
      host: profileData.host,
      port: profileData.port,
      database: profileData.database,
      username: profileData.username,
      filePath: profileData.filePath,
      ssl: profileData.ssl,
      clientDriver: profileData.clientDriver,
      charset: profileData.charset,
      keepAliveInterval: profileData.keepAliveInterval,
      connectTimeout: profileData.connectTimeout,
      readTimeout: profileData.readTimeout,
      writeTimeout: profileData.writeTimeout,
      useCompression: profileData.useCompression,
      autoConnect: profileData.autoConnect,
      initialQuery: profileData.initialQuery,
      note: profileData.note,
      createdAt: profileData.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  }

  private _generateId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  private _getDashboardHtml(connections: DbConnectionProfile[], statuses: { profileId: string; status: string; latency?: number; error?: string }[]): string {
    const statusMap = new Map(statuses.map(s => [s.profileId, s]))
    const total = connections.length
    const connectedCount = connections.filter(profile => statusMap.get(profile.id)?.status === 'connected').length
    const errorCount = connections.filter(profile => statusMap.get(profile.id)?.status === 'error').length
    const availableCount = total - connectedCount - errorCount
    const statusLabels: Record<string, string> = {
      connected: t('dashboard.statusConnected'),
      disconnected: t('dashboard.statusDisconnected'),
      connecting: 'Connecting',
      error: t('dashboard.statusError')
    }
    const driverColors: Record<string, string> = {
      mysql: '#2ea043',
      mariadb: '#c6905b',
      postgresql: '#3b82f6',
      cockroachdb: '#7c3aed',
      sqlite: '#14b8a6',
      duckdb: '#eab308',
      clickhouse: '#f59e0b',
      sqlserver: '#ef4444',
      oracle: '#dc2626',
      mongodb: '#22c55e',
      redis: '#f97316',
      snowflake: '#38bdf8'
    }
    const icon = (body: string) => `<svg class="icon" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`
    const icons = {
      database: icon('<path fill="currentColor" d="M8 1C4.7 1 2 2.1 2 3.5v9C2 13.9 4.7 15 8 15s6-1.1 6-2.5v-9C14 2.1 11.3 1 8 1Zm0 1.4c2.9 0 4.6.8 4.6 1.1S10.9 4.6 8 4.6s-4.6-.8-4.6-1.1S5.1 2.4 8 2.4Zm4.6 10.1c0 .3-1.7 1.1-4.6 1.1s-4.6-.8-4.6-1.1v-2.1C4.5 11.1 6.2 11.5 8 11.5s3.5-.4 4.6-1.1v2.1Zm0-4.5C12.6 8.3 10.9 9.1 8 9.1S3.4 8.3 3.4 8V5.8C4.5 6.5 6.2 6.9 8 6.9s3.5-.4 4.6-1.1V8Z"/>'),
      refresh: icon('<path fill="currentColor" d="M13.7 2.3v4.2H9.5l1.7-1.7A4.7 4.7 0 0 0 3.8 6l-1.2-.6a6.1 6.1 0 0 1 9.6-1.5l1.5-1.6ZM2.3 13.7V9.5h4.2l-1.7 1.7A4.7 4.7 0 0 0 12.2 10l1.2.6a6.1 6.1 0 0 1-9.6 1.5l-1.5 1.6Z"/>'),
      plus: icon('<path fill="currentColor" d="M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25V2Z"/>'),
      connect: icon('<path fill="currentColor" d="M5.2 6.7 2.8 4.3 4.3 2.8l2.4 2.4 1.5-1.5 1.1 1.1-4.5 4.5-1.1-1.1 1.5-1.5Zm5.6 2.6 2.4 2.4-1.5 1.5-2.4-2.4-1.5 1.5-1.1-1.1 4.5-4.5 1.1 1.1-1.5 1.5Z"/>'),
      query: icon('<path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Zm1.5 0v9h9v-9h-9Zm1.4 2.1 1-.9 2.1 2.1-2.1 2.1-1-.9 1.2-1.2-1.2-1.2Zm3.8 4.5h3.1v1.3H8.7v-1.3Z"/>'),
      test: icon('<path fill="currentColor" d="M6.8 1.8h2.4v1.4l3.9 6.6A2.8 2.8 0 0 1 10.7 14H5.3a2.8 2.8 0 0 1-2.4-4.2l3.9-6.6V1.8Zm1.4 2.1H7.8L4.1 10.5A1.4 1.4 0 0 0 5.3 12.6h5.4a1.4 1.4 0 0 0 1.2-2.1L8.2 3.9ZM5.4 9.7h5.2l.8 1.4H4.6l.8-1.4Z"/>'),
      link: icon('<path fill="currentColor" d="M6.2 10.9 5.1 12a2.2 2.2 0 0 1-3.1-3.1l2.2-2.2a2.2 2.2 0 0 1 3.1 0l.6.6-1.1 1.1-.6-.6a.7.7 0 0 0-1 0L3 10a.7.7 0 0 0 1 1l1.1-1.1 1.1 1Zm-.4-2 3.1-3.1 1.1 1.1L6.9 10 5.8 8.9Zm2.3-.2-.6-.6 1.1-1.1.6.6a.7.7 0 0 0 1 0L12.4 5.4a.7.7 0 0 0-1-1l-1.1 1.1-1.1-1.1 1.1-1.1a2.2 2.2 0 0 1 3.1 3.1l-2.2 2.2a2.2 2.2 0 0 1-3.1.1Z"/>'),
      copy: icon('<path fill="currentColor" d="M5 1.5h7.5V11H11V3H5V1.5Zm-1.5 3h7.5V14H3.5V4.5Zm1.5 1.5v6.5h4.5V6H5Z"/>'),
      edit: icon('<path fill="currentColor" d="m11.7 1.7 2.6 2.6-7.9 7.9-3.3.7.7-3.3 7.9-7.9ZM4.9 10.3l-.2.9.9-.2 6.7-6.7-.7-.7-6.7 6.7Z"/>'),
      delete: icon('<path fill="currentColor" d="M6.5 1h3l.7 1.5H14V4H2V2.5h3.8L6.5 1ZM3.2 5h9.6l-.7 9H3.9l-.7-9Zm2 1.4.4 6.2H7L6.6 6.4H5.2Zm3.8 0-.4 6.2H10l.4-6.2H9Z"/>'),
      server: icon('<path fill="currentColor" d="M3 2h10a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm0 7h10a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Zm1.2-5.2v1.4h1.4V3.8H4.2Zm0 7v1.4h1.4v-1.4H4.2Z"/>')
    }
    const shortName = (name: string) => name.split(/\s+/).map(part => part.charAt(0)).join('').slice(0, 3).toUpperCase() || 'DB'
    const endpoint = (profile: DbConnectionProfile) => {
      if (profile.filePath) return profile.filePath
      const host = profile.host || 'localhost'
      return `${host}${profile.port ? `:${profile.port}` : ''}`
    }
    const scope = (profile: DbConnectionProfile) => profile.database || profile.username || 'default workspace'
    const connectionCards = connections.map(profile => {
      const statusObj = statusMap.get(profile.id)
      const status = statusObj?.status || 'disconnected'
      const driverDef = SUPPORTED_DRIVERS.find(d => d.id === profile.driverId)
      const driverName = driverDef?.displayName || profile.driverId
      const driverColor = driverColors[profile.driverId] || '#64748b'
      const latency = statusObj?.latency ? `${statusObj.latency}ms` : ''
      const id = this._escapeHtml(profile.id)
      return `
        <article class="connection-card ${status}" data-id="${id}">
          <div class="status-rail"></div>
          <header class="card-head">
            <div class="identity">
              <span class="driver-mark" style="--driver-color:${driverColor}">${this._escapeHtml(shortName(driverName))}</span>
              <div class="title-stack">
                <h2>${this._escapeHtml(profile.name)}</h2>
                <span>${this._escapeHtml(driverName)}</span>
              </div>
            </div>
            <div class="status-pill ${status}">
              <span class="pulse"></span>
              <span>${this._escapeHtml(statusLabels[status] || status)}</span>
              ${latency ? `<b>${latency}</b>` : ''}
            </div>
          </header>

          <div class="meta-grid">
            <div class="meta-item">
              <span class="meta-icon">${icons.server}</span>
              <div>
                <label>Endpoint</label>
                <strong>${this._escapeHtml(endpoint(profile))}</strong>
              </div>
            </div>
            <div class="meta-item">
              <span class="meta-icon">${icons.database}</span>
              <div>
                <label>Scope</label>
                <strong>${this._escapeHtml(scope(profile))}</strong>
              </div>
            </div>
          </div>

          ${statusObj?.error ? `<div class="error-message">${this._escapeHtml(statusObj.error)}</div>` : ''}

          <footer class="card-actions">
            ${status === 'connected' ? `
              <button class="btn primary danger-soft" data-action="disconnect" data-id="${id}">${icons.connect}<span>${t('dashboard.actions.disconnect')}</span></button>
              <button class="btn" data-action="openQuery" data-id="${id}">${icons.query}<span>${t('dashboard.actions.query')}</span></button>
            ` : `
              <button class="btn primary" data-action="connect" data-id="${id}">${icons.connect}<span>${t('dashboard.actions.connect')}</span></button>
            `}
            <button class="btn" data-action="testConnection" data-id="${id}">${icons.test}<span>${t('dashboard.actions.test')}</span></button>
            <button class="icon-btn" data-action="copyConnectionUrl" data-id="${id}" title="${t('dashboard.actions.copyUrl')}">${icons.copy}</button>
            <button class="icon-btn" data-action="editConnection" data-id="${id}" title="${t('dashboard.actions.edit')}">${icons.edit}</button>
            <button class="icon-btn danger" data-action="deleteConnection" data-id="${id}" title="${t('dashboard.actions.delete')}">${icons.delete}</button>
          </footer>
        </article>
      `
    }).join('')
    const emptyState = `
      <section class="empty-state">
        <div class="empty-mark">${icons.database}</div>
        <h2>${t('dashboard.noConnections')}</h2>
        <p>${t('dashboard.noConnectionsDesc')}</p>
        <button class="btn primary large" data-action="addConnection">${icons.plus}<span>${t('dashboard.addConnection')}</span></button>
      </section>
    `

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('dashboard.title')}</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      color-scheme: dark light;
      --surface: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
      --surface-2: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-foreground) 16%);
      --line: color-mix(in srgb, var(--vscode-panel-border) 80%, var(--vscode-foreground) 20%);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-textLink-foreground);
      --ok: #2ea043;
      --warn: #d29922;
      --bad: #f85149;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .dashboard {
      width: min(1280px, calc(100vw - 40px));
      margin: 0 auto;
      padding: 24px 0 36px;
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: end;
      padding: 22px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.18);
    }
    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .hero h1 {
      margin: 8px 0 6px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 700;
    }
    .hero p {
      margin: 0;
      color: var(--muted);
      max-width: 720px;
    }
    .hero-actions, .card-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 10px;
      margin: 16px 0 18px;
    }
    .summary-item {
      min-height: 74px;
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }
    .summary-item span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .summary-item strong {
      display: block;
      font-size: 24px;
      line-height: 1;
    }
    .summary-item.ok strong { color: var(--ok); }
    .summary-item.warn strong { color: var(--warn); }
    .summary-item.bad strong { color: var(--bad); }
    .connections-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 14px;
    }
    .connection-card {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      transition: border-color .16s ease, transform .16s ease, box-shadow .16s ease;
    }
    .connection-card:hover {
      transform: translateY(-1px);
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 16px 34px rgba(0, 0, 0, 0.2);
    }
    .status-rail {
      position: absolute;
      inset: 0 auto 0 0;
      width: 4px;
      background: var(--muted);
    }
    .connection-card.connected .status-rail { background: var(--ok); }
    .connection-card.connecting .status-rail { background: var(--warn); }
    .connection-card.error .status-rail { background: var(--bad); }
    .card-head {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      padding: 16px 16px 12px 20px;
      border-bottom: 1px solid var(--line);
    }
    .identity {
      display: flex;
      min-width: 0;
      gap: 12px;
      align-items: center;
    }
    .driver-mark {
      display: inline-grid;
      place-items: center;
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      border-radius: 8px;
      background: color-mix(in srgb, var(--driver-color) 18%, transparent);
      color: color-mix(in srgb, var(--driver-color) 76%, var(--vscode-foreground) 24%);
      border: 1px solid color-mix(in srgb, var(--driver-color) 42%, transparent);
      font-size: 13px;
      font-weight: 800;
    }
    .title-stack { min-width: 0; }
    .title-stack h2 {
      margin: 0 0 4px;
      font-size: 16px;
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .title-stack span {
      display: block;
      color: var(--muted);
      font-size: 12px;
    }
    .status-pill {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      padding: 5px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--surface-2);
      font-size: 12px;
    }
    .status-pill b {
      color: var(--muted);
      font-weight: 600;
    }
    .status-pill.connected { color: var(--ok); }
    .status-pill.connecting { color: var(--warn); }
    .status-pill.error { color: var(--bad); }
    .pulse {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      padding: 14px 16px 10px 20px;
    }
    .meta-item {
      display: grid;
      grid-template-columns: 26px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      min-width: 0;
      padding: 10px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--surface-2) 68%, transparent);
      border: 1px solid color-mix(in srgb, var(--line) 72%, transparent);
    }
    .meta-icon {
      display: inline-grid;
      place-items: center;
      color: var(--accent);
    }
    label {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 3px;
    }
    .meta-item strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 600;
    }
    .error-message {
      margin: 0 16px 10px 20px;
      padding: 9px 10px;
      border: 1px solid color-mix(in srgb, var(--bad) 38%, transparent);
      border-radius: 8px;
      background: color-mix(in srgb, var(--bad) 12%, transparent);
      color: var(--bad);
      font-size: 12px;
      line-height: 1.45;
    }
    .card-actions {
      padding: 12px 16px 16px 20px;
    }
    .btn, .icon-btn {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--vscode-foreground);
      cursor: pointer;
      transition: border-color .14s ease, background .14s ease, transform .14s ease;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 32px;
      padding: 7px 11px;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
    }
    .btn:hover, .icon-btn:hover {
      border-color: var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--surface-2) 72%, var(--accent) 28%);
    }
    .btn.primary {
      border-color: var(--vscode-button-background);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn.danger-soft {
      border-color: color-mix(in srgb, var(--bad) 45%, var(--line));
      background: color-mix(in srgb, var(--bad) 22%, var(--surface-2));
      color: var(--vscode-foreground);
    }
    .btn.large {
      min-height: 38px;
      padding: 9px 14px;
    }
    .icon-btn {
      display: inline-grid;
      place-items: center;
      width: 32px;
      height: 32px;
      padding: 0;
    }
    .icon-btn.danger:hover {
      border-color: var(--bad);
      color: var(--bad);
      background: color-mix(in srgb, var(--bad) 14%, var(--surface-2));
    }
    .icon {
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
    }
    .empty-state {
      display: grid;
      place-items: center;
      text-align: center;
      gap: 10px;
      min-height: 340px;
      padding: 40px 20px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }
    .empty-mark {
      display: grid;
      place-items: center;
      width: 64px;
      height: 64px;
      border-radius: 8px;
      color: var(--accent);
      border: 1px solid var(--line);
      background: var(--surface-2);
    }
    .empty-mark .icon {
      width: 34px;
      height: 34px;
    }
    .empty-state h2 {
      margin: 8px 0 0;
      font-size: 18px;
    }
    .empty-state p {
      margin: 0 0 8px;
      color: var(--muted);
    }
    @media (max-width: 760px) {
      .dashboard { width: min(100vw - 24px, 1280px); padding-top: 12px; }
      .hero { grid-template-columns: 1fr; align-items: start; padding: 16px; }
      .summary-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .connections-grid { grid-template-columns: 1fr; }
      .card-head { flex-direction: column; align-items: stretch; }
      .meta-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="dashboard">
    <section class="hero">
      <div>
        <span class="eyebrow">${icons.database}<span>DB Nexus</span></span>
        <h1>${t('dashboard.title')}</h1>
        <p>Manage live sessions, drivers, endpoints, and query entry points from one focused control surface.</p>
      </div>
      <div class="hero-actions">
        <button class="btn" data-action="refresh">${icons.refresh}<span>${t('dashboard.refresh')}</span></button>
        <button class="btn" data-action="addConnectionFromUrl">${icons.link}<span>${t('dashboard.addFromUrl')}</span></button>
        <button class="btn primary" data-action="addConnection">${icons.plus}<span>${t('dashboard.addConnection')}</span></button>
      </div>
    </section>

    <section class="summary-strip" aria-label="Connection summary">
      <div class="summary-item"><span>${t('dashboard.total')}</span><strong>${total}</strong></div>
      <div class="summary-item ok"><span>${t('dashboard.connected')}</span><strong>${connectedCount}</strong></div>
      <div class="summary-item warn"><span>Idle</span><strong>${availableCount}</strong></div>
      <div class="summary-item bad"><span>${t('dashboard.statusError')}</span><strong>${errorCount}</strong></div>
    </section>

    ${connections.length > 0 ? `<section class="connections-grid">${connectionCards}</section>` : emptyState}
  </main>

  <script>
    const vscode = acquireVsCodeApi();
    const actionMap = {
      refresh: function() { vscode.postMessage({ type: 'refresh' }); },
      addConnection: function() { vscode.postMessage({ type: 'addConnection' }); },
      addConnectionFromUrl: function() { vscode.postMessage({ type: 'addConnectionFromUrl' }); },
      editConnection: function(id) { vscode.postMessage({ type: 'editConnection', id: id }); },
      deleteConnection: function(id) { vscode.postMessage({ type: 'deleteConnection', id: id }); },
      testConnection: function(id) { vscode.postMessage({ type: 'testConnection', id: id }); },
      copyConnectionUrl: function(id) { vscode.postMessage({ type: 'copyConnectionUrl', id: id }); },
      connect: function(id) { vscode.postMessage({ type: 'connect', id: id }); },
      disconnect: function(id) { vscode.postMessage({ type: 'disconnect', id: id }); },
      openQuery: function(id) { vscode.postMessage({ type: 'openQuery', id: id }); }
    };
    document.addEventListener('click', function(event) {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.getAttribute('data-action');
      const id = target.getAttribute('data-id');
      if (actionMap[action]) actionMap[action](id);
    });
  </script>
</body>
</html>`
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

  private _getConnectionWizardHtml(existingProfile?: DbConnectionProfile): string {
    const isEdit = !!existingProfile
    const title = isEdit ? t('form.editConnection') : t('form.addConnection')
    const storedProfiles = ConnectionDashboard._connectionStore?.getAll() || []
    const selectedDriver = existingProfile?.driverId || storedProfiles[0]?.driverId || 'mysql'
    const selectedDriverDef = SUPPORTED_DRIVERS.find(driver => driver.id === selectedDriver) || SUPPORTED_DRIVERS[0]
    const selectedDriverName = selectedDriverDef?.displayName || selectedDriver
    const recentDriverIds = Array.from(new Set([selectedDriver, ...storedProfiles.map(profile => profile.driverId)])).slice(0, 4)
    const drivers = SUPPORTED_DRIVERS.map(driver => ({
      id: driver.id,
      displayName: driver.displayName,
      family: driver.family,
      defaultPort: driver.defaultPort,
      implemented: driver.implemented
    }))
    const nameValue = existingProfile?.name || selectedDriverName
    const hostValue = existingProfile?.host || 'localhost'
    const portValue = existingProfile?.port || selectedDriverDef?.defaultPort || ''
    const databaseValue = existingProfile?.database || ''
    const usernameValue = existingProfile?.username || ''
    const filePathValue = existingProfile?.filePath || ''
    const clientDriverValue = existingProfile?.clientDriver || 'default'
    const charsetValue = existingProfile?.charset || 'auto'
    const keepAliveValue = existingProfile?.keepAliveInterval ?? 240
    const connectTimeoutValue = existingProfile?.connectTimeout ?? 30
    const readTimeoutValue = existingProfile?.readTimeout ?? 30
    const writeTimeoutValue = existingProfile?.writeTimeout ?? 30
    const initialQueryValue = existingProfile?.initialQuery || ''
    const noteValue = existingProfile?.note || ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      overflow: hidden;
      background: var(--vscode-editor-background, #fff);
      color: var(--vscode-foreground, #1f2328);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
    }
    button, input, select, textarea { font: inherit; }
    .shell { height: 100vh; display: flex; flex-direction: column; }
    .titlebar {
      height: 38px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 14px;
      background: var(--vscode-titleBar-activeBackground, #f3f3f3);
      border-bottom: 1px solid var(--vscode-panel-border, #d4d4d4);
    }
    .title { font-weight: 600; }
    .status { color: var(--vscode-descriptionForeground, #6b7280); }
    .step { flex: 1; min-height: 0; display: none; }
    .step.active { display: flex; }
    .filter {
      width: 282px;
      padding: 18px 14px;
      overflow: auto;
      background: var(--vscode-sideBar-background, #fafafa);
      border-right: 1px solid var(--vscode-panel-border, #d4d4d4);
    }
    .filter-title { font-size: 16px; margin: 0 0 10px; }
    .filter-group { margin-bottom: 24px; }
    .check { display: flex; align-items: center; gap: 7px; min-height: 28px; }
    .check input { width: 15px; height: 15px; }
    .disabled { opacity: 0.55; }
    .select-main { flex: 1; min-width: 0; padding: 20px; display: flex; flex-direction: column; }
    .select-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    .select-title { font-size: 16px; font-weight: 500; }
    .tools { display: flex; align-items: center; gap: 8px; }
    .icon-btn {
      width: 30px;
      height: 28px;
      border: 1px solid var(--vscode-button-border, #aaa);
      background: var(--vscode-button-secondaryBackground, #e9e9e9);
      color: var(--vscode-button-secondaryForeground, #222);
      cursor: pointer;
    }
    .icon-btn.active { border-color: var(--vscode-focusBorder, #007fd4); background: var(--vscode-list-activeSelectionBackground, #cce8ff); }
    .search {
      width: 250px;
      height: 28px;
      padding: 3px 8px;
      border: 1px solid var(--vscode-input-border, #9a9a9a);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #111827);
    }
    .scroll { flex: 1; min-height: 0; overflow: auto; padding-right: 10px; }
    .section-title { font-size: 15px; margin: 0 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 18px 34px; margin-bottom: 24px; }
    .grid.recent { grid-template-columns: repeat(auto-fill, minmax(116px, 146px)); }
    .grid.list { display: flex; flex-direction: column; gap: 4px; }
    .driver-tile {
      min-height: 114px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--vscode-foreground, #111827);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 9px;
      padding: 10px 6px;
    }
    .grid.list .driver-tile { min-height: 38px; width: 100%; flex-direction: row; justify-content: flex-start; padding: 4px 8px; gap: 10px; }
    .driver-tile:hover { background: var(--vscode-list-hoverBackground, rgba(90, 160, 220, 0.14)); }
    .driver-tile.selected {
      background: var(--vscode-list-activeSelectionBackground, #b9dcff);
      color: var(--vscode-list-activeSelectionForeground, #111827);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .driver-tile.disabled { opacity: 0.48; }
    .logo {
      width: 64px;
      height: 64px;
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 700;
      font-size: 18px;
      letter-spacing: 0;
    }
    .grid.list .logo { width: 24px; height: 24px; font-size: 10px; }
    .name { min-height: 34px; line-height: 1.25; text-align: center; overflow-wrap: anywhere; }
    .grid.list .name { min-height: 0; text-align: left; }
    .badge { font-size: 11px; color: var(--vscode-descriptionForeground, #6b7280); }
    .empty { padding: 24px; color: var(--vscode-descriptionForeground, #6b7280); }
    .config { flex-direction: column; }
    .tabs {
      display: flex;
      height: 34px;
      align-items: flex-end;
      padding-left: 12px;
      background: var(--vscode-editorWidget-background, #f3f3f3);
      border-bottom: 1px solid var(--vscode-panel-border, #d4d4d4);
    }
    .tab {
      height: 28px;
      padding: 0 12px;
      border: 1px solid transparent;
      border-bottom: none;
      background: transparent;
      color: var(--vscode-foreground, #111827);
      cursor: pointer;
    }
    .tab.active { background: var(--vscode-editor-background, #fff); border-color: var(--vscode-panel-border, #d4d4d4); }
    .body { flex: 1; min-height: 0; overflow: auto; padding: 30px 32px 22px; }
    .hero { display: flex; justify-content: center; align-items: center; gap: 24px; margin-bottom: 28px; }
    .hero-node { min-width: 128px; text-align: center; }
    .hero-line { width: 144px; height: 2px; background: var(--vscode-panel-border, #c7c7c7); }
    .hero .logo { margin-bottom: 6px; }
    .db-icon {
      width: 64px;
      height: 64px;
      border: 2px solid #969696;
      border-radius: 50% 50% 12% 12%;
      position: relative;
      margin: 0 auto 6px;
    }
    .db-icon::before,
    .db-icon::after {
      content: '';
      position: absolute;
      left: -2px;
      right: -2px;
      height: 18px;
      border: 2px solid #969696;
      border-radius: 50%;
      background: var(--vscode-editor-background, #fff);
    }
    .db-icon::before { top: -2px; }
    .db-icon::after { bottom: 12px; }
    .panel { display: none; max-width: 860px; margin: 0 auto; }
    .panel.active { display: block; }
    .form-grid { display: grid; grid-template-columns: 190px minmax(260px, 560px) auto; gap: 9px 10px; align-items: center; }
    .field-group { display: contents; }
    .hidden { display: none !important; }
    label.caption { text-align: right; }
    label.required::after { content: ' *'; color: var(--vscode-errorForeground, #c42b1c); }
    .input, .select, .textarea {
      width: 100%;
      min-height: 28px;
      padding: 4px 7px;
      border: 1px solid var(--vscode-input-border, #9a9a9a);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #111827);
    }
    .input:focus, .select:focus, .textarea:focus, .search:focus {
      outline: 1px solid var(--vscode-focusBorder, #007fd4);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .short { max-width: 96px; }
    .path-row { display: grid; grid-template-columns: 1fr 30px; gap: 6px; }
    .row-check { grid-column: 2 / span 2; display: flex; align-items: center; gap: 7px; min-height: 28px; }
    .row-check input { width: 15px; height: 15px; }
    .note { grid-column: 2 / span 2; color: var(--vscode-descriptionForeground, #6b7280); font-size: 12px; padding-bottom: 8px; }
    .textarea { min-height: 180px; resize: vertical; }
    .form-status { min-height: 22px; margin: 12px auto 0; max-width: 860px; color: var(--vscode-descriptionForeground, #6b7280); }
    .form-status.success { color: var(--vscode-testing-iconPassed, #4caf50); }
    .form-status.error { color: var(--vscode-errorForeground, #f48771); }
    .form-status.testing { color: var(--vscode-testing-iconQueued, #fbbf24); }
    .footer {
      height: 52px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 9px 14px;
      border-top: 1px solid var(--vscode-panel-border, #d4d4d4);
      background: var(--vscode-editorWidget-background, #f3f3f3);
    }
    .footer-group { display: flex; gap: 12px; align-items: center; }
    .btn {
      min-width: 92px;
      height: 30px;
      padding: 4px 14px;
      border: 1px solid var(--vscode-button-border, #9a9a9a);
      background: var(--vscode-button-secondaryBackground, #e5e5e5);
      color: var(--vscode-button-secondaryForeground, #111827);
      cursor: pointer;
    }
    .btn.primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); border-color: var(--vscode-button-background, #0e639c); }
    .btn:disabled, .icon-btn:disabled { cursor: default; opacity: 0.5; }
    @media (max-width: 760px) {
      body { overflow: auto; }
      .shell { height: auto; min-height: 100vh; }
      .step.active { flex-direction: column; }
      .filter { width: 100%; max-height: 180px; border-right: none; border-bottom: 1px solid var(--vscode-panel-border, #d4d4d4); }
      .select-head { align-items: flex-start; flex-direction: column; }
      .search { width: 100%; }
      .form-grid { grid-template-columns: 1fr; }
      label.caption { text-align: left; }
      .row-check, .note { grid-column: 1; }
      .hero { justify-content: flex-start; }
      .hero-line { width: 54px; }
      .footer { height: auto; flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="titlebar">
      <div class="title">${isEdit ? 'Edit' : 'New'} ${title}</div>
      <div class="status" id="wizardStatus"></div>
    </header>

    <section id="selectStep" class="step">
      <aside class="filter">
        <div class="filter-group">
          <div class="filter-title">连接筛选</div>
          <label class="check"><input type="checkbox" data-family="sql" checked> SQL</label>
          <label class="check"><input type="checkbox" data-family="warehouse" checked> 数据仓库</label>
          <label class="check"><input type="checkbox" data-family="document" checked> 文档数据库</label>
          <label class="check"><input type="checkbox" data-family="keyValue" checked> 键值数据库</label>
          <label class="check"><input type="checkbox" data-family="graph" checked> 图数据库</label>
          <label class="check"><input type="checkbox" data-family="search" checked> 搜索引擎</label>
          <label class="check"><input type="checkbox" data-family="file" checked> 文件</label>
          <label class="check"><input type="checkbox" id="showPlanned"> 计划中驱动</label>
        </div>
        <div class="filter-group">
          <div class="filter-title">供应商筛选</div>
          <label class="check disabled"><input type="checkbox" disabled> 阿里云</label>
          <label class="check disabled"><input type="checkbox" disabled> 华为</label>
          <label class="check disabled"><input type="checkbox" disabled> 腾讯云</label>
          <label class="check disabled"><input type="checkbox" disabled> AWS</label>
          <label class="check disabled"><input type="checkbox" disabled> Google Cloud</label>
          <label class="check disabled"><input type="checkbox" disabled> Microsoft</label>
          <label class="check disabled"><input type="checkbox" disabled> Oracle</label>
        </div>
      </aside>

      <main class="select-main">
        <div class="select-head">
          <div class="select-title">选择一个连接类型:</div>
          <div class="tools">
            <button type="button" class="icon-btn active" id="gridMode" title="网格视图">▦</button>
            <button type="button" class="icon-btn" id="listMode" title="列表视图">☰</button>
            <input id="driverSearch" class="search" type="search" placeholder="搜索">
          </div>
        </div>
        <div class="scroll">
          <div class="section-title">最近使用过的</div>
          <div id="recentDrivers" class="grid recent"></div>
          <div class="section-title">全部</div>
          <div id="allDrivers" class="grid"></div>
        </div>
      </main>
    </section>

    <form id="connectionForm" class="step config">
      <input type="hidden" id="id" value="${existingProfile?.id || ''}">
      <input type="hidden" id="createdAt" value="${existingProfile?.createdAt || ''}">
      <input type="hidden" id="driverId" value="${selectedDriver}">

      <nav class="tabs">
        <button type="button" class="tab active" data-tab="general">常规</button>
        <button type="button" class="tab" data-tab="advanced">高级</button>
        <button type="button" class="tab" data-tab="database" id="databaseTab">数据库</button>
        <button type="button" class="tab" data-tab="ssl" id="sslTab">SSL</button>
        <button type="button" class="tab" data-tab="ssh">SSH</button>
        <button type="button" class="tab" data-tab="http">HTTP</button>
        <button type="button" class="tab" data-tab="note">备注</button>
      </nav>

      <div class="body">
        <div class="hero">
          <div class="hero-node">
            <div id="heroLogo"></div>
            <div id="heroName">${this._escapeHtml(selectedDriverName)}</div>
          </div>
          <div class="hero-line"></div>
          <div class="hero-node">
            <div class="db-icon"></div>
            <div>数据库</div>
          </div>
        </div>

        <section class="panel active" data-panel="general">
          <div class="form-grid">
            <label class="caption required" for="name">${t('form.connectionName')}</label>
            <input class="input" type="text" id="name" value="${this._escapeHtml(nameValue)}" autocomplete="off">
            <span></span>

            <div id="serverFields" class="field-group">
              <label class="caption required" for="host">${t('form.host')}</label>
              <input class="input" type="text" id="host" value="${this._escapeHtml(hostValue)}" autocomplete="off">
              <span></span>

              <label class="caption" for="port">${t('form.port')}</label>
              <input class="input short" type="number" id="port" value="${this._escapeHtml(String(portValue))}">
              <span></span>

              <label class="caption" for="username">${t('form.username')}</label>
              <input class="input" type="text" id="username" value="${this._escapeHtml(usernameValue)}" autocomplete="off">
              <span></span>

              <label class="caption" for="password">${t('form.password')}</label>
              <input class="input" type="password" id="password" placeholder="${isEdit ? '留空则保留原密码' : ''}" autocomplete="new-password">
              <span></span>

              <label class="caption"></label>
              <label class="row-check"><input type="checkbox" id="savePassword" checked> 保存密码</label>
            </div>

            <div id="fileFields" class="field-group hidden">
              <label class="caption required" for="filePath">${t('form.filePath')}</label>
              <div class="path-row">
                <input class="input" type="text" id="filePath" value="${this._escapeHtml(filePathValue)}" placeholder="C:\\path\\to\\database.db">
                <button type="button" class="icon-btn" id="browseFileButton" title="选择文件">…</button>
              </div>
              <span></span>
            </div>
          </div>
        </section>

        <section class="panel" data-panel="advanced">
          <div class="form-grid">
            <label class="caption" for="clientDriver">客户端驱动程序</label>
            <select class="select" id="clientDriver">
              <option value="default" ${clientDriverValue === 'default' ? 'selected' : ''}>默认</option>
              <option value="native" ${clientDriverValue === 'native' ? 'selected' : ''}>Native</option>
              <option value="http" ${clientDriverValue === 'http' ? 'selected' : ''}>HTTP</option>
            </select>
            <span></span>

            <label class="caption" for="charset">客户端字符集</label>
            <select class="select" id="charset">
              <option value="auto" ${charsetValue === 'auto' ? 'selected' : ''}>自动</option>
              <option value="utf8" ${charsetValue === 'utf8' ? 'selected' : ''}>utf8</option>
              <option value="utf8mb4" ${charsetValue === 'utf8mb4' ? 'selected' : ''}>utf8mb4</option>
            </select>
            <span></span>

            <label class="caption" for="keepAliveInterval">保持连接间隔（秒）</label>
            <input class="input short" type="number" id="keepAliveInterval" value="${keepAliveValue}">
            <span></span>

            <label class="caption" for="connectTimeout">连接超时（秒）</label>
            <input class="input short" type="number" id="connectTimeout" value="${connectTimeoutValue}">
            <span></span>

            <label class="caption" for="readTimeout">读取超时（秒）</label>
            <input class="input short" type="number" id="readTimeout" value="${readTimeoutValue}">
            <span></span>

            <label class="caption" for="writeTimeout">写入超时（秒）</label>
            <input class="input short" type="number" id="writeTimeout" value="${writeTimeoutValue}">
            <span></span>

            <label class="caption"></label>
            <label class="row-check"><input type="checkbox" id="useCompression" ${existingProfile?.useCompression ? 'checked' : ''}> 使用压缩</label>

            <label class="caption"></label>
            <label class="row-check"><input type="checkbox" id="autoConnect" ${existingProfile?.autoConnect ? 'checked' : ''}> 自动连接</label>

            <label class="caption" for="initialQuery">初始查询</label>
            <input class="input" type="text" id="initialQuery" value="${this._escapeHtml(initialQueryValue)}">
            <span></span>
          </div>
        </section>

        <section class="panel" data-panel="database">
          <div class="form-grid">
            <label class="caption" for="database">${t('form.database')}</label>
            <input class="input" type="text" id="database" value="${this._escapeHtml(databaseValue)}" placeholder="可留空以先连接实例">
            <span></span>
            <div class="note">MySQL/MariaDB/ClickHouse 留空会先连接实例并列出所有数据库；PostgreSQL 默认连接 postgres；CockroachDB 默认连接 defaultdb。</div>
          </div>
        </section>

        <section class="panel" data-panel="ssl">
          <div class="form-grid">
            <label class="caption"></label>
            <label class="row-check"><input type="checkbox" id="ssl" ${existingProfile?.ssl ? 'checked' : ''}> ${t('form.sslEnabled')}</label>
            <div class="note">当前先使用驱动默认 SSL 参数；证书、密钥和 CA 文件可以后续扩展为独立字段。</div>
          </div>
        </section>

        <section class="panel" data-panel="ssh">
          <div class="form-grid">
            <label class="caption"></label>
            <div class="note">SSH 隧道配置位已经预留，当前驱动尚未接入隧道转发。</div>
          </div>
        </section>

        <section class="panel" data-panel="http">
          <div class="form-grid">
            <label class="caption"></label>
            <div class="note">HTTP 代理配置位已经预留，ClickHouse 会继续使用驱动自身的 HTTP/HTTPS 连接方式。</div>
          </div>
        </section>

        <section class="panel" data-panel="note">
          <div class="form-grid">
            <label class="caption" for="note">备注</label>
            <textarea class="textarea" id="note">${this._escapeHtml(noteValue)}</textarea>
            <span></span>
          </div>
        </section>

        <div id="formStatus" class="form-status"></div>
      </div>
    </form>

    <footer class="footer">
      <div class="footer-group">
        <button type="button" class="btn" id="testButton">测试连接</button>
        <button type="button" class="btn" id="uriButton">URI...</button>
      </div>
      <div class="footer-group">
        <button type="button" class="btn" id="backButton">上一步</button>
        <button type="button" class="btn primary" id="nextButton">下一步</button>
        <button type="submit" form="connectionForm" class="btn primary" id="saveButton">${isEdit ? '保存' : '确定'}</button>
        <button type="button" class="btn" id="cancelButton">取消</button>
      </div>
    </footer>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const isEdit = ${JSON.stringify(isEdit)};
    const drivers = ${JSON.stringify(drivers)};
    const recentDriverIds = ${JSON.stringify(recentDriverIds)};
    const fileDrivers = ['sqlite', 'duckdb', 'csv', 'excel', 'json', 'parquet', 'avro'];
    const colorMap = {
      mysql: '#31c94c',
      mariadb: '#c89a63',
      postgresql: '#3f7df4',
      cockroachdb: '#5c7cfa',
      sqlite: '#55d0c6',
      duckdb: '#f2c94c',
      clickhouse: '#f7c948',
      sqlserver: '#f59f00',
      oracle: '#f20535',
      mongodb: '#b45309',
      redis: '#ff7276',
      snowflake: '#26a8d9'
    };
    let selectedDriverId = ${JSON.stringify(selectedDriver)};
    let listMode = false;
    let nameWasEdited = isEdit;
    let activeTestRequestId = 0;

    function getDriver(id) {
      return drivers.find(function(driver) { return driver.id === id; }) || drivers[0];
    }

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function shortName(displayName) {
      return displayName.split(/\\s+/).map(function(part) { return part.charAt(0); }).join('').slice(0, 3) || 'DB';
    }

    function renderLogo(driver) {
      const bg = colorMap[driver.id] || '#64748b';
      return '<span class="logo" style="background:' + bg + '">' + escapeHtml(shortName(driver.displayName)) + '</span>';
    }

    function renderDriverTile(driver) {
      const classes = ['driver-tile'];
      if (driver.id === selectedDriverId) classes.push('selected');
      if (!driver.implemented) classes.push('disabled');
      const badge = driver.implemented ? '' : '<span class="badge">计划中</span>';
      return '<button type="button" class="' + classes.join(' ') + '" data-driver="' + driver.id + '">' +
        renderLogo(driver) +
        '<span class="name">' + escapeHtml(driver.displayName) + '</span>' +
        badge +
        '</button>';
    }

    function activeFamilies() {
      return Array.from(document.querySelectorAll('[data-family]:checked')).map(function(input) {
        return input.getAttribute('data-family');
      });
    }

    function filteredDrivers() {
      const search = document.getElementById('driverSearch').value.trim().toLowerCase();
      const families = activeFamilies();
      const showPlanned = document.getElementById('showPlanned').checked;
      return drivers.filter(function(driver) {
        if (!showPlanned && !driver.implemented) return false;
        if (families.length && families.indexOf(driver.family) === -1) return false;
        if (search && driver.displayName.toLowerCase().indexOf(search) === -1 && driver.id.indexOf(search) === -1) return false;
        return true;
      });
    }

    function bindDriverTiles() {
      document.querySelectorAll('.driver-tile').forEach(function(button) {
        button.addEventListener('click', function() {
          selectDriver(button.getAttribute('data-driver'));
        });
        button.addEventListener('dblclick', function() {
          selectDriver(button.getAttribute('data-driver'));
          goConfig();
        });
      });
    }

    function renderDrivers() {
      const recent = recentDriverIds.map(getDriver).filter(function(driver, index, list) {
        return driver && list.findIndex(function(item) { return item.id === driver.id; }) === index;
      });
      const all = filteredDrivers();
      const recentNode = document.getElementById('recentDrivers');
      const allNode = document.getElementById('allDrivers');
      recentNode.className = 'grid recent' + (listMode ? ' list' : '');
      allNode.className = 'grid' + (listMode ? ' list' : '');
      recentNode.innerHTML = recent.length ? recent.map(renderDriverTile).join('') : '<div class="empty">暂无最近使用的连接类型</div>';
      allNode.innerHTML = all.length ? all.map(renderDriverTile).join('') : '<div class="empty">没有匹配的连接类型</div>';
      bindDriverTiles();
      updateDriverState();
    }

    function setWizardStatus(text) {
      document.getElementById('wizardStatus').textContent = text || '';
    }

    function setFormStatus(text, kind) {
      const status = document.getElementById('formStatus');
      status.textContent = text || '';
      status.className = 'form-status' + (kind ? ' ' + kind : '');
    }

    function selectDriver(driverId) {
      const driver = getDriver(driverId);
      const previousDriver = getDriver(selectedDriverId);
      selectedDriverId = driver.id;
      document.getElementById('driverId').value = driver.id;

      const nameInput = document.getElementById('name');
      if (!isEdit && (!nameWasEdited || nameInput.value === previousDriver.displayName)) {
        nameInput.value = driver.displayName;
        nameWasEdited = false;
      }

      const portInput = document.getElementById('port');
      if (driver.defaultPort && (!portInput.value || portInput.value === String(previousDriver.defaultPort || ''))) {
        portInput.value = String(driver.defaultPort);
      }

      setWizardStatus(driver.implemented ? '' : driver.displayName + ' 驱动尚未实现');
      updateDriverFields();
      renderDrivers();
    }

    function updateDriverState() {
      const driver = getDriver(selectedDriverId);
      document.getElementById('nextButton').disabled = isEdit || !driver.implemented;
      document.getElementById('heroLogo').innerHTML = renderLogo(driver);
      document.getElementById('heroName').textContent = driver.displayName;
    }

    function updateDriverFields() {
      const isFile = fileDrivers.indexOf(selectedDriverId) !== -1;
      document.getElementById('serverFields').classList.toggle('hidden', isFile);
      document.getElementById('fileFields').classList.toggle('hidden', !isFile);
      document.getElementById('databaseTab').classList.toggle('hidden', isFile);
      document.getElementById('sslTab').classList.toggle('hidden', isFile);
      if (isFile && document.querySelector('.tab.active').getAttribute('data-tab') === 'database') {
        activateTab('general');
      }
    }

    function activateTab(tab) {
      document.querySelectorAll('.tab').forEach(function(button) {
        button.classList.toggle('active', button.getAttribute('data-tab') === tab);
      });
      document.querySelectorAll('.panel').forEach(function(panel) {
        panel.classList.toggle('active', panel.getAttribute('data-panel') === tab);
      });
    }

    function showStep(step) {
      const selectActive = step === 'select';
      document.getElementById('selectStep').classList.toggle('active', selectActive);
      document.getElementById('connectionForm').classList.toggle('active', !selectActive);
      document.getElementById('backButton').classList.toggle('hidden', isEdit || selectActive);
      document.getElementById('nextButton').classList.toggle('hidden', isEdit || !selectActive);
      document.getElementById('saveButton').classList.toggle('hidden', selectActive);
      document.getElementById('testButton').classList.toggle('hidden', selectActive);
      document.getElementById('uriButton').classList.toggle('hidden', false);
      if (!selectActive) {
        updateDriverFields();
        updateDriverState();
      }
    }

    function goConfig() {
      const driver = getDriver(selectedDriverId);
      if (!driver.implemented) {
        setWizardStatus(driver.displayName + ' 驱动尚未实现');
        return;
      }
      setWizardStatus('');
      showStep('config');
    }

    function optionalText(id) {
      const value = document.getElementById(id).value.trim();
      return value || undefined;
    }

    function readOptionalNumber(id) {
      const value = optionalText(id);
      if (!value) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    function collectProfile() {
      const isFile = fileDrivers.indexOf(selectedDriverId) !== -1;
      return {
        id: optionalText('id'),
        name: document.getElementById('name').value.trim(),
        driverId: selectedDriverId,
        host: isFile ? undefined : optionalText('host'),
        port: isFile ? undefined : readOptionalNumber('port'),
        database: isFile ? undefined : optionalText('database'),
        username: isFile ? undefined : optionalText('username'),
        filePath: isFile ? optionalText('filePath') : undefined,
        ssl: isFile ? false : document.getElementById('ssl').checked,
        clientDriver: optionalText('clientDriver'),
        charset: optionalText('charset'),
        keepAliveInterval: readOptionalNumber('keepAliveInterval'),
        connectTimeout: readOptionalNumber('connectTimeout'),
        readTimeout: readOptionalNumber('readTimeout'),
        writeTimeout: readOptionalNumber('writeTimeout'),
        useCompression: document.getElementById('useCompression').checked,
        autoConnect: document.getElementById('autoConnect').checked,
        initialQuery: optionalText('initialQuery'),
        note: optionalText('note'),
        createdAt: optionalText('createdAt')
      };
    }

    function validateProfile(profile) {
      if (!profile.name) return '连接名称不能为空';
      if (fileDrivers.indexOf(profile.driverId) !== -1 && !profile.filePath) return '文件路径不能为空';
      if (fileDrivers.indexOf(profile.driverId) === -1 && !profile.host) return '主机不能为空';
      return '';
    }

    document.getElementById('name').addEventListener('input', function() {
      nameWasEdited = true;
    });
    document.getElementById('gridMode').addEventListener('click', function() {
      listMode = false;
      document.getElementById('gridMode').classList.add('active');
      document.getElementById('listMode').classList.remove('active');
      renderDrivers();
    });
    document.getElementById('listMode').addEventListener('click', function() {
      listMode = true;
      document.getElementById('listMode').classList.add('active');
      document.getElementById('gridMode').classList.remove('active');
      renderDrivers();
    });
    document.getElementById('driverSearch').addEventListener('input', renderDrivers);
    document.getElementById('showPlanned').addEventListener('change', renderDrivers);
    document.querySelectorAll('[data-family]').forEach(function(input) {
      input.addEventListener('change', renderDrivers);
    });
    document.querySelectorAll('.tab').forEach(function(button) {
      button.addEventListener('click', function() {
        activateTab(button.getAttribute('data-tab'));
      });
    });
    document.getElementById('backButton').addEventListener('click', function() {
      showStep('select');
    });
    document.getElementById('nextButton').addEventListener('click', goConfig);
    document.getElementById('cancelButton').addEventListener('click', function() {
      vscode.postMessage({ type: 'cancelForm' });
    });
    document.getElementById('testButton').addEventListener('click', function() {
      const profile = collectProfile();
      const message = validateProfile(profile);
      if (message) {
        setFormStatus(message, 'error');
        return;
      }
      activeTestRequestId += 1;
      const requestId = activeTestRequestId;
      document.getElementById('testButton').disabled = true;
      setFormStatus('正在测试连接...', 'testing');
      vscode.postMessage({ type: 'testDraftConnection', profile: profile, password: optionalText('password'), requestId: requestId });
    });
    document.getElementById('uriButton').addEventListener('click', function() {
      vscode.postMessage({ type: 'addConnectionFromUrl' });
    });
    document.getElementById('connectionForm').addEventListener('submit', function(event) {
      event.preventDefault();
      const profile = collectProfile();
      const message = validateProfile(profile);
      if (message) {
        setFormStatus(message, 'error');
        return;
      }
      vscode.postMessage({
        type: 'saveConnection',
        profile: profile,
        password: optionalText('password'),
        savePassword: document.getElementById('savePassword').checked
      });
    });
    document.getElementById('browseFileButton').addEventListener('click', function() {
      vscode.postMessage({ type: 'browseFile', driverId: selectedDriverId });
    });
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'fileSelected') {
        document.getElementById('filePath').value = event.data.filePath || '';
        setFormStatus('');
      }
      if (event.data && event.data.type === 'draftConnectionTestResult') {
        if (event.data.requestId !== undefined && event.data.requestId !== activeTestRequestId) return;
        document.getElementById('testButton').disabled = false;
        setFormStatus(event.data.message || '', event.data.ok ? 'success' : 'error');
      }
    });

    renderDrivers();
    selectDriver(selectedDriverId);
    showStep(isEdit ? 'config' : 'select');
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
