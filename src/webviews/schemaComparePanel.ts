import { ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode'
import { DbConnectionProfile, SchemaScope, TableSchema, SchemaObject } from '@/core/types'
import { DatabaseDriver } from '@/drivers/base'
import { t } from '@/i18n'

export interface SchemaDifference {
  type: 'table_added' | 'table_removed' | 'table_modified' | 'column_added' | 'column_removed' | 'column_modified' | 'index_added' | 'index_removed' | 'fk_added' | 'fk_removed'
  tableName: string
  details: string
  sourceValue?: string
  targetValue?: string
}

export interface CompareResult {
  sourceProfile: DbConnectionProfile
  targetProfile: DbConnectionProfile
  differences: SchemaDifference[]
  sourceTables: string[]
  targetTables: string[]
}

export class SchemaComparePanel {
  private static currentPanel: SchemaComparePanel | undefined
  private readonly _panel: WebviewPanel
  private _disposables: any[] = []

  static async show(
    context: ExtensionContext,
    sourceProfile: DbConnectionProfile,
    sourceDriver: DatabaseDriver,
    targetProfile: DbConnectionProfile,
    targetDriver: DatabaseDriver
  ): Promise<void> {
    if (!sourceDriver.getTableSchema || !targetDriver.getTableSchema) {
      window.showErrorMessage(t('compare.notSupported'))
      return
    }

    const column = ViewColumn.Beside

    if (SchemaComparePanel.currentPanel) {
      SchemaComparePanel.currentPanel._panel.dispose()
    }

    const panel = window.createWebviewPanel(
      'dbNexus.schemaCompare',
      t('compare.title'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    const result = await SchemaComparePanel._compareSchemas(
      sourceProfile,
      sourceDriver,
      targetProfile,
      targetDriver
    )

    SchemaComparePanel.currentPanel = new SchemaComparePanel(panel, result)
  }

  private static async _compareSchemas(
    sourceProfile: DbConnectionProfile,
    sourceDriver: DatabaseDriver,
    targetProfile: DbConnectionProfile,
    targetDriver: DatabaseDriver
  ): Promise<CompareResult> {
    const differences: SchemaDifference[] = []

    const sourceObjects = await sourceDriver.listObjects(sourceProfile, {})
    const targetObjects = await targetDriver.listObjects(targetProfile, {})

    const sourceTables = sourceObjects.filter(obj => obj.type === 'table').map(obj => obj.name)
    const targetTables = targetObjects.filter(obj => obj.type === 'table').map(obj => obj.name)

    const addedTables = sourceTables.filter(t => !targetTables.includes(t))
    const removedTables = targetTables.filter(t => !sourceTables.includes(t))
    const commonTables = sourceTables.filter(t => targetTables.includes(t))

    for (const table of addedTables) {
      differences.push({
        type: 'table_added',
        tableName: table,
        details: t('compare.tableAdded')
      })
    }

    for (const table of removedTables) {
      differences.push({
        type: 'table_removed',
        tableName: table,
        details: t('compare.tableRemoved')
      })
    }

    for (const table of commonTables) {
      try {
        if (!sourceDriver.getTableSchema || !targetDriver.getTableSchema) {
          continue
        }
        const sourceSchema = await sourceDriver.getTableSchema(sourceProfile, table, {})
        const targetSchema = await targetDriver.getTableSchema(targetProfile, table, {})

        const columnDiffs = SchemaComparePanel._compareColumns(table, sourceSchema, targetSchema)
        differences.push(...columnDiffs)

        const indexDiffs = SchemaComparePanel._compareIndexes(table, sourceSchema, targetSchema)
        differences.push(...indexDiffs)

        const fkDiffs = SchemaComparePanel._compareForeignKeys(table, sourceSchema, targetSchema)
        differences.push(...fkDiffs)
      } catch (error) {
        console.error(`Failed to compare table ${table}:`, error)
      }
    }

    return {
      sourceProfile,
      targetProfile,
      differences,
      sourceTables,
      targetTables
    }
  }

  private static _compareColumns(
    tableName: string,
    sourceSchema: TableSchema,
    targetSchema: TableSchema
  ): SchemaDifference[] {
    const differences: SchemaDifference[] = []
    const sourceColumns = new Map(sourceSchema.columns.map(c => [c.name, c]))
    const targetColumns = new Map(targetSchema.columns.map(c => [c.name, c]))

    for (const [name, col] of sourceColumns) {
      if (!targetColumns.has(name)) {
        differences.push({
          type: 'column_added',
          tableName,
          details: t('compare.columnAdded', name)
        })
      } else {
        const targetCol = targetColumns.get(name)!
        if (col.type !== targetCol.type) {
          differences.push({
            type: 'column_modified',
            tableName,
            details: t('compare.columnTypeChanged', name),
            sourceValue: col.type,
            targetValue: targetCol.type
          })
        }
        if (col.nullable !== targetCol.nullable) {
          differences.push({
            type: 'column_modified',
            tableName,
            details: t('compare.columnNullableChanged', name),
            sourceValue: col.nullable ? 'NULL' : 'NOT NULL',
            targetValue: targetCol.nullable ? 'NULL' : 'NOT NULL'
          })
        }
      }
    }

    for (const name of targetColumns.keys()) {
      if (!sourceColumns.has(name)) {
        differences.push({
          type: 'column_removed',
          tableName,
          details: t('compare.columnRemoved', name)
        })
      }
    }

    return differences
  }

  private static _compareIndexes(
    tableName: string,
    sourceSchema: TableSchema,
    targetSchema: TableSchema
  ): SchemaDifference[] {
    const differences: SchemaDifference[] = []
    const sourceIndexes = new Map((sourceSchema.indexes || []).map(i => [i.name, i]))
    const targetIndexes = new Map((targetSchema.indexes || []).map(i => [i.name, i]))

    for (const name of sourceIndexes.keys()) {
      if (!targetIndexes.has(name)) {
        differences.push({
          type: 'index_added',
          tableName,
          details: t('compare.indexAdded', name)
        })
      }
    }

    for (const name of targetIndexes.keys()) {
      if (!sourceIndexes.has(name)) {
        differences.push({
          type: 'index_removed',
          tableName,
          details: t('compare.indexRemoved', name)
        })
      }
    }

    return differences
  }

  private static _compareForeignKeys(
    tableName: string,
    sourceSchema: TableSchema,
    targetSchema: TableSchema
  ): SchemaDifference[] {
    const differences: SchemaDifference[] = []
    const sourceFKs = new Map((sourceSchema.foreignKeys || []).map(fk => [fk.name, fk]))
    const targetFKs = new Map((targetSchema.foreignKeys || []).map(fk => [fk.name, fk]))

    for (const name of sourceFKs.keys()) {
      if (!targetFKs.has(name)) {
        differences.push({
          type: 'fk_added',
          tableName,
          details: t('compare.fkAdded', name)
        })
      }
    }

    for (const name of targetFKs.keys()) {
      if (!sourceFKs.has(name)) {
        differences.push({
          type: 'fk_removed',
          tableName,
          details: t('compare.fkRemoved', name)
        })
      }
    }

    return differences
  }

  private constructor(panel: WebviewPanel, result: CompareResult) {
    this._panel = panel

    this._panel.webview.html = this._getHtml(result)

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)
  }

  private _getHtml(result: CompareResult): string {
    const diffRows = result.differences.map(diff => `
      <tr class="diff-row diff-${diff.type}">
        <td>${diff.tableName}</td>
        <td><span class="diff-type ${diff.type}">${this._getDiffTypeLabel(diff.type)}</span></td>
        <td>${diff.details}</td>
        <td>${diff.sourceValue || '-'}</td>
        <td>${diff.targetValue || '-'}</td>
      </tr>
    `).join('')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('compare.title')}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 16px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      margin: 0;
    }
    h2 { margin-top: 0; }
    .summary {
      display: flex;
      gap: 24px;
      margin-bottom: 16px;
      padding: 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
    }
    .summary-item {
      display: flex;
      flex-direction: column;
    }
    .summary-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .summary-value {
      font-size: 18px;
      font-weight: bold;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    th {
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-weight: 600;
    }
    .diff-type {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }
    .diff-table_added { background: #28a745; color: white; }
    .diff-table_removed { background: #dc3545; color: white; }
    .diff-table_modified { background: #ffc107; color: black; }
    .diff-column_added { background: #17a2b8; color: white; }
    .diff-column_removed { background: #fd7e14; color: white; }
    .diff-column_modified { background: #6c757d; color: white; }
    .diff-index_added { background: #20c997; color: white; }
    .diff-index_removed { background: #e83e8c; color: white; }
    .diff-fk_added { background: #6f42c1; color: white; }
    .diff-fk_removed { background: #d63384; color: white; }
    .diff-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .no-diff {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <h2>${t('compare.title')}</h2>
  
  <div class="summary">
    <div class="summary-item">
      <span class="summary-label">${t('compare.source')}</span>
      <span class="summary-value">${result.sourceProfile.name}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">${t('compare.target')}</span>
      <span class="summary-value">${result.targetProfile.name}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">${t('compare.sourceTables')}</span>
      <span class="summary-value">${result.sourceTables.length}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">${t('compare.targetTables')}</span>
      <span class="summary-value">${result.targetTables.length}</span>
    </div>
    <div class="summary-item">
      <span class="summary-label">${t('compare.differences')}</span>
      <span class="summary-value">${result.differences.length}</span>
    </div>
  </div>

  ${result.differences.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>${t('compare.tableName')}</th>
          <th>${t('compare.type')}</th>
          <th>${t('compare.details')}</th>
          <th>${t('compare.sourceValue')}</th>
          <th>${t('compare.targetValue')}</th>
        </tr>
      </thead>
      <tbody>
        ${diffRows}
      </tbody>
    </table>
  ` : `
    <div class="no-diff">
      ${t('compare.noDifferences')}
    </div>
  `}
</body>
</html>`
  }

  private _getDiffTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      'table_added': t('compare.typeTableAdded'),
      'table_removed': t('compare.typeTableRemoved'),
      'table_modified': t('compare.typeTableModified'),
      'column_added': t('compare.typeColumnAdded'),
      'column_removed': t('compare.typeColumnRemoved'),
      'column_modified': t('compare.typeColumnModified'),
      'index_added': t('compare.typeIndexAdded'),
      'index_removed': t('compare.typeIndexRemoved'),
      'fk_added': t('compare.typeFkAdded'),
      'fk_removed': t('compare.typeFkRemoved')
    }
    return labels[type] || type
  }

  private dispose(): void {
    SchemaComparePanel.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }
}
