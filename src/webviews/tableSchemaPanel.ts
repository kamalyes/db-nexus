import { ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode'
import { DbConnectionProfile, SchemaObject, SchemaScope, TableColumn, TableSchema } from '../core/types'
import { t } from '../i18n'

type TableSchemaTab = 'fields' | 'indexes' | 'foreignKeys' | 'checks' | 'triggers' | 'options' | 'comment' | 'sql'

type TableSchemaPanelRecord = {
  panel: WebviewPanel
  profileId?: string
  scope: SchemaScope
}

interface TableSchemaPanelContext {
  profile?: DbConnectionProfile
  scope?: SchemaScope
  objectType?: SchemaObject['type']
  rowCount?: number
  description?: string
  initialTab?: TableSchemaTab
  selectedIndexName?: string
}

export class TableSchemaPanel {
  private static readonly panels = new Set<TableSchemaPanelRecord>()

  static show(
    context: ExtensionContext,
    title: string,
    schema: TableSchema,
    panelContext: TableSchemaPanelContext = {}
  ): void {
    const panel = window.createWebviewPanel(
      'dbNexus.tableSchema',
      title,
      ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    const record: TableSchemaPanelRecord = {
      panel,
      profileId: panelContext.profile?.id,
      scope: { ...(panelContext.scope || {}) }
    }
    this.panels.add(record)
    panel.onDidDispose(() => this.panels.delete(record))

    panel.webview.html = this.render(schema, panelContext)
    context.subscriptions.push(panel)
  }

  static closeFor(profile: DbConnectionProfile, scope: SchemaScope = {}): number {
    let closedCount = 0
    for (const record of Array.from(this.panels)) {
      if (record.profileId !== profile.id || !isScopeWithin(record.scope, scope)) {
        continue
      }

      record.panel.dispose()
      closedCount++
    }
    return closedCount
  }

  private static render(schema: TableSchema, panelContext: TableSchemaPanelContext): string {
    const profile = panelContext.profile
    const scope = panelContext.scope || {}
    const objectType = panelContext.objectType || 'table'
    const metadata = schema.metadata || {}
    const qualifiedName = getQualifiedName(profile, scope, schema.name)
    const initialTab = panelContext.initialTab || 'fields'
    const selectedIndexName = panelContext.selectedIndexName
    const primaryKeys = schema.columns.filter(column => column.isPrimaryKey).map(column => column.name)
    const autoIncrementColumns = schema.columns.filter(column => column.isAutoIncrement).map(column => column.name)
    const nullableColumns = schema.columns.filter(column => column.nullable).length
    const notNullColumns = schema.columns.length - nullableColumns
    const columnDetails = schema.columns.map(column => ({
      name: column.name,
      type: column.type,
      length: getTypeParts(column.type).length || '--',
      decimals: getTypeParts(column.type).decimals || '--',
      notNull: !column.nullable ? t('common.yes') : t('common.no'),
      primaryKey: column.isPrimaryKey ? t('common.yes') : t('common.no'),
      autoIncrement: column.isAutoIncrement ? t('common.yes') : t('common.no'),
      defaultValue: formatEmpty(column.defaultValue),
      comment: formatEmpty(column.comment),
      position: column.position
    }))

    const fieldRowsHtml = schema.columns.map((column, index) => {
      const typeParts = getTypeParts(column.type)
      const keyLabel = column.isPrimaryKey ? `PK ${primaryKeys.indexOf(column.name) + 1}` : ''
      return `
        <tr class="field-row ${index === 0 ? 'selected' : ''}" data-column="${escapeAttribute(column.name)}">
          <td>${escapeHtml(column.name)}</td>
          <td>${escapeHtml(typeParts.baseType || column.type)}</td>
          <td>${escapeHtml(typeParts.length || '')}</td>
          <td>${escapeHtml(typeParts.decimals || '')}</td>
          <td class="check-cell"><input type="checkbox" disabled ${!column.nullable ? 'checked' : ''}></td>
          <td class="check-cell"><input type="checkbox" disabled ${column.isAutoIncrement ? 'checked' : ''}></td>
          <td>${escapeHtml(keyLabel)}</td>
          <td>${escapeHtml(formatEmpty(column.defaultValue))}</td>
          <td>${escapeHtml(formatEmpty(column.comment))}</td>
        </tr>
      `
    }).join('')

    const indexRowsHtml = schema.indexes.map(index => `
      <tr class="index-row ${index.name === selectedIndexName ? 'selected' : ''}" data-index="${escapeAttribute(index.name)}">
        <td>${escapeHtml(index.name)}</td>
        <td>${escapeHtml(index.columns.join(', '))}</td>
        <td class="check-cell"><input type="checkbox" disabled ${index.isUnique ? 'checked' : ''}></td>
        <td>${index.isPrimary ? t('table.primaryKey') : escapeHtml(index.type || '')}</td>
      </tr>
    `).join('')

    const foreignKeyRowsHtml = schema.foreignKeys.map(foreignKey => `
      <tr>
        <td>${escapeHtml(foreignKey.name)}</td>
        <td>${escapeHtml(foreignKey.columns.join(', '))}</td>
        <td>${escapeHtml(foreignKey.referencedTable)} (${escapeHtml(foreignKey.referencedColumns.join(', '))})</td>
        <td>${escapeHtml(foreignKey.onUpdate || '')}</td>
        <td>${escapeHtml(foreignKey.onDelete || '')}</td>
      </tr>
    `).join('')

    const infoHtml = [
      renderInfoSection(t('table.connectionInfo'), [
        [t('table.driver'), profile?.driverId],
        [t('form.host'), profile?.host || (profile?.filePath ? profile.filePath : undefined)],
        [t('form.port'), profile?.port],
        [t('form.username'), profile?.username],
        [t('form.sslPrompt'), profile?.ssl ? t('form.sslEnabled') : t('form.sslDisabled')],
        [t('table.serverVersion'), metadata.serverVersion],
        [t('table.sessions'), metadata.activeSessions]
      ]),
      renderInfoSection(t('table.databaseInfo'), [
        [t('table.databaseName'), metadata.databaseName],
        [t('form.database'), scope.database || profile?.database],
        [t('table.schema'), metadata.schemaName || scope.schema],
        [t('table.charset'), metadata.charset],
        [t('table.collation'), metadata.tableCollation],
        [t('table.databaseSize'), formatBytes(metadata.databaseSize)],
        [t('table.pageCount'), metadata.pageCount],
        [t('table.pageSize'), formatBytes(metadata.pageSize)],
        [t('table.freeListCount'), metadata.freeListCount],
        [t('table.schemaVersion'), metadata.schemaVersion],
        [t('table.userVersion'), metadata.userVersion],
        [t('table.journalMode'), metadata.journalMode]
      ]),
      renderInfoSection(t('table.tableInfo'), [
        [t('table.objectType'), objectType],
        [t('table.rowCount'), panelContext.rowCount ?? metadata.tableRows],
        [t('table.owner'), metadata.owner],
        [t('table.engine'), metadata.engine],
        [t('table.autoIncrement'), metadata.autoIncrement],
        [t('table.rowFormat'), metadata.rowFormat],
        [t('table.createTime'), metadata.createTime],
        [t('table.updateTime'), metadata.updateTime],
        [t('table.checkTime'), metadata.checkTime],
        [t('table.dataLength'), formatBytes(metadata.dataLength)],
        [t('table.indexLength'), formatBytes(metadata.indexLength)],
        [t('table.totalLength'), formatBytes(metadata.totalLength)],
        [t('table.maxDataLength'), formatBytes(metadata.maxDataLength)],
        [t('table.sortingKey'), metadata.sortingKey],
        [t('table.partitionKey'), metadata.partitionKey],
        [t('table.checkCount'), metadata.checkCount],
        [t('table.columnCount'), schema.columns.length],
        [t('table.indexCount'), schema.indexes.length],
        [t('table.foreignKeyCount'), schema.foreignKeys.length],
        [t('table.primaryKeys'), primaryKeys.join(', ') || metadata.primaryKeys],
        [t('table.autoIncrementColumns'), autoIncrementColumns.join(', ')],
        [t('table.nullableColumns'), nullableColumns],
        [t('table.notNullColumns'), notNullColumns]
      ])
    ].join('')

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-size: 13px;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      height: 100vh;
      min-height: 520px;
    }
    .main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border);
    }
    .titlebar {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 36px;
      padding: 0 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
      white-space: nowrap;
      overflow: hidden;
    }
    .table-icon {
      width: 18px;
      height: 18px;
      border-radius: 3px;
      background:
        linear-gradient(90deg, rgba(255,255,255,.24) 1px, transparent 1px),
        linear-gradient(0deg, rgba(255,255,255,.24) 1px, transparent 1px),
        var(--vscode-button-background);
      background-size: 9px 9px;
      flex: 0 0 auto;
    }
    .title {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 36px;
      padding: 4px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .tool {
      border: 0;
      color: var(--vscode-foreground);
      background: transparent;
      padding: 4px 8px;
      border-radius: 4px;
      font: inherit;
      cursor: default;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .tool:hover { background: var(--vscode-toolbar-hoverBackground); }
    .tool[disabled] {
      color: var(--vscode-disabledForeground);
      opacity: .78;
    }
    .tabs {
      display: flex;
      gap: 0;
      min-height: 31px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
      overflow-x: auto;
    }
    .tab {
      border: 0;
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 2px solid transparent;
      color: var(--vscode-foreground);
      background: transparent;
      padding: 6px 12px 5px;
      font: inherit;
      white-space: nowrap;
      cursor: pointer;
    }
    .tab:hover { background: var(--vscode-list-hoverBackground); }
    .tab.active {
      background: var(--vscode-tab-activeBackground);
      border-bottom-color: var(--vscode-focusBorder);
      color: var(--vscode-tab-activeForeground);
    }
    .content {
      min-height: 0;
      flex: 1;
      overflow: auto;
    }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    th, td {
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 5px 8px;
      line-height: 19px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: left;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      font-weight: 600;
    }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody tr.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .check-cell { text-align: center; }
    input[type="checkbox"] {
      width: 14px;
      height: 14px;
      margin: 0;
      vertical-align: middle;
      accent-color: var(--vscode-checkbox-selectBackground);
    }
    .empty {
      padding: 18px 14px;
      color: var(--vscode-descriptionForeground);
    }
    .sql-preview {
      margin: 0;
      padding: 14px;
      min-height: 100%;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-textCodeBlock-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      overflow: auto;
    }
    .side {
      min-width: 0;
      overflow: auto;
      background: var(--vscode-sideBar-background);
    }
    .side-header {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 16px 16px 10px;
    }
    .side-icon {
      width: 52px;
      height: 52px;
      border-radius: 6px;
      background:
        linear-gradient(90deg, rgba(255,255,255,.22) 1px, transparent 1px),
        linear-gradient(0deg, rgba(255,255,255,.22) 1px, transparent 1px),
        var(--vscode-button-background);
      background-size: 17px 17px;
      flex: 0 0 auto;
    }
    .side-title {
      min-width: 0;
      font-size: 15px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .side-kind {
      margin-top: 4px;
      color: var(--vscode-descriptionForeground);
    }
    .side-section {
      padding: 12px 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .side-section h2 {
      margin: 0 0 10px;
      font-size: 12px;
      font-weight: 700;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .info-row {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: 10px;
      margin: 0 0 10px;
    }
    .info-label {
      color: var(--vscode-descriptionForeground);
      overflow-wrap: anywhere;
    }
    .info-value {
      overflow-wrap: anywhere;
    }
    .muted { color: var(--vscode-descriptionForeground); }
    .comment {
      padding: 12px;
      white-space: pre-wrap;
      color: var(--vscode-foreground);
    }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .side {
        border-top: 1px solid var(--vscode-panel-border);
        max-height: 340px;
      }
    }
  </style>
  <title>${escapeHtml(schema.name)}</title>
</head>
<body>
  <div class="shell">
    <main class="main">
      <div class="titlebar">
        <div class="table-icon"></div>
        <div class="title">${escapeHtml(schema.name)}</div>
        <div class="subtitle">${escapeHtml(qualifiedName)}</div>
      </div>

      <div class="toolbar" aria-label="Table design actions">
        <button class="tool" disabled>${t('common.save')}</button>
        <button class="tool" disabled>${t('table.addColumnAction')}</button>
        <button class="tool" disabled>${t('table.insertColumnAction')}</button>
        <button class="tool" disabled>${t('table.dropColumnAction')}</button>
        <button class="tool" disabled>${t('table.primaryKey')}</button>
        <button class="tool" disabled>${t('table.moveUp')}</button>
        <button class="tool" disabled>${t('table.moveDown')}</button>
      </div>

      <nav class="tabs" aria-label="Table schema tabs">
        <button class="tab ${getActiveClass(initialTab, 'fields')}" data-tab="fields">${t('table.columns')}</button>
        <button class="tab ${getActiveClass(initialTab, 'indexes')}" data-tab="indexes">${t('table.indexes')}</button>
        <button class="tab ${getActiveClass(initialTab, 'foreignKeys')}" data-tab="foreignKeys">${t('table.foreignKeys')}</button>
        <button class="tab ${getActiveClass(initialTab, 'checks')}" data-tab="checks">${t('table.checks')}</button>
        <button class="tab ${getActiveClass(initialTab, 'triggers')}" data-tab="triggers">${t('table.triggers')}</button>
        <button class="tab ${getActiveClass(initialTab, 'options')}" data-tab="options">${t('table.options')}</button>
        <button class="tab ${getActiveClass(initialTab, 'comment')}" data-tab="comment">${t('table.comment')}</button>
        <button class="tab ${getActiveClass(initialTab, 'sql')}" data-tab="sql">${t('table.sqlPreview')}</button>
      </nav>

      <section class="content">
        <div class="tab-panel ${getActiveClass(initialTab, 'fields')}" id="tab-fields">
          <table>
            <thead>
              <tr>
                <th style="width: 220px">${t('table.columnName')}</th>
                <th style="width: 150px">${t('table.columnType')}</th>
                <th style="width: 80px">${t('table.length')}</th>
                <th style="width: 80px">${t('table.decimals')}</th>
                <th style="width: 90px">${t('table.notNull')}</th>
                <th style="width: 80px">${t('table.auto')}</th>
                <th style="width: 100px">${t('table.key')}</th>
                <th style="width: 160px">${t('table.default')}</th>
                <th>${t('table.comment')}</th>
              </tr>
            </thead>
            <tbody>${fieldRowsHtml}</tbody>
          </table>
        </div>

        <div class="tab-panel ${getActiveClass(initialTab, 'indexes')}" id="tab-indexes">
          ${schema.indexes.length > 0 ? `
            <table>
              <thead>
                <tr>
                  <th>${t('table.indexName')}</th>
                  <th>${t('table.columns')}</th>
                  <th style="width: 100px">${t('table.unique')}</th>
                  <th style="width: 140px">${t('table.type')}</th>
                </tr>
              </thead>
              <tbody>${indexRowsHtml}</tbody>
            </table>
          ` : `<div class="empty">${t('table.noIndexes')}</div>`}
        </div>

        <div class="tab-panel ${getActiveClass(initialTab, 'foreignKeys')}" id="tab-foreignKeys">
          ${schema.foreignKeys.length > 0 ? `
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
              <tbody>${foreignKeyRowsHtml}</tbody>
            </table>
          ` : `<div class="empty">${t('table.noForeignKeys')}</div>`}
        </div>

        <div class="tab-panel ${getActiveClass(initialTab, 'checks')}" id="tab-checks"><div class="empty">${t('table.notSupportedYet')}</div></div>
        <div class="tab-panel ${getActiveClass(initialTab, 'triggers')}" id="tab-triggers"><div class="empty">${t('table.notSupportedYet')}</div></div>
        <div class="tab-panel ${getActiveClass(initialTab, 'options')}" id="tab-options">
          ${renderInfoSection('', [
            [t('table.engine'), metadata.engine],
            [t('table.rowFormat'), metadata.rowFormat],
            [t('table.charset'), metadata.charset],
            [t('table.collation'), metadata.tableCollation],
            [t('table.dataLength'), formatBytes(metadata.dataLength)],
            [t('table.indexLength'), formatBytes(metadata.indexLength)]
          ])}
        </div>
        <div class="tab-panel ${getActiveClass(initialTab, 'comment')}" id="tab-comment">
          <div class="comment">${escapeHtml(formatEmpty(schema.comment))}</div>
        </div>
        <div class="tab-panel ${getActiveClass(initialTab, 'sql')}" id="tab-sql">
          <pre class="sql-preview">${escapeHtml(String(metadata.createSql || buildCreateTablePreview(profile, scope, schema)))}</pre>
        </div>
      </section>
    </main>

    <aside class="side">
      <div class="side-header">
        <div class="side-icon"></div>
        <div>
          <div class="side-title">${escapeHtml(schema.name)}</div>
          <div class="side-kind">${escapeHtml(objectType)}</div>
        </div>
      </div>
      ${infoHtml}
      <section class="side-section" id="columnInfo">
        <h2>${t('table.selectedColumn')}</h2>
        <div class="info-row"><div class="info-label">${t('table.columnName')}</div><div class="info-value" data-field="name">--</div></div>
        <div class="info-row"><div class="info-label">${t('table.columnType')}</div><div class="info-value" data-field="type">--</div></div>
        <div class="info-row"><div class="info-label">${t('table.length')}</div><div class="info-value" data-field="length">--</div></div>
        <div class="info-row"><div class="info-label">${t('table.decimals')}</div><div class="info-value" data-field="decimals">--</div></div>
        <div class="info-row"><div class="info-label">${t('table.notNull')}</div><div class="info-value" data-field="notNull">--</div></div>
        <div class="info-row"><div class="info-label">${t('table.primaryKey')}</div><div class="info-value" data-field="primaryKey">--</div></div>
        <div class="info-row"><div class="info-label">${t('table.auto')}</div><div class="info-value" data-field="autoIncrement">--</div></div>
        <div class="info-row"><div class="info-label">${t('table.default')}</div><div class="info-value" data-field="defaultValue">--</div></div>
        <div class="info-row"><div class="info-label">${t('table.comment')}</div><div class="info-value" data-field="comment">--</div></div>
      </section>
    </aside>
  </div>

  <script>
    const columnDetails = ${escapeScriptJson(JSON.stringify(columnDetails))};
    const initialTab = ${escapeScriptJson(JSON.stringify(initialTab))};
    const selectedIndexName = ${escapeScriptJson(JSON.stringify(selectedIndexName || null))};

    function activateTab(tabName) {
      const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
      const panel = document.getElementById('tab-' + tabName);
      if (!tab || !panel) return;

      document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(item => item.classList.remove('active'));
      tab.classList.add('active');
      panel.classList.add('active');
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activateTab(tab.dataset.tab);
      });
    });

    function updateColumnInfo(columnName) {
      const detail = columnDetails.find(item => item.name === columnName) || columnDetails[0];
      if (!detail) return;

      document.querySelectorAll('#columnInfo [data-field]').forEach(item => {
        const field = item.dataset.field;
        item.textContent = detail[field] || '--';
      });
    }

    document.querySelectorAll('.field-row').forEach(row => {
      row.addEventListener('click', () => {
        document.querySelectorAll('.field-row').forEach(item => item.classList.remove('selected'));
        row.classList.add('selected');
        updateColumnInfo(row.dataset.column);
      });
    });

    if (columnDetails.length > 0) {
      updateColumnInfo(columnDetails[0].name);
    }

    activateTab(initialTab);

    if (selectedIndexName) {
      const selectedIndexRow = Array.from(document.querySelectorAll('.index-row'))
        .find(row => row.dataset.index === selectedIndexName);
      if (selectedIndexRow) {
        selectedIndexRow.scrollIntoView({ block: 'center' });
      }
    }
  </script>
</body>
</html>`
  }
}

function getActiveClass(activeTab: TableSchemaTab, tab: TableSchemaTab): string {
  return activeTab === tab ? 'active' : ''
}

function isScopeWithin(scope: SchemaScope, targetScope: SchemaScope): boolean {
  if (targetScope.database && scope.database !== targetScope.database) {
    return false
  }
  if (targetScope.schema && scope.schema !== targetScope.schema) {
    return false
  }
  if (targetScope.parentName && scope.parentName !== targetScope.parentName) {
    return false
  }
  return true
}

function renderInfoSection(title: string, rows: Array<[string, unknown]>): string {
  const visibleRows = rows.filter(([, value]) => formatEmpty(value) !== '--')
  if (visibleRows.length === 0) {
    return ''
  }

  return `
    <section class="side-section">
      ${title ? `<h2>${escapeHtml(title)}</h2>` : ''}
      ${visibleRows.map(([label, value]) => `
        <div class="info-row">
          <div class="info-label">${escapeHtml(label)}</div>
          <div class="info-value">${escapeHtml(formatEmpty(value))}</div>
        </div>
      `).join('')}
    </section>
  `
}

function getTypeParts(type: string): { baseType: string; length?: string; decimals?: string } {
  const match = String(type).match(/^([a-zA-Z0-9_\s]+)(?:\(([^)]+)\))?/)
  if (!match) {
    return { baseType: type }
  }

  const values = (match[2] || '').split(',').map(part => part.trim()).filter(Boolean)
  return {
    baseType: match[1].trim(),
    length: values[0],
    decimals: values[1]
  }
}

function getQualifiedName(profile: DbConnectionProfile | undefined, scope: SchemaScope, name: string): string {
  if (!profile) {
    return name
  }

  const parts: string[] = []
  if (profile.driverId === 'mysql' || profile.driverId === 'mariadb' || profile.driverId === 'clickhouse') {
    if (scope.database || profile.database) {
      parts.push(scope.database || profile.database!)
    }
  } else if (profile.driverId !== 'sqlite' && profile.driverId !== 'duckdb') {
    if (scope.schema) {
      parts.push(scope.schema)
    } else if (scope.database || profile.database) {
      parts.push(scope.database || profile.database!)
    }
  }
  parts.push(name)

  return parts.join('.')
}

function buildCreateTablePreview(
  profile: DbConnectionProfile | undefined,
  scope: SchemaScope,
  schema: TableSchema
): string {
  const driverId = profile?.driverId || 'postgresql'
  const qualifiedName = getQualifiedName(profile, scope, schema.name)
    .split('.')
    .map(part => quoteIdentifier(driverId, part))
    .join('.')
  const columnLines = schema.columns.map(column => {
    const parts = [
      `  ${quoteIdentifier(driverId, column.name)}`,
      column.type
    ]
    if (!column.nullable) {
      parts.push('NOT NULL')
    }
    if (column.defaultValue !== undefined && column.defaultValue !== null && column.defaultValue !== '') {
      parts.push('DEFAULT', String(column.defaultValue))
    }
    if (column.isAutoIncrement && (driverId === 'mysql' || driverId === 'mariadb')) {
      parts.push('AUTO_INCREMENT')
    }
    return parts.join(' ')
  })

  const primaryKeys = schema.columns.filter(column => column.isPrimaryKey).map(column => quoteIdentifier(driverId, column.name))
  if (primaryKeys.length > 0) {
    columnLines.push(`  PRIMARY KEY (${primaryKeys.join(', ')})`)
  }

  return [
    `CREATE TABLE ${qualifiedName} (`,
    columnLines.join(',\n'),
    ');',
    ''
  ].join('\n')
}

function quoteIdentifier(driverId: string, identifier: string): string {
  if (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'clickhouse') {
    return `\`${String(identifier).replace(/`/g, '``')}\``
  }
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function formatBytes(value: unknown): string | undefined {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return undefined
  }

  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let size = numericValue
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]} (${numericValue.toLocaleString()})`
}

function formatEmpty(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '--'
  }
  return String(value)
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value).replace(/`/g, '&#096;')
}

function escapeScriptJson(value: string): string {
  return value
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
