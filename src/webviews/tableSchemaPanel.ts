import { ExtensionContext, ViewColumn, window } from 'vscode'
import { TableSchema } from '../core/types'
import { t } from '../i18n'

export class TableSchemaPanel {
  static show(context: ExtensionContext, title: string, schema: TableSchema): void {
    const panel = window.createWebviewPanel(
      'dbNexus.tableSchema',
      title,
      ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    panel.webview.html = this.render(schema)
    context.subscriptions.push(panel)
  }

  private static render(schema: TableSchema): string {
    const columnsHtml = schema.columns.map(col => `
      <tr>
        <td>${escapeHtml(col.name)}</td>
        <td><code>${escapeHtml(col.type)}</code></td>
        <td>${col.nullable ? '✓' : ''}</td>
        <td>${col.isPrimaryKey ? '🔑' : ''}</td>
        <td>${col.isAutoIncrement ? '🔄' : ''}</td>
        <td>${col.defaultValue ? escapeHtml(col.defaultValue) : '<span class="muted">NULL</span>'}</td>
        <td>${col.comment ? escapeHtml(col.comment) : ''}</td>
      </tr>
    `).join('')

    const indexesHtml = schema.indexes.length > 0 ? `
      <h2>${t('table.indexes')}</h2>
      <table>
        <thead>
          <tr>
            <th>${t('table.indexName')}</th>
            <th>${t('table.columns')}</th>
            <th>${t('table.unique')}</th>
            <th>${t('table.type')}</th>
          </tr>
        </thead>
        <tbody>
          ${schema.indexes.map(idx => {
            const columns = Array.isArray(idx.columns) 
              ? idx.columns.map(c => escapeHtml(c)).join(', ')
              : escapeHtml(String(idx.columns))
            return `
              <tr>
                <td>${escapeHtml(idx.name)}</td>
                <td>${columns}</td>
                <td>${idx.isUnique ? '✓' : ''}</td>
                <td>${idx.isPrimary ? t('table.primaryKey') : (idx.type || '')}</td>
              </tr>
            `
          }).join('')}
        </tbody>
      </table>
    ` : ''

    const foreignKeysHtml = schema.foreignKeys.length > 0 ? `
      <h2>${t('table.foreignKeys')}</h2>
      <table>
        <thead>
          <tr>
            <th>${t('table.fkName')}</th>
            <th>${t('table.columns')}</th>
            <th>${t('table.references')}</th>
            <th>${t('table.onUpdate')}</th>
            <th>${t('table.onDelete')}</th>
          </tr>
        </thead>
        <tbody>
          ${schema.foreignKeys.map(fk => {
            const columns = Array.isArray(fk.columns)
              ? fk.columns.map(c => escapeHtml(c)).join(', ')
              : escapeHtml(String(fk.columns))
            const refColumns = Array.isArray(fk.referencedColumns)
              ? fk.referencedColumns.map(c => escapeHtml(c)).join(', ')
              : escapeHtml(String(fk.referencedColumns))
            return `
              <tr>
                <td>${escapeHtml(fk.name)}</td>
                <td>${columns}</td>
                <td>${escapeHtml(fk.referencedTable)} (${refColumns})</td>
                <td>${escapeHtml(fk.onUpdate || '')}</td>
                <td>${escapeHtml(fk.onDelete || '')}</td>
              </tr>
            `
          }).join('')}
        </tbody>
      </table>
    ` : ''

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
    h1 { font-size: 18px; margin: 0 0 16px 0; }
    h2 { font-size: 14px; margin: 24px 0 12px 0; color: var(--vscode-titleBar-activeForeground); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 8px 12px; text-align: left; }
    th { background: var(--vscode-editor-lineHighlightBackground); font-weight: 600; }
    code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-size: 11px; }
    .muted { color: var(--vscode-descriptionForeground); }
  </style>
  <title>${escapeHtml(schema.name)}</title>
</head>
<body>
  <h1>${t('table.schemaTitle', schema.name)}</h1>
  
  <h2>${t('table.columns')}</h2>
  <table>
    <thead>
      <tr>
        <th>${t('table.columnName')}</th>
        <th>${t('table.columnType')}</th>
        <th>${t('table.nullable')}</th>
        <th>${t('table.key')}</th>
        <th>${t('table.auto')}</th>
        <th>${t('table.default')}</th>
        <th>${t('table.comment')}</th>
      </tr>
    </thead>
    <tbody>
      ${columnsHtml}
    </tbody>
  </table>
  
  ${indexesHtml}
  ${foreignKeysHtml}
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
