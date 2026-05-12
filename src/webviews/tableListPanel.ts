import { ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode'
import { DbConnectionProfile, SchemaObject, SchemaScope } from '@/core/types'
import { DatabaseDriver } from '@/drivers/base'
import { t } from '@/i18n'
import { TableDataPanel } from '@/webviews/tableDataPanel'

export class TableListPanel {
  private static currentPanel: TableListPanel | undefined
  private readonly panel: WebviewPanel
  private readonly disposables: { dispose(): void }[] = []

  static show(
    context: ExtensionContext,
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    scope: SchemaScope,
    tables: SchemaObject[]
  ): void {
    if (TableListPanel.currentPanel) {
      TableListPanel.currentPanel.panel.dispose()
    }

    const title = `${scope.schema || scope.database || profile.name}: ${t('table.tables')}`
    const panel = window.createWebviewPanel(
      'dbNexus.tableList',
      title,
      ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    TableListPanel.currentPanel = new TableListPanel(panel, context, profile, driver, scope, tables)
  }

  private constructor(
    panel: WebviewPanel,
    private readonly context: ExtensionContext,
    private readonly profile: DbConnectionProfile,
    private readonly driver: DatabaseDriver,
    private readonly scope: SchemaScope,
    private readonly tables: SchemaObject[]
  ) {
    this.panel = panel
    this.panel.webview.html = this.render()
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
    this.panel.webview.onDidReceiveMessage(
      async message => {
        if (message.type === 'openTable' && typeof message.tableName === 'string') {
          this.openTable(message.tableName)
        }
      },
      null,
      this.disposables
    )
    context.subscriptions.push(panel)
  }

  private openTable(tableName: string): void {
    if (!this.driver.getTableData) {
      window.showErrorMessage(t('table.dataNotSupported'))
      return
    }

    TableDataPanel.show(this.context, this.profile, this.driver, tableName, this.scope)
  }

  private render(): string {
    const tableRows = this.tables.map(table => {
      const description = table.description || table.type
      return `
        <tr class="table-row" data-table="${escapeAttr(table.name)}" tabindex="0">
          <td class="name">${escapeHtml(table.name)}</td>
          <td>${escapeHtml(table.type)}</td>
          <td class="muted">${escapeHtml(description || '')}</td>
          <td><button data-table="${escapeAttr(table.name)}">${t('table.openData')}</button></td>
        </tr>
      `
    }).join('')

    const scopeLabel = [this.scope.database, this.scope.schema].filter(Boolean).join(' / ') || this.profile.name

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(t('table.tables'))}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.3;
      font-weight: 600;
    }
    .scope {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-top: 4px;
    }
    input {
      width: min(360px, 45vw);
      min-width: 180px;
      padding: 7px 10px;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: 13px;
    }
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .summary {
      margin-bottom: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .table-wrap {
      border: 1px solid var(--vscode-panel-border);
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      text-align: left;
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      font-weight: 600;
      z-index: 1;
    }
    tr.table-row {
      cursor: pointer;
    }
    tr.table-row:hover,
    tr.table-row:focus {
      background: var(--vscode-list-hoverBackground);
      outline: none;
    }
    .name {
      font-weight: 600;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    button {
      padding: 4px 10px;
      border: 0;
      border-radius: 4px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-family: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .empty {
      padding: 28px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(t('table.tables'))}</h1>
      <div class="scope">${escapeHtml(scopeLabel)}</div>
    </div>
    <input id="filter" type="search" placeholder="${escapeAttr(t('table.searchTables'))}">
  </header>
  <div class="summary">${this.tables.length} ${escapeHtml(t('table.tables'))}</div>
  <div class="table-wrap">
    ${this.tables.length === 0 ? `<div class="empty">${escapeHtml(t('connection.emptySchema'))}</div>` : `
      <table>
        <thead>
          <tr>
            <th>${escapeHtml(t('table.tableName'))}</th>
            <th>${escapeHtml(t('table.type'))}</th>
            <th>${escapeHtml(t('table.comment'))}</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="tableBody">
          ${tableRows}
        </tbody>
      </table>
    `}
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const rows = Array.from(document.querySelectorAll('.table-row'));
    const openButtons = Array.from(document.querySelectorAll('button[data-table]'));

    function openTable(tableName) {
      vscode.postMessage({ type: 'openTable', tableName });
    }

    rows.forEach(row => {
      row.addEventListener('dblclick', event => {
        if (event.target.closest && event.target.closest('button')) return;
        openTable(row.dataset.table);
      });
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          openTable(row.dataset.table);
        }
      });
    });

    openButtons.forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        openTable(button.dataset.table);
      });
    });

    document.getElementById('filter').addEventListener('input', event => {
      const value = event.target.value.toLowerCase();
      rows.forEach(row => {
        row.style.display = row.dataset.table.toLowerCase().includes(value) ? '' : 'none';
      });
    });
  </script>
</body>
</html>`
  }

  private dispose(): void {
    if (TableListPanel.currentPanel === this) {
      TableListPanel.currentPanel = undefined
    }
    while (this.disposables.length) {
      this.disposables.pop()?.dispose()
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#096;')
}
