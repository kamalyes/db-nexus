import { ExtensionContext, ViewColumn, WebviewPanel, window, commands } from 'vscode'
import { ConnectionStore } from '@/core/connectionStore'
import { DriverRegistry } from '@/drivers/registry'
import { connectionStatusManager, ConnectionStatus } from '@/services/connectionStatusManager'
import { QueryHistoryService, QueryHistoryItem } from '@/services/queryHistoryService'
import { t } from '@/i18n'
import { DbConnectionProfile } from '@/core/types'

interface MonitorState {
  connections: Array<{
    id: string
    name: string
    driverId: string
    host?: string
    port?: number
    database?: string
    status: string
    latency?: number
    error?: string
  }>
  recentQueries: Array<{
    id: string
    sql: string
    connectionName?: string
    timestamp: number
    success: boolean
    durationMs?: number
    rowCount?: number
    error?: string
  }>
  stats: {
    totalConnections: number
    activeConnections: number
    totalQueries: number
    failedQueries: number
    avgLatency: number
  }
}

export class ConnectionMonitorPanel {
  private static currentPanel: ConnectionMonitorPanel | undefined
  private readonly _panel: WebviewPanel
  private _disposables: any[] = []
  private _refreshTimer: ReturnType<typeof setInterval> | undefined

  static show(
    context: ExtensionContext,
    connectionStore: ConnectionStore,
    driverRegistry: DriverRegistry
  ): void {
    if (ConnectionMonitorPanel.currentPanel) {
      ConnectionMonitorPanel.currentPanel._panel.reveal()
      ConnectionMonitorPanel.currentPanel._refresh()
      return
    }

    const panel = window.createWebviewPanel(
      'dbNexus.connectionMonitor',
      t('monitor.title', 'Connection Monitor'),
      ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    ConnectionMonitorPanel.currentPanel = new ConnectionMonitorPanel(
      panel,
      context,
      connectionStore,
      driverRegistry
    )
  }

  private constructor(
    panel: WebviewPanel,
    private readonly _context: ExtensionContext,
    private readonly _connectionStore: ConnectionStore,
    private readonly _driverRegistry: DriverRegistry
  ) {
    this._panel = panel
    this._panel.webview.html = this._getHtml()

    this._panel.webview.onDidReceiveMessage(
      message => this._handleMessage(message),
      null,
      this._disposables
    )

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    // Auto-refresh every 5 seconds
    this._refreshTimer = setInterval(() => this._refresh(), 5000)

    // Listen for status changes
    connectionStatusManager.onDidChangeStatus(() => this._refresh(), null, this._disposables)

    this._refresh()
  }

  dispose(): void {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer)
      this._refreshTimer = undefined
    }
    ConnectionMonitorPanel.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      this._disposables.pop()?.dispose()
    }
  }

  private _handleMessage(message: { type: string; id?: string }): void {
    if (message.type === 'refresh') {
      this._refresh()
    }
    if (message.type === 'ping' && message.id) {
      this._pingConnection(message.id)
    }
    if (message.type === 'connect' && message.id) {
      commands.executeCommand('dbNexus.connectConnection', message.id)
    }
    if (message.type === 'disconnect' && message.id) {
      commands.executeCommand('dbNexus.disconnectConnection', message.id)
    }
  }

  private async _pingConnection(profileId: string): Promise<void> {
    const profile = this._connectionStore.getById(profileId)
    if (!profile) return

    try {
      const driver = this._driverRegistry.getDriver(profile.driverId)
      const start = Date.now()
      const result = await driver.testConnection(profile)
      const latency = Date.now() - start

      this._panel.webview.postMessage({
        type: 'pingResult',
        profileId,
        ok: result.ok,
        latency,
        message: result.message
      })
    } catch (error: unknown) {
      this._panel.webview.postMessage({
        type: 'pingResult',
        profileId,
        ok: false,
        latency: -1,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private _refresh(): void {
    const connections = this._connectionStore.getAll()
    const statuses = connectionStatusManager.getAllStatuses()
    const statusMap = new Map(statuses.map(s => [s.profileId, s]))

    let totalQueries = 0
    let failedQueries = 0
    let latencySum = 0
    let latencyCount = 0

    try {
      const history = QueryHistoryService.getInstance().getRecent(50)
      totalQueries = history.length
      failedQueries = history.filter(q => !q.success).length
      for (const q of history) {
        if (q.durationMs !== undefined) {
          latencySum += q.durationMs
          latencyCount++
        }
      }
    } catch {
      // QueryHistoryService may not be initialized yet
    }

    const state: MonitorState = {
      connections: connections.map(profile => {
        const status = statusMap.get(profile.id)
        if (status?.latency !== undefined) {
          latencySum += status.latency
          latencyCount++
        }
        return {
          id: profile.id,
          name: profile.name,
          driverId: profile.driverId,
          host: profile.host,
          port: profile.port,
          database: profile.database,
          status: status?.status || 'disconnected',
          latency: status?.latency,
          error: status?.error
        }
      }),
      recentQueries: this._getRecentQueries(),
      stats: {
        totalConnections: connections.length,
        activeConnections: statuses.filter(s => s.status === 'connected').length,
        totalQueries,
        failedQueries,
        avgLatency: latencyCount > 0 ? Math.round(latencySum / latencyCount) : 0
      }
    }

    this._panel.webview.postMessage({ type: 'state', state })
  }

  private _getRecentQueries(): MonitorState['recentQueries'] {
    try {
      return QueryHistoryService.getInstance().getRecent(20).map(q => ({
        id: q.id,
        sql: q.sql.length > 120 ? q.sql.slice(0, 120) + '...' : q.sql,
        connectionName: q.connectionName,
        timestamp: q.timestamp,
        success: q.success,
        durationMs: q.durationMs,
        rowCount: q.rowCount,
        error: q.error ? (q.error.length > 80 ? q.error.slice(0, 80) + '...' : q.error) : undefined
      }))
    } catch {
      return []
    }
  }

  private _getHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root {
      --border: var(--vscode-panel-border, rgba(127,127,127,0.45));
      --toolbar: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
      --muted: var(--vscode-descriptionForeground);
      --success: #4caf50;
      --warning: #ff9800;
      --error: #f44336;
      --info: #2196f3;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: 13px;
      padding: 16px;
    }
    h2 {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h2 .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      color: #fff;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .stat-card {
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }
    .stat-card .label {
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .stat-card .value {
      font-size: 24px;
      font-weight: 700;
    }
    .stat-card .value.success { color: var(--success); }
    .stat-card .value.warning { color: var(--warning); }
    .stat-card .value.error { color: var(--error); }
    .stat-card .value.info { color: var(--info); }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    button {
      height: 28px;
      padding: 0 12px;
      border: 1px solid var(--vscode-dropdown-border, var(--border));
      border-radius: 3px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      font: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    button:hover { background: var(--vscode-toolbar-hoverBackground); }

    .conn-table, .query-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }
    th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      background: var(--toolbar);
      position: sticky;
      top: 0;
    }
    .status-dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
    }
    .status-dot.connected { background: var(--success); }
    .status-dot.disconnected { background: var(--muted); }
    .status-dot.error { background: var(--error); }
    .status-dot.connecting { background: var(--warning); animation: pulse 1s infinite; }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .latency-bar {
      display: inline-block;
      height: 6px;
      border-radius: 3px;
      min-width: 4px;
      margin-right: 6px;
      vertical-align: middle;
    }
    .latency-bar.fast { background: var(--success); }
    .latency-bar.medium { background: var(--warning); }
    .latency-bar.slow { background: var(--error); }
    .query-sql {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    .query-success { color: var(--success); }
    .query-fail { color: var(--error); }
    .actions { display: flex; gap: 4px; }
    .actions button { height: 24px; font-size: 11px; padding: 0 8px; }
    .empty { color: var(--muted); padding: 20px; text-align: center; }
    .section { margin-bottom: 28px; }
  </style>
  <title>Connection Monitor</title>
</head>
<body>
  <div class="toolbar">
    <button id="refreshBtn">&#x21BB; Refresh</button>
    <span style="color:var(--muted);font-size:11px;margin-left:auto;">Auto-refresh: 5s</span>
  </div>

  <div class="section">
    <h2>Overview</h2>
    <div class="stats-grid" id="statsGrid">
      <div class="stat-card"><div class="label">Total Connections</div><div class="value info" id="statTotal">-</div></div>
      <div class="stat-card"><div class="label">Active</div><div class="value success" id="statActive">-</div></div>
      <div class="stat-card"><div class="label">Recent Queries</div><div class="value info" id="statQueries">-</div></div>
      <div class="stat-card"><div class="label">Failed Queries</div><div class="value error" id="statFailed">-</div></div>
      <div class="stat-card"><div class="label">Avg Latency</div><div class="value warning" id="statLatency">-</div></div>
    </div>
  </div>

  <div class="section">
    <h2>Connections</h2>
    <table class="conn-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Name</th>
          <th>Driver</th>
          <th>Host</th>
          <th>Database</th>
          <th>Latency</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody id="connBody"></tbody>
    </table>
  </div>

  <div class="section">
    <h2>Recent Queries</h2>
    <table class="query-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Connection</th>
          <th>SQL</th>
          <th>Duration</th>
          <th>Rows</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody id="queryBody"></tbody>
    </table>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    function formatTime(ts) {
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function formatDuration(ms) {
      if (ms === undefined || ms === null) return '-';
      if (ms < 1000) return ms + 'ms';
      return (ms / 1000).toFixed(2) + 's';
    }

    function latencyClass(ms) {
      if (ms === undefined || ms === null) return '';
      if (ms < 50) return 'fast';
      if (ms < 200) return 'medium';
      return 'slow';
    }

    function latencyBar(ms) {
      if (ms === undefined || ms === null) return '';
      const cls = latencyClass(ms);
      const width = Math.min(Math.max(ms / 5, 4), 80);
      return '<span class="latency-bar ' + cls + '" style="width:' + width + 'px"></span>' + ms + 'ms';
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') {
        renderState(message.state);
      }
      if (message.type === 'pingResult') {
        // Will be reflected in next refresh
      }
    });

    function renderState(state) {
      // Stats
      document.getElementById('statTotal').textContent = state.stats.totalConnections;
      document.getElementById('statActive').textContent = state.stats.activeConnections;
      document.getElementById('statQueries').textContent = state.stats.totalQueries;
      document.getElementById('statFailed').textContent = state.stats.failedQueries;
      document.getElementById('statLatency').textContent = state.stats.avgLatency > 0 ? state.stats.avgLatency + 'ms' : '-';

      // Connections table
      const connBody = document.getElementById('connBody');
      if (state.connections.length === 0) {
        connBody.innerHTML = '<tr><td colspan="7" class="empty">No connections configured</td></tr>';
      } else {
        connBody.innerHTML = state.connections.map(c => {
          const statusLabel = c.status.charAt(0).toUpperCase() + c.status.slice(1);
          const host = c.host ? (c.port ? c.host + ':' + c.port : c.host) : '-';
          return '<tr>' +
            '<td><span class="status-dot ' + c.status + '"></span>' + statusLabel + '</td>' +
            '<td>' + escapeHtml(c.name) + '</td>' +
            '<td>' + escapeHtml(c.driverId) + '</td>' +
            '<td>' + escapeHtml(host) + '</td>' +
            '<td>' + escapeHtml(c.database || '-') + '</td>' +
            '<td>' + latencyBar(c.latency) + '</td>' +
            '<td class="actions">' +
              (c.status === 'connected'
                ? '<button onclick="doAction(\\'disconnect\\',\\'' + c.id + '\\')">Disconnect</button>'
                : '<button onclick="doAction(\\'connect\\',\\'' + c.id + '\\')">Connect</button>') +
              '<button onclick="doAction(\\'ping\\',\\'' + c.id + '\\')">Ping</button>' +
            '</td>' +
          '</tr>';
        }).join('');
      }

      // Queries table
      const queryBody = document.getElementById('queryBody');
      if (state.recentQueries.length === 0) {
        queryBody.innerHTML = '<tr><td colspan="6" class="empty">No recent queries</td></tr>';
      } else {
        queryBody.innerHTML = state.recentQueries.map(q => {
          const statusHtml = q.success
            ? '<span class="query-success">&#10003; OK</span>'
            : '<span class="query-fail">&#10007; ' + escapeHtml(q.error || 'Error') + '</span>';
          return '<tr>' +
            '<td>' + formatTime(q.timestamp) + '</td>' +
            '<td>' + escapeHtml(q.connectionName || '-') + '</td>' +
            '<td class="query-sql" title="' + escapeAttr(q.sql) + '">' + escapeHtml(q.sql) + '</td>' +
            '<td>' + formatDuration(q.durationMs) + '</td>' +
            '<td>' + (q.rowCount !== undefined ? q.rowCount : '-') + '</td>' +
            '<td>' + statusHtml + '</td>' +
          '</tr>';
        }).join('');
      }
    }

    function doAction(action, id) {
      vscode.postMessage({ type: action, id });
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeAttr(str) {
      return escapeHtml(str).replace(/'/g, '&#39;');
    }
  </script>
</body>
</html>`
  }
}
