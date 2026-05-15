import { ExtensionContext, ViewColumn, window, WebviewPanel } from 'vscode';
import { QueryHistoryService, QueryHistoryItem } from '@/services/queryHistoryService';
import { t } from '@/i18n';

export class QueryHistoryPanel {
  private static currentPanel: QueryHistoryPanel | undefined;
  private readonly _panel: WebviewPanel;
  private readonly _extensionUri: any;
  private _disposables: any[] = [];

  static show(context: ExtensionContext): void {
    const column = ViewColumn.Beside;
    if (QueryHistoryPanel.currentPanel) {
      QueryHistoryPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = window.createWebviewPanel(
      'dbNexus.queryHistory',
      t('history.title'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    QueryHistoryPanel.currentPanel = new QueryHistoryPanel(panel, context);
  }

  private constructor(panel: WebviewPanel, context: ExtensionContext) {
    this._panel = panel;
    this._extensionUri = context.extensionUri;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
  }

  dispose(): void {
    QueryHistoryPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private _update(): void {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    const history = QueryHistoryService.getInstance().getAll();

    const historyHtml = history.map(item => {
      const time = new Date(item.timestamp).toLocaleString();
      const statusClass = item.success ? 'success' : 'error';
      const statusIcon = item.success ? '✅' : '❌';
      const duration = item.durationMs ? `${item.durationMs}ms` : '';
      const rowCount = item.rowCount !== undefined ? `${item.rowCount} rows` : '';

      return `
        <div class="history-item ${statusClass}">
          <div class="header">
            <span class="status">${statusIcon}</span>
            <span class="time">${time}</span>
            <span class="conn">${escapeHtml(item.connectionName || '')}</span>
            <span class="meta">
              ${rowCount} ${duration}
            </span>
          </div>
          <div class="sql">${escapeHtml(item.sql)}</div>
          ${item.error ? `<div class="error">${escapeHtml(item.error)}</div>` : ''}
        </div>
      `;
    }).join('');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .empty { color: var(--vscode-descriptionForeground); padding: 32px 0; text-align: center; }
    .history-item { margin-bottom: 12px; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-editor-background); }
    .history-item.error { border-left: 3px solid var(--vscode-errorForeground); }
    .history-item.success { border-left: 3px solid var(--vscode-testing-iconPassed); }
    .header { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .status { font-size: 14px; }
    .conn { font-weight: 500; color: var(--vscode-foreground); }
    .meta { margin-left: auto; }
    .sql { font-family: var(--vscode-editor-font-family); font-size: 12px; padding: 8px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
    .error { margin-top: 8px; padding: 8px; background: rgba(255, 0, 0, 0.1); color: var(--vscode-errorForeground); border-radius: 3px; font-size: 12px; }
  </style>
  <title>${t('history.title')}</title>
</head>
<body>
  <h2>${t('history.title')}</h2>
  ${history.length === 0 ? `<div class="empty">${t('history.empty')}</div>` : historyHtml}
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
