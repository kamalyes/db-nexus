import { ExtensionContext, ViewColumn, window, WebviewPanel } from 'vscode'
import { t } from '@/i18n'

export class DataEditPanel {
  private static currentPanel: DataEditPanel | undefined
  private readonly _panel: WebviewPanel
  private _disposables: any[] = []

  static show(context: ExtensionContext, sql: string, onExecute?: (sql: string) => void): void {
    const column = ViewColumn.Beside
    if (DataEditPanel.currentPanel) {
      DataEditPanel.currentPanel._panel.webview.postMessage({
        type: 'update',
        sql
      })
      DataEditPanel.currentPanel._panel.reveal(column)
      return
    }

    const panel = window.createWebviewPanel(
      'dbNexus.dataEdit',
      t('dataEdit.title'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    DataEditPanel.currentPanel = new DataEditPanel(panel, context, sql, onExecute)
  }

  private constructor(
    panel: WebviewPanel,
    context: ExtensionContext,
    initialSql: string,
    private readonly onExecute?: (sql: string) => void
  ) {
    this._panel = panel
    this._update(initialSql)

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)
    this._panel.webview.onDidReceiveMessage(
      (message) => this._handleMessage(message),
      null,
      this._disposables
    )
  }

  dispose(): void {
    DataEditPanel.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }

  private _handleMessage(message: any): void {
    switch (message.type) {
      case 'execute':
        if (this.onExecute) {
          this.onExecute(message.sql)
        }
        break
      case 'cancel':
        this._panel.dispose()
        break
    }
  }

  private _update(sql: string): void {
    this._panel.webview.html = this._getHtmlForWebview(sql)
  }

  private _getHtmlForWebview(sql: string): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h2 {
      margin-top: 0;
      font-size: 16px;
    }
    .sql-editor {
      width: 100%;
      height: 300px;
      font-family: var(--vscode-editor-font-family);
      font-size: 13px;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      resize: vertical;
      margin: 8px 0 16px 0;
    }
    .button-group {
      display: flex;
      gap: 8px;
    }
    button {
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
    }
    .execute-btn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid var(--vscode-button-border);
    }
    .execute-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .cancel-btn {
      background: var(--vscode-secondaryButton-background);
      color: var(--vscode-secondaryButton-foreground);
      border: 1px solid var(--vscode-secondaryButton-border);
    }
    .cancel-btn:hover {
      background: var(--vscode-secondaryButton-hoverBackground);
    }
  </style>
  <title>${t('dataEdit.title')}</title>
</head>
<body>
  <h2>${t('dataEdit.preview')}</h2>
  <textarea id="sqlEditor" class="sql-editor">${escapeHtml(sql)}</textarea>
  <div class="button-group">
    <button class="execute-btn" onclick="executeSQL()">${t('dataEdit.execute')}</button>
    <button class="cancel-btn" onclick="cancel()">${t('common.cancel')}</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function executeSQL() {
      const sql = document.getElementById('sqlEditor').value;
      vscode.postMessage({ type: 'execute', sql });
    }

    function cancel() {
      vscode.postMessage({ type: 'cancel' });
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'update') {
        document.getElementById('sqlEditor').value = message.sql;
      }
    });
  </script>
</body>
</html>`
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
