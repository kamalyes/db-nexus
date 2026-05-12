import { ExtensionContext, ViewColumn, window } from 'vscode'
import { QueryResult } from '../core/types'
import { t } from '../i18n'

export class ResultPanel {
  static show(context: ExtensionContext, title: string, result: QueryResult): void {
    const panel = window.createWebviewPanel(
      'dbNexus.result',
      title,
      ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    panel.webview.html = this.render(result)
    context.subscriptions.push(panel)
  }

  private static render(result: QueryResult): string {
    const headers = result.columns.map(column => `<th>${escapeHtml(column.name)}</th>`).join('')
    const rows = result.rows.map(row => {
      const cells = result.columns
        .map(column => `<td>${escapeHtml(formatValue(row[column.name]))}</td>`)
        .join('')
      return `<tr>${cells}</tr>`
    }).join('')

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { --grid-border: var(--vscode-panel-border, rgba(127, 127, 127, 0.45)); }
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    header { padding: 12px 16px; border-bottom: 1px solid var(--grid-border); display: flex; gap: 16px; align-items: center; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid var(--grid-border); padding: 6px 8px; text-align: left; white-space: nowrap; }
    th { position: sticky; top: 0; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); z-index: 1; }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    .wrap { overflow: auto; height: calc(100vh - 49px); }
    .muted { color: var(--vscode-descriptionForeground); }
  </style>
  <title>${escapeHtml(t('webview.resultTitle'))}</title>
</head>
<body>
  <header>
    <strong>${escapeHtml(t('query.rows', result.rowCount))}</strong>
    <span class="muted">${result.elapsedMs} ms</span>
  </header>
  <div class="wrap">
    <table>
      <thead><tr>${headers}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</body>
</html>`
  }
}

function formatValue(value: unknown): string {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
