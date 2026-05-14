import { commands, ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode'
import { DbConnectionProfile, SchemaObject, SchemaScope, TableColumn, TableDesignDraft, TableSchema } from '../core/types'
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
  schemaLoadMs?: number
  loadedAt?: string
  mode?: 'design' | 'create'
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
    const scope = { ...(panelContext.scope || {}) }
    const objectType = panelContext.objectType || 'table'
    this.panels.add(record)

    let currentSchema = schema
    let currentPanelContext = { ...panelContext }
    panel.webview.html = this.render(currentSchema, currentPanelContext)
    const messageSubscription = panel.webview.onDidReceiveMessage(async message => {
      if (!message?.type || !currentPanelContext.profile) {
        return
      }

      const tableTarget = {
        profile: currentPanelContext.profile,
        scope,
        tableName: currentSchema.name,
        objectType,
        rowCount: currentPanelContext.rowCount,
        description: currentPanelContext.description,
        schema: currentSchema
      }

      if (message.type === 'generateMockData') {
        await commands.executeCommand('dbNexus.generateData', tableTarget)
        return
      }

      if (message.type === 'addColumn' || message.type === 'insertColumn') {
        await commands.executeCommand('dbNexus.addColumn', tableTarget)
        return
      }

      if (message.type === 'saveDesign' && isTableDesignDraft(message.draft)) {
        const updatedSchema = await commands.executeCommand<TableSchema | undefined>('dbNexus.saveTableDesign', {
          profile: currentPanelContext.profile,
          scope,
          tableName: currentSchema.name,
          objectType,
          originalSchema: currentSchema,
          draft: message.draft,
          mode: currentPanelContext.mode || 'design'
        })
        if (updatedSchema) {
          currentSchema = updatedSchema
          currentPanelContext = {
            ...currentPanelContext,
            mode: 'design',
            initialTab: isTableSchemaTab(message.activeTab) ? message.activeTab : currentPanelContext.initialTab,
            loadedAt: new Date().toISOString()
          }
          panel.title = t('table.schemaTitle', updatedSchema.name)
          panel.webview.html = this.render(currentSchema, currentPanelContext)
        }
        return
      }

      if (message.type === 'reloadSchema') {
        const activeTab = isTableSchemaTab(message.activeTab) ? message.activeTab : currentPanelContext.initialTab
        if ((currentPanelContext.mode || 'design') === 'create') {
          currentPanelContext = {
            ...currentPanelContext,
            initialTab: activeTab,
            loadedAt: new Date().toISOString()
          }
          panel.webview.html = this.render(currentSchema, currentPanelContext)
          return
        }

        const reloadedSchema = await commands.executeCommand<TableSchema | undefined>('dbNexus.reloadTableSchema', {
          profile: currentPanelContext.profile,
          scope,
          tableName: currentSchema.name,
          objectType
        })
        if (reloadedSchema) {
          currentSchema = reloadedSchema
          currentPanelContext = {
            ...currentPanelContext,
            mode: 'design',
            initialTab: activeTab,
            loadedAt: new Date().toISOString()
          }
          panel.title = t('table.schemaTitle', reloadedSchema.name)
          panel.webview.html = this.render(currentSchema, currentPanelContext)
        }
        return
      }

      if (message.type === 'dropColumn' && typeof message.columnName === 'string') {
        const column = currentSchema.columns.find(item => item.name === message.columnName)
        if (!column) {
          window.showWarningMessage(t('table.selectColumn'))
          return
        }

        await commands.executeCommand('dbNexus.dropColumn', {
          profile: currentPanelContext.profile,
          scope,
          tableName: currentSchema.name,
          columnName: column.name,
          columnType: column.type
        })
      }
    })
    panel.onDidDispose(() => {
      messageSubscription.dispose()
      this.panels.delete(record)
    })
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
    const tableComment = String(schema.comment || metadata.comment || '')
    const qualifiedName = getQualifiedName(profile, scope, schema.name)
    const initialTab = panelContext.initialTab || 'fields'
    const selectedIndexName = panelContext.selectedIndexName
    const mode = panelContext.mode || 'design'
    const isCreateMode = mode === 'create'
    const canEdit = !!profile && objectType === 'table'
    const primaryKeys = schema.columns.filter(column => column.isPrimaryKey).map(column => column.name)
    const primaryKeyIconHtml = `<span class="pk-indicator" title="${escapeAttribute(t('table.primaryKey'))}">&#128273;</span>`
    const autoIncrementColumns = schema.columns.filter(column => column.isAutoIncrement).map(column => column.name)
    const nullableColumns = schema.columns.filter(column => column.nullable).length
    const notNullColumns = schema.columns.length - nullableColumns
    const loadedAt = panelContext.loadedAt || new Date().toISOString()
    const tableRows = panelContext.rowCount ?? metadata.tableRows
    const dataLength = toNumber(metadata.dataLength)
    const indexLength = toNumber(metadata.indexLength)
    const totalLength = toNumber(metadata.totalLength)
    const averageRowLength = toNumber(tableRows) && dataLength
      ? dataLength / Number(tableRows)
      : undefined
    const columnDetails = schema.columns.map(column => {
      const typeParts = getTypeParts(column.type)
      return {
        name: column.name,
        type: column.type,
        length: typeParts.length || '--',
        decimals: typeParts.decimals || '--',
        notNull: !column.nullable ? t('common.yes') : t('common.no'),
        primaryKey: column.isPrimaryKey ? t('common.yes') : t('common.no'),
        autoIncrement: column.isAutoIncrement ? t('common.yes') : t('common.no'),
        defaultValue: formatEmpty(column.defaultValue),
        comment: formatEmpty(column.comment),
        position: column.position
      }
    })
    const designColumns = schema.columns.map(column => {
      const typeParts = getTypeParts(column.type)
      return {
        id: `col_${column.position}_${column.name}`,
        originalName: isCreateMode ? undefined : column.name,
        name: column.name,
        type: typeParts.baseType || column.type,
        length: typeParts.length || '',
        decimals: typeParts.decimals || '',
        nullable: column.nullable,
        defaultValue: column.defaultValue || '',
        isPrimaryKey: column.isPrimaryKey,
        isAutoIncrement: column.isAutoIncrement,
        comment: column.comment || '',
        position: column.position
      }
    })
    let designIndexes = schema.indexes.map((index, indexPosition) => ({
      id: `idx_${indexPosition}_${index.name}`,
      originalName: isCreateMode ? undefined : index.name,
      name: index.name,
      columns: [...index.columns],
      isUnique: index.isUnique,
      isPrimary: index.isPrimary,
      type: index.type || ''
    }))
    if (primaryKeys.length > 0 && !designIndexes.some(index => index.isPrimary)) {
      designIndexes = [{
        id: `idx_pk_${schema.name}`,
        originalName: undefined,
        name: `pk_${schema.name || 'table'}`,
        columns: primaryKeys,
        isUnique: true,
        isPrimary: true,
        type: t('table.primaryKey')
      }, ...designIndexes]
    }

    const fieldRowsHtml = schema.columns.map((column, index) => {
      const typeParts = getTypeParts(column.type)
      const keyLabel = column.isPrimaryKey ? `PK ${primaryKeys.indexOf(column.name) + 1}` : ''
      const keyBadge = column.isPrimaryKey ? primaryKeyIconHtml : ''
      return `
        <tr class="field-row ${index === 0 ? 'selected' : ''}" data-column="${escapeAttribute(column.name)}" data-id="${escapeAttribute(designColumns[index].id)}">
          <td class="order-cell">${index + 1}</td>
          <td data-edit="name">${escapeHtml(column.name)}</td>
          <td data-edit="type">${escapeHtml(typeParts.baseType || column.type)}</td>
          <td data-edit="length">${escapeHtml(typeParts.length || '')}</td>
          <td data-edit="decimals">${escapeHtml(typeParts.decimals || '')}</td>
          <td class="check-cell"><input data-edit="notNull" type="checkbox" ${canEdit ? '' : 'disabled'} ${!column.nullable ? 'checked' : ''}></td>
          <td class="check-cell"><input data-edit="autoIncrement" type="checkbox" ${canEdit ? '' : 'disabled'} ${column.isAutoIncrement ? 'checked' : ''}></td>
          <td data-edit="key">${keyBadge}${keyLabel ? `<span class="key-text">${escapeHtml(keyLabel)}</span>` : ''}</td>
          <td data-edit="defaultValue">${escapeHtml(formatEmpty(column.defaultValue))}</td>
          <td data-edit="comment">${escapeHtml(formatEmpty(column.comment))}</td>
        </tr>
      `
    }).join('')

    const indexRowsHtml = designIndexes.map(index => {
      const typeHtml = index.isPrimary
        ? `${primaryKeyIconHtml}<span class="key-text">${escapeHtml(t('table.primaryKey'))}</span>`
        : escapeHtml(index.type || '')
      return `
        <tr class="index-row ${index.name === selectedIndexName ? 'selected' : ''}" data-index="${escapeAttribute(index.name)}" data-id="${escapeAttribute(index.id)}">
          <td data-edit="name">${escapeHtml(index.name)}</td>
          <td data-edit="columns">${escapeHtml(index.columns.join(', '))}</td>
          <td class="check-cell"><input data-edit="isUnique" type="checkbox" ${canEdit && !index.isPrimary ? '' : 'disabled'} ${index.isUnique ? 'checked' : ''}></td>
          <td data-edit="type">${typeHtml}</td>
        </tr>
      `
    }).join('')

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
      renderInfoSection(t('table.performanceInfo'), [
        [t('table.schemaLoadTime'), formatDuration(panelContext.schemaLoadMs)],
        [t('table.loadedAt'), formatDateTime(loadedAt)],
        [t('table.estimatedRows'), tableRows],
        [t('table.averageRowLength'), formatBytes(averageRowLength)],
        [t('table.dataLength'), formatBytes(dataLength)],
        [t('table.indexLength'), formatBytes(indexLength)],
        [t('table.totalLength'), formatBytes(totalLength)],
        [t('table.indexSizeRatio'), formatPercent(indexLength && totalLength ? indexLength / totalLength : undefined)]
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
      --grid-line: var(--vscode-contrastBorder, var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(127, 127, 127, .58))));
      --grid-line-strong: var(--vscode-foreground);
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
    .tool:not([disabled]) {
      cursor: pointer;
    }
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
      border: 1px solid var(--grid-line-strong);
      box-shadow: inset 0 0 0 1px var(--grid-line);
    }
    th, td {
      border: 1px solid var(--grid-line);
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
      border-bottom-color: var(--grid-line-strong);
      font-weight: 600;
    }
    tbody tr:nth-child(even) {
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
    }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody tr.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    tbody tr.selected td {
      border-color: var(--grid-line-strong);
    }
    td.editable {
      cursor: text;
    }
    td.dirty, tr.dirty td {
      background: color-mix(in srgb, var(--vscode-list-highlightForeground) 10%, transparent);
    }
    .cell-editor, .table-name-input, .comment-editor {
      width: 100%;
      min-width: 0;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 2px;
      font: inherit;
      padding: 2px 4px;
    }
    .control-cell {
      padding: 2px 4px;
    }
    .order-cell {
      width: 44px;
      color: var(--vscode-descriptionForeground);
      text-align: right;
    }
    .field-control {
      width: 100%;
      min-width: 0;
      min-height: 25px;
      color: inherit;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 2px;
      font: inherit;
      padding: 2px 4px;
    }
    select.field-control {
      appearance: auto;
    }
    .field-control:hover {
      background: var(--vscode-input-background);
      border-color: var(--vscode-input-border, var(--vscode-panel-border));
    }
    .field-control:focus {
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border-color: var(--vscode-focusBorder);
      outline: none;
    }
    .comment-control {
      min-width: 180px;
    }
    .key-control {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .key-control .field-control {
      flex: 1 1 auto;
    }
    .pk-indicator {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 24px;
      height: 17px;
      padding: 0 4px;
      border-radius: 3px;
      color: var(--vscode-textLink-foreground);
      border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 55%, transparent);
      background: color-mix(in srgb, var(--vscode-textLink-foreground) 12%, transparent);
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
    }
    .key-text {
      margin-left: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
    .table-name-input {
      max-width: 280px;
      font-weight: 600;
    }
    .comment-editor {
      min-height: 120px;
      resize: vertical;
    }
    .comment-label {
      margin: 0 0 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .status {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
      overflow: hidden;
      text-overflow: ellipsis;
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
        <div class="title">${canEdit ? `<input class="table-name-input" id="tableNameInput" value="${escapeAttribute(schema.name)}">` : escapeHtml(schema.name)}</div>
        <div class="subtitle">${escapeHtml(qualifiedName)}</div>
      </div>

      <div class="toolbar" aria-label="Table design actions">
        <button class="tool" id="saveDesignButton" ${canEdit ? 'disabled' : 'disabled'}>${t('common.save')}</button>
        <button class="tool" id="cancelDesignButton" ${canEdit ? '' : 'disabled'}>${t('common.cancel')}</button>
        <button class="tool" id="mockDataButton" ${isCreateMode ? 'disabled' : ''}>${t('table.mockDataAction')}</button>
        <button class="tool" id="addColumnButton" ${canEdit ? '' : 'disabled'}>${t('table.addColumnAction')}</button>
        <button class="tool" id="insertColumnButton" ${canEdit ? '' : 'disabled'}>${t('table.insertColumnAction')}</button>
        <button class="tool" id="dropColumnButton" ${canEdit && schema.columns.length > 0 ? '' : 'disabled'}>${t('table.dropColumnAction')}</button>
        <button class="tool" id="addIndexButton" ${canEdit ? '' : 'disabled'}>${t('table.addIndexAction')}</button>
        <button class="tool" id="dropIndexButton" ${canEdit && designIndexes.length > 0 ? '' : 'disabled'}>${t('table.dropIndexAction')}</button>
        <button class="tool" id="moveUpButton" ${canEdit && schema.columns.length > 1 ? '' : 'disabled'}>${t('table.moveUp')}</button>
        <button class="tool" id="moveDownButton" ${canEdit && schema.columns.length > 1 ? '' : 'disabled'}>${t('table.moveDown')}</button>
        <span class="status" id="designStatus">${isCreateMode ? t('table.unsavedDesign') : t('table.noPendingChanges')}</span>
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
                <th style="width: 44px">#</th>
                <th style="width: 220px">${t('table.columnName')}</th>
                <th style="width: 180px">${t('table.columnType')}</th>
                <th style="width: 80px">${t('table.length')}</th>
                <th style="width: 80px">${t('table.decimals')}</th>
                <th style="width: 90px">${t('table.notNull')}</th>
                <th style="width: 80px">${t('table.auto')}</th>
                <th style="width: 140px">${t('table.key')}</th>
                <th style="width: 160px">${t('table.default')}</th>
                <th>${t('table.comment')}</th>
              </tr>
            </thead>
            <tbody id="fieldsBody">${fieldRowsHtml}</tbody>
          </table>
        </div>

        <div class="tab-panel ${getActiveClass(initialTab, 'indexes')}" id="tab-indexes">
          <table>
            <thead>
              <tr>
                <th>${t('table.indexName')}</th>
                <th>${t('table.columns')}</th>
                <th style="width: 100px">${t('table.unique')}</th>
                <th style="width: 140px">${t('table.type')}</th>
              </tr>
            </thead>
            <tbody id="indexesBody">${indexRowsHtml}</tbody>
          </table>
          <div class="empty" id="noIndexesMessage" ${designIndexes.length > 0 ? 'hidden' : ''}>${t('table.noIndexes')}</div>
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
          <div class="comment-label">${t('table.comment')}</div>
          ${canEdit ? `<textarea class="comment-editor" id="tableCommentInput">${escapeHtml(tableComment)}</textarea>` : `<div class="comment">${escapeHtml(formatEmpty(tableComment))}</div>`}
        </div>
        <div class="tab-panel ${getActiveClass(initialTab, 'sql')}" id="tab-sql">
          <pre class="sql-preview" id="sqlPreview">${escapeHtml(buildCreateTablePreview(profile, scope, { ...schema, comment: tableComment }))}</pre>
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
    const vscode = acquireVsCodeApi();
    const canEdit = ${canEdit ? 'true' : 'false'};
    const isCreateMode = ${isCreateMode ? 'true' : 'false'};
    const driverId = ${escapeScriptJson(JSON.stringify(profile?.driverId || 'postgresql'))};
    const scope = ${escapeScriptJson(JSON.stringify(scope))};
    let draftColumns = ${escapeScriptJson(JSON.stringify(designColumns))};
    let draftIndexes = ${escapeScriptJson(JSON.stringify(designIndexes))};
    const initialTab = ${escapeScriptJson(JSON.stringify(initialTab))};
    const selectedIndexName = ${escapeScriptJson(JSON.stringify(selectedIndexName || null))};
    const labels = ${escapeScriptJson(JSON.stringify({
      yes: t('common.yes'),
      no: t('common.no'),
      noPending: t('table.noPendingChanges'),
      pendingDesign: t('table.pendingDesignChanges'),
      unsavedDesign: t('table.unsavedDesign'),
      noIndexes: t('table.noIndexes'),
      primaryKey: t('table.primaryKey'),
      tableNameRequired: t('table.tableNameRequired'),
      columnNameRequired: t('table.columnNameRequired'),
      columnTypeRequired: t('table.columnTypeRequired'),
      duplicateColumnName: t('table.duplicateColumnName'),
      indexNameRequired: t('table.indexNameRequired'),
      indexColumnRequired: t('table.indexColumnRequired'),
      indexColumnUnknown: t('table.indexColumnUnknown')
    }))};
    let selectedColumnId = draftColumns[0] ? draftColumns[0].id : null;
    let selectedIndexId = null;
    let dirty = isCreateMode;
    let rowIdSeed = Date.now();
    const typeHints = getTypeHints(driverId);

    function activateTab(tabName) {
      const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
      const panel = document.getElementById('tab-' + tabName);
      if (!tab || !panel) return;

      document.querySelectorAll('.tab').forEach(item => item.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(item => item.classList.remove('active'));
      tab.classList.add('active');
      panel.classList.add('active');
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function escapeAttribute(value) {
      return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), 'g'), '&#096;');
    }

    function formatEmpty(value) {
      return value === null || value === undefined || value === '' ? '--' : String(value);
    }

    function nextId(prefix) {
      rowIdSeed += 1;
      return prefix + '_' + rowIdSeed;
    }

    function normalizeName(value) {
      return String(value || '').trim();
    }

    function getTypeHints(driver) {
      const postgresTypes = [
        'BIGSERIAL', 'SERIAL', 'SMALLSERIAL',
        'BIGINT', 'INTEGER', 'SMALLINT',
        'VARCHAR', 'VARCHAR(255)', 'CHAR', 'TEXT',
        'BOOLEAN', 'NUMERIC', 'NUMERIC(10, 2)', 'DECIMAL', 'REAL', 'DOUBLE PRECISION',
        'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL',
        'UUID', 'JSONB', 'JSON', 'BYTEA',
        'INET', 'CIDR', 'MACADDR'
      ];
      const mysqlTypes = [
        'BIGINT', 'INT', 'MEDIUMINT', 'SMALLINT', 'TINYINT',
        'VARCHAR', 'VARCHAR(255)', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
        'DECIMAL', 'DECIMAL(10, 2)', 'DOUBLE', 'FLOAT',
        'DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR',
        'BOOLEAN', 'JSON', 'BLOB', 'LONGBLOB',
        'ENUM', 'SET'
      ];
      const hints = {
        postgresql: postgresTypes,
        cockroachdb: [...postgresTypes, 'STRING', 'BYTES'],
        mysql: mysqlTypes,
        mariadb: mysqlTypes,
        sqlite: [
          'INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC',
          'BOOLEAN', 'DATE', 'DATETIME'
        ],
        sqlserver: [
          'BIGINT', 'INT', 'SMALLINT', 'TINYINT', 'BIT',
          'NVARCHAR', 'NVARCHAR(255)', 'VARCHAR', 'VARCHAR(255)', 'NCHAR', 'CHAR',
          'TEXT', 'NTEXT',
          'DECIMAL', 'DECIMAL(10, 2)', 'NUMERIC', 'MONEY', 'SMALLMONEY',
          'FLOAT', 'REAL',
          'DATE', 'TIME', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET',
          'UNIQUEIDENTIFIER', 'XML', 'VARBINARY', 'VARBINARY(MAX)', 'IMAGE'
        ],
        oracle: [
          'NUMBER', 'NUMBER(10)', 'NUMBER(10, 2)', 'INTEGER', 'BINARY_FLOAT', 'BINARY_DOUBLE',
          'VARCHAR2', 'VARCHAR2(255)', 'NVARCHAR2', 'NVARCHAR2(255)', 'CHAR', 'NCHAR',
          'CLOB', 'NCLOB', 'BLOB', 'RAW', 'RAW(16)',
          'DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'INTERVAL DAY TO SECOND',
          'JSON'
        ],
        duckdb: [
          'BIGINT', 'INTEGER', 'SMALLINT', 'TINYINT', 'UBIGINT', 'UINTEGER',
          'VARCHAR', 'VARCHAR(255)', 'TEXT',
          'BOOLEAN', 'DECIMAL', 'DECIMAL(10, 2)', 'DOUBLE', 'REAL', 'FLOAT',
          'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL',
          'UUID', 'JSON', 'BLOB', 'LIST', 'STRUCT', 'MAP'
        ],
        snowflake: [
          'NUMBER', 'NUMBER(10, 2)', 'DECIMAL', 'NUMERIC', 'INT', 'INTEGER', 'BIGINT',
          'FLOAT', 'DOUBLE', 'REAL',
          'VARCHAR', 'VARCHAR(255)', 'STRING', 'TEXT', 'CHAR',
          'BOOLEAN',
          'DATE', 'TIME', 'TIMESTAMP_NTZ', 'TIMESTAMP_LTZ', 'TIMESTAMP_TZ',
          'VARIANT', 'OBJECT', 'ARRAY', 'BINARY'
        ],
        bigquery: [
          'INT64', 'NUMERIC', 'NUMERIC(10, 2)', 'BIGNUMERIC', 'FLOAT64',
          'STRING', 'BOOL', 'BOOLEAN',
          'DATE', 'TIME', 'DATETIME', 'TIMESTAMP',
          'BYTES', 'JSON', 'GEOGRAPHY',
          'ARRAY<STRING>', 'ARRAY<INT64>', 'STRUCT'
        ],
        databricks: [
          'BIGINT', 'INT', 'SMALLINT', 'TINYINT',
          'STRING', 'VARCHAR', 'VARCHAR(255)', 'CHAR',
          'BOOLEAN', 'DECIMAL', 'DECIMAL(10, 2)', 'DOUBLE', 'FLOAT',
          'DATE', 'TIMESTAMP', 'TIMESTAMP_NTZ',
          'BINARY', 'ARRAY<STRING>', 'MAP<STRING, STRING>', 'STRUCT', 'VARIANT'
        ],
        clickhouse: [
          'Int8', 'Int16', 'Int32', 'Int64', 'UInt8', 'UInt16', 'UInt32', 'UInt64',
          'String', 'FixedString', 'FixedString(32)',
          'Bool', 'Decimal', 'Decimal(10, 2)', 'Float32', 'Float64',
          'Date', 'Date32', 'DateTime', 'DateTime64', 'DateTime64(3)',
          'UUID', 'Array(String)', 'Nullable(String)', 'LowCardinality(String)', 'JSON'
        ],
        cassandra: [
          'ascii', 'text', 'varchar',
          'bigint', 'int', 'smallint', 'tinyint', 'varint',
          'boolean', 'decimal', 'double', 'float',
          'date', 'time', 'timestamp', 'duration',
          'uuid', 'timeuuid', 'inet', 'blob',
          'list<text>', 'set<text>', 'map<text, text>'
        ]
      };
      return hints[driver] || ['BIGINT', 'INTEGER', 'VARCHAR', 'VARCHAR(255)', 'TEXT', 'BOOLEAN', 'DECIMAL', 'DECIMAL(10, 2)', 'DATE', 'TIME', 'TIMESTAMP', 'JSON', 'BLOB'];
    }

    function ensureTypeHintList() {
      if (document.getElementById('columnTypeHints')) return;
      const list = document.createElement('datalist');
      list.id = 'columnTypeHints';
      list.innerHTML = typeHints.map(type => '<option value="' + escapeAttribute(type) + '"></option>').join('');
      document.body.appendChild(list);
    }

    function parseTypeInput(value) {
      const text = normalizeName(value);
      const match = text.match(/^(.+?)\\s*\\(([^)]*)\\)$/);
      if (!match) {
        return { type: text, length: undefined, decimals: undefined };
      }

      const parts = match[2].split(',').map(part => part.trim());
      return {
        type: match[1].trim(),
        length: parts[0] || '',
        decimals: parts[1] || ''
      };
    }

    function getTypeDefaults(type) {
      const normalized = String(type || '').toLowerCase().replace(/\\s+/g, ' ');
      if (/^(varchar|nvarchar|varchar2|nvarchar2|character varying)$/.test(normalized)) {
        return { length: '255', decimals: '' };
      }
      if (/^(char|nchar|character|fixedstring|raw|varbinary|binary)$/.test(normalized)) {
        return { length: normalized === 'fixedstring' ? '32' : '1', decimals: '' };
      }
      if (/^(decimal|numeric|number|bignumeric)$/.test(normalized)) {
        return { length: '10', decimals: '2' };
      }
      if (/^(datetime64|timestamp_ntz|timestamp_ltz|timestamp_tz|datetime2)$/.test(normalized)) {
        return { length: '3', decimals: '' };
      }
      if (/^(tinyint)$/.test(normalized)) {
        return { length: '1', decimals: '' };
      }
      return { length: '', decimals: '' };
    }

    function getUniqueValues(values) {
      const seen = new Set();
      return values.filter(value => {
        const text = normalizeName(value);
        const key = text.toLowerCase();
        if (!text || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    function renderSelectOption(value, selectedValue) {
      const selected = String(value).toLowerCase() === String(selectedValue).toLowerCase() ? ' selected' : '';
      return '<option value="' + escapeAttribute(value) + '"' + selected + '>' + escapeHtml(value) + '</option>';
    }

    function renderTypeOptions(column) {
      const current = composeType(column);
      return getUniqueValues([current, ...typeHints])
        .map(type => renderSelectOption(type, current))
        .join('');
    }

    function applyTypeInput(column, value) {
      const parsed = parseTypeInput(value);
      const defaults = getTypeDefaults(parsed.type);
      column.type = parsed.type;
      column.length = parsed.length === undefined ? defaults.length : parsed.length;
      column.decimals = parsed.decimals === undefined ? defaults.decimals : parsed.decimals;
    }

    function composeType(column) {
      const baseType = normalizeName(column.type) || 'varchar';
      const length = normalizeName(column.length);
      const decimals = normalizeName(column.decimals);
      if (length && decimals) {
        return baseType + '(' + length + ', ' + decimals + ')';
      }
      if (length) {
        return baseType + '(' + length + ')';
      }
      return baseType;
    }

    function sqlString(value) {
      return "'" + String(value).replace(/'/g, "''") + "'";
    }

    function quoteIdentifier(identifier) {
      const text = String(identifier);
      if (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'clickhouse') {
        const tick = String.fromCharCode(96);
        return tick + text.replace(new RegExp(tick, 'g'), tick + tick) + tick;
      }
      return '"' + text.replace(/"/g, '""') + '"';
    }

    function getQualifiedName(tableName) {
      const parts = [];
      if (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'clickhouse') {
        if (scope.database) parts.push(scope.database);
      } else if (driverId === 'postgresql' || driverId === 'cockroachdb' || driverId === 'duckdb') {
        if (scope.schema) parts.push(scope.schema);
      } else if (driverId !== 'sqlite') {
        if (scope.schema) parts.push(scope.schema);
        else if (scope.database) parts.push(scope.database);
      }
      parts.push(tableName);
      return parts.map(quoteIdentifier).join('.');
    }

    function getTableName() {
      const input = document.getElementById('tableNameInput');
      return normalizeName(input ? input.value : ${escapeScriptJson(JSON.stringify(schema.name))});
    }

    function getTableComment() {
      const input = document.getElementById('tableCommentInput');
      return input ? input.value : ${escapeScriptJson(JSON.stringify(tableComment))};
    }

    function getActiveTab() {
      return document.querySelector('.tab.active')?.dataset.tab || initialTab;
    }

    function primaryKeyIconHtml() {
      return '<span class="pk-indicator" title="' + escapeAttribute(labels.primaryKey) + '">&#128273;</span>';
    }

    function primaryIndexTypeHtml() {
      return primaryKeyIconHtml() + '<span class="key-text">' + escapeHtml(labels.primaryKey) + '</span>';
    }

    function primaryColumnNames() {
      return draftColumns
        .filter(column => column.isPrimaryKey)
        .map(column => column.name)
        .filter(Boolean);
    }

    function generatedPrimaryIndexName() {
      const normalized = normalizeName(getTableName()).replace(/[^A-Za-z0-9_$]+/g, '_').replace(/^_+|_+$/g, '');
      return 'pk_' + (normalized || 'table');
    }

    function syncPrimaryIndexFromColumns(selectCreatedIndex) {
      const columns = primaryColumnNames();
      const primaryIndexes = draftIndexes.filter(index => index.isPrimary);
      const primaryIndex = primaryIndexes[0];

      if (columns.length === 0) {
        if (primaryIndexes.length > 0) {
          draftIndexes = draftIndexes.filter(index => !index.isPrimary);
          if (primaryIndexes.some(index => index.id === selectedIndexId)) {
            selectedIndexId = draftIndexes[0]?.id || null;
          }
        }
        return;
      }

      if (primaryIndex) {
        draftIndexes = draftIndexes.filter(index => !index.isPrimary || index.id === primaryIndex.id);
        primaryIndex.name = primaryIndex.name || generatedPrimaryIndexName();
        primaryIndex.columns = columns;
        primaryIndex.isUnique = true;
        primaryIndex.isPrimary = true;
        primaryIndex.type = labels.primaryKey;
        if (primaryIndexes.some(index => index.id === selectedIndexId && index.id !== primaryIndex.id)) {
          selectedIndexId = primaryIndex.id;
        }
        return;
      }

      const index = {
        id: nextId('idx'),
        name: generatedPrimaryIndexName(),
        columns,
        isUnique: true,
        isPrimary: true,
        type: labels.primaryKey
      };
      draftIndexes.unshift(index);
      if (selectCreatedIndex) {
        selectedIndexId = index.id;
      }
    }

    function getColumnInfo(column) {
      return {
        name: column.name,
        type: composeType(column),
        length: column.length || '--',
        decimals: column.decimals || '--',
        notNull: !column.nullable ? labels.yes : labels.no,
        primaryKey: column.isPrimaryKey ? labels.yes : labels.no,
        autoIncrement: column.isAutoIncrement ? labels.yes : labels.no,
        defaultValue: formatEmpty(column.defaultValue),
        comment: formatEmpty(column.comment)
      };
    }

    function updateColumnInfo(columnId) {
      const detail = getColumnInfo(draftColumns.find(item => item.id === columnId) || draftColumns[0]);
      if (!detail) return;

      document.querySelectorAll('#columnInfo [data-field]').forEach(item => {
        const field = item.dataset.field;
        item.textContent = detail[field] || '--';
      });
    }

    function updateToolbarState() {
      const saveButton = document.getElementById('saveDesignButton');
      if (saveButton) {
        saveButton.disabled = !canEdit || !dirty;
      }
      const status = document.getElementById('designStatus');
      if (status) {
        status.textContent = dirty ? (isCreateMode ? labels.unsavedDesign : labels.pendingDesign) : labels.noPending;
      }
      const dropColumnButton = document.getElementById('dropColumnButton');
      if (dropColumnButton) {
        dropColumnButton.disabled = !canEdit || draftColumns.length === 0 || !selectedColumnId;
      }
      const moveUpButton = document.getElementById('moveUpButton');
      const moveDownButton = document.getElementById('moveDownButton');
      const columnIndex = draftColumns.findIndex(item => item.id === selectedColumnId);
      if (moveUpButton) {
        moveUpButton.disabled = !canEdit || columnIndex <= 0;
      }
      if (moveDownButton) {
        moveDownButton.disabled = !canEdit || columnIndex < 0 || columnIndex >= draftColumns.length - 1;
      }
      const dropIndexButton = document.getElementById('dropIndexButton');
      if (dropIndexButton) {
        const selectedIndex = draftIndexes.find(index => index.id === selectedIndexId);
        dropIndexButton.disabled = !canEdit || draftIndexes.length === 0 || !selectedIndex;
      }
    }

    function markDirty() {
      if (!canEdit) return;
      dirty = true;
      updateToolbarState();
      updateSqlPreview();
    }

    function renderFields() {
      const body = document.getElementById('fieldsBody');
      if (!body) return;
      body.innerHTML = draftColumns.map((column, index) => {
        const selected = column.id === selectedColumnId ? 'selected' : '';
        const dirtyClass = column.originalName ? '' : 'dirty';
        const keyBadge = column.isPrimaryKey ? primaryKeyIconHtml() : '';
        return [
          '<tr class="field-row ' + selected + ' ' + dirtyClass + '" data-column="' + escapeAttribute(column.name) + '" data-id="' + escapeAttribute(column.id) + '">',
          '<td class="order-cell">' + (index + 1) + '</td>',
          '<td class="control-cell"><input class="field-control" data-edit="name" value="' + escapeAttribute(column.name) + '" ' + (canEdit ? '' : 'disabled') + '></td>',
          '<td class="control-cell"><select class="field-control type-control" data-edit="type" ' + (canEdit ? '' : 'disabled') + '>' + renderTypeOptions(column) + '</select></td>',
          '<td class="control-cell"><input class="field-control" data-edit="length" value="' + escapeAttribute(column.length || '') + '" ' + (canEdit ? '' : 'disabled') + '></td>',
          '<td class="control-cell"><input class="field-control" data-edit="decimals" value="' + escapeAttribute(column.decimals || '') + '" ' + (canEdit ? '' : 'disabled') + '></td>',
          '<td class="check-cell"><input data-edit="notNull" type="checkbox" ' + (canEdit ? '' : 'disabled') + (!column.nullable ? ' checked' : '') + '></td>',
          '<td class="check-cell"><input data-edit="autoIncrement" type="checkbox" ' + (canEdit ? '' : 'disabled') + (column.isAutoIncrement ? ' checked' : '') + '></td>',
          '<td class="control-cell"><div class="key-control">' + keyBadge + '<select class="field-control" data-edit="key" ' + (canEdit ? '' : 'disabled') + '><option value=""></option><option value="primary"' + (column.isPrimaryKey ? ' selected' : '') + '>' + escapeHtml(labels.primaryKey) + '</option></select></div></td>',
          '<td class="control-cell"><input class="field-control" data-edit="defaultValue" value="' + escapeAttribute(column.defaultValue || '') + '" ' + (canEdit ? '' : 'disabled') + '></td>',
          '<td class="control-cell"><input class="field-control comment-control" data-edit="comment" value="' + escapeAttribute(column.comment || '') + '" ' + (canEdit ? '' : 'disabled') + '></td>',
          '</tr>'
        ].join('');
      }).join('');
      bindFieldRows();
      updateColumnInfo(selectedColumnId);
      updateToolbarState();
    }

    function renderIndexes() {
      const body = document.getElementById('indexesBody');
      if (!body) return;
      body.innerHTML = draftIndexes.map(index => {
        const selected = index.id === selectedIndexId ? 'selected' : '';
        const dirtyClass = index.originalName ? '' : 'dirty';
        const typeHtml = index.isPrimary ? primaryIndexTypeHtml() : escapeHtml(index.type || '');
        return [
          '<tr class="index-row ' + selected + ' ' + dirtyClass + '" data-index="' + escapeAttribute(index.name) + '" data-id="' + escapeAttribute(index.id) + '">',
          '<td class="' + (canEdit && !index.isPrimary ? 'editable' : '') + '" data-edit="name">' + escapeHtml(index.name) + '</td>',
          '<td class="' + (canEdit && !index.isPrimary ? 'editable' : '') + '" data-edit="columns">' + escapeHtml(index.columns.join(', ')) + '</td>',
          '<td class="check-cell"><input data-edit="isUnique" type="checkbox" ' + (canEdit && !index.isPrimary ? '' : 'disabled') + (index.isUnique ? ' checked' : '') + '></td>',
          '<td class="' + (canEdit && !index.isPrimary ? 'editable' : '') + '" data-edit="type">' + typeHtml + '</td>',
          '</tr>'
        ].join('');
      }).join('');
      const noIndexesMessage = document.getElementById('noIndexesMessage');
      if (noIndexesMessage) {
        noIndexesMessage.hidden = draftIndexes.length > 0;
      }
      bindIndexRows();
      updateToolbarState();
    }

    function selectFieldRow(row) {
      document.querySelectorAll('.field-row').forEach(item => item.classList.remove('selected'));
      row.classList.add('selected');
      selectedColumnId = row.dataset.id;
      updateColumnInfo(selectedColumnId);
      updateToolbarState();
    }

    function updateColumnNameReferences(previousName, nextName) {
      if (previousName === nextName) return;
      draftIndexes = draftIndexes.map(index => ({
        ...index,
        columns: index.columns.map(item => item === previousName ? nextName : item)
      }));
    }

    function updateColumnFromControl(column, field, control) {
      if (field === 'notNull') {
        column.nullable = !control.checked;
      } else if (field === 'autoIncrement') {
        column.isAutoIncrement = control.checked;
      } else if (field === 'key') {
        column.isPrimaryKey = control.value === 'primary';
        if (column.isPrimaryKey) column.nullable = false;
        syncPrimaryIndexFromColumns(false);
      } else if (field === 'type') {
        applyTypeInput(column, control.value);
      } else if (field === 'name') {
        const previousName = column.name;
        column.name = control.value;
        updateColumnNameReferences(previousName, column.name);
        syncPrimaryIndexFromColumns(false);
      } else if (field === 'length' || field === 'decimals' || field === 'defaultValue' || field === 'comment') {
        column[field] = control.value;
      }
    }

    function bindFieldRows() {
      document.querySelectorAll('.field-row').forEach(row => {
        row.addEventListener('click', () => {
          selectFieldRow(row);
        });
        row.querySelectorAll('[data-edit]').forEach(control => {
          control.addEventListener('focus', () => selectFieldRow(row));
          const eventName = control.matches('input[type="text"], input:not([type]), input[type="search"]') ? 'input' : 'change';
          control.addEventListener(eventName, () => {
            const column = draftColumns.find(item => item.id === row.dataset.id);
            if (!column) return;
            const field = control.dataset.edit;
            updateColumnFromControl(column, field, control);
            markDirty();
            updateColumnInfo(column.id);
            if (field === 'type' || field === 'key') {
              renderFields();
              renderIndexes();
            }
          });
          if (control.dataset.edit === 'length' || control.dataset.edit === 'decimals') {
            control.addEventListener('blur', () => renderFields());
          }
          if (control.dataset.edit === 'name') {
            control.addEventListener('blur', () => {
              const column = draftColumns.find(item => item.id === row.dataset.id);
              if (column) {
                const previousName = column.name;
                column.name = normalizeName(column.name);
                updateColumnNameReferences(previousName, column.name);
                syncPrimaryIndexFromColumns(false);
              }
              renderFields();
              renderIndexes();
            });
          }
          if (control.dataset.edit === 'comment' || control.dataset.edit === 'defaultValue') {
            control.addEventListener('blur', () => renderFields());
          }
        });
      });
    }

    function bindIndexRows() {
      document.querySelectorAll('.index-row').forEach(row => {
        row.addEventListener('click', () => {
          document.querySelectorAll('.index-row').forEach(item => item.classList.remove('selected'));
          row.classList.add('selected');
          selectedIndexId = row.dataset.id;
          updateToolbarState();
        });
        row.querySelectorAll('td[data-edit]').forEach(cell => {
          cell.addEventListener('dblclick', event => {
            event.stopPropagation();
            startIndexEditor(row.dataset.id, cell);
          });
        });
        row.querySelector('input[data-edit="isUnique"]')?.addEventListener('change', event => {
          const index = draftIndexes.find(item => item.id === row.dataset.id);
          if (!index || index.isPrimary) return;
          index.isUnique = event.target.checked;
          markDirty();
        });
      });
    }

    function startFieldEditor(columnId, cell) {
      if (!canEdit || cell.querySelector('input, select')) return;
      const column = draftColumns.find(item => item.id === columnId);
      if (!column) return;
      const field = cell.dataset.edit;
      const originalHtml = cell.innerHTML;
      const editor = field === 'key' ? document.createElement('select') : document.createElement('input');
      editor.className = 'cell-editor';
      if (field === 'key') {
        editor.innerHTML = '<option value=""></option><option value="primary">' + escapeHtml(labels.primaryKey) + '</option>';
        editor.value = column.isPrimaryKey ? 'primary' : '';
      } else if (field === 'type') {
        ensureTypeHintList();
        editor.setAttribute('list', 'columnTypeHints');
        editor.setAttribute('autocomplete', 'off');
        editor.placeholder = typeHints.slice(0, 6).join(', ');
        editor.value = column.type || '';
      } else {
        editor.value = field === 'defaultValue' || field === 'comment'
          ? (column[field] || '')
          : (column[field] || '');
      }
      cell.innerHTML = '';
      cell.appendChild(editor);
      editor.focus();
      if (editor.select) editor.select();

      let finished = false;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        if (commit) {
          if (field === 'key') {
            column.isPrimaryKey = editor.value === 'primary';
            if (column.isPrimaryKey) column.nullable = false;
            syncPrimaryIndexFromColumns(false);
          } else if (field === 'name' || field === 'type' || field === 'length' || field === 'decimals' || field === 'defaultValue' || field === 'comment') {
            const previousName = column.name;
            if (field === 'type') {
              applyTypeInput(column, editor.value);
            } else {
              column[field] = editor.value.trim();
            }
            if (field === 'name' && previousName !== column.name) {
              updateColumnNameReferences(previousName, column.name);
              syncPrimaryIndexFromColumns(false);
            }
          }
          markDirty();
          renderFields();
          renderIndexes();
          return;
        }
        cell.innerHTML = originalHtml;
      };

      editor.addEventListener('keydown', event => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      });
      editor.addEventListener('blur', () => finish(true));
    }

    function startIndexEditor(indexId, cell) {
      if (!canEdit || cell.querySelector('input')) return;
      const index = draftIndexes.find(item => item.id === indexId);
      if (!index || index.isPrimary) return;
      const field = cell.dataset.edit;
      const originalHtml = cell.innerHTML;
      const editor = document.createElement('input');
      editor.className = 'cell-editor';
      editor.value = field === 'columns' ? index.columns.join(', ') : (index[field] || '');
      cell.innerHTML = '';
      cell.appendChild(editor);
      editor.focus();
      editor.select();

      let finished = false;
      const finish = (commit) => {
        if (finished) return;
        finished = true;
        if (commit) {
          if (field === 'columns') {
            index.columns = editor.value.split(',').map(item => item.trim()).filter(Boolean);
          } else {
            index[field] = editor.value.trim();
          }
          markDirty();
          renderIndexes();
          return;
        }
        cell.innerHTML = originalHtml;
      };

      editor.addEventListener('keydown', event => {
        if (event.key === 'Enter') finish(true);
        if (event.key === 'Escape') finish(false);
      });
      editor.addEventListener('blur', () => finish(true));
    }

    function nextColumnName() {
      const used = new Set(draftColumns.map(column => column.name));
      let index = 1;
      let name = 'new_field';
      while (used.has(name)) {
        name = 'new_field_' + index;
        index += 1;
      }
      return name;
    }

    function addColumn(beforeSelected) {
      if (!canEdit) return;
      const column = {
        id: nextId('col'),
        name: nextColumnName(),
        type: driverId === 'postgresql' || driverId === 'cockroachdb' ? 'varchar' : 'varchar',
        length: '255',
        decimals: '',
        nullable: true,
        defaultValue: '',
        isPrimaryKey: false,
        isAutoIncrement: false,
        comment: '',
        position: draftColumns.length + 1
      };
      let insertAt = beforeSelected ? draftColumns.findIndex(item => item.id === selectedColumnId) : draftColumns.findIndex(item => item.id === selectedColumnId) + 1;
      if (insertAt < 0) insertAt = draftColumns.length;
      draftColumns.splice(insertAt, 0, column);
      selectedColumnId = column.id;
      markDirty();
      renderFields();
    }

    function dropSelectedColumn() {
      if (!canEdit || !selectedColumnId) return;
      const index = draftColumns.findIndex(item => item.id === selectedColumnId);
      if (index < 0) return;
      const removed = draftColumns[index];
      draftColumns.splice(index, 1);
      draftIndexes = draftIndexes
        .map(item => ({ ...item, columns: item.columns.filter(column => column !== removed.name) }))
        .filter(item => item.columns.length > 0);
      syncPrimaryIndexFromColumns(false);
      selectedColumnId = draftColumns[Math.min(index, draftColumns.length - 1)]?.id || null;
      markDirty();
      renderFields();
      renderIndexes();
    }

    function moveSelectedColumn(delta) {
      const index = draftColumns.findIndex(item => item.id === selectedColumnId);
      const nextIndex = index + delta;
      if (index < 0 || nextIndex < 0 || nextIndex >= draftColumns.length) return;
      const [column] = draftColumns.splice(index, 1);
      draftColumns.splice(nextIndex, 0, column);
      syncPrimaryIndexFromColumns(false);
      renderFields();
      const selectedRow = Array.from(document.querySelectorAll('.field-row')).find(row => row.dataset.id === selectedColumnId);
      if (selectedRow) selectedRow.scrollIntoView({ block: 'nearest' });
      markDirty();
    }

    function nextIndexName(columns) {
      const tableName = getTableName() || 'table';
      const suffix = columns.length > 0 ? columns.join('_') : 'idx';
      const used = new Set(draftIndexes.map(index => index.name));
      let name = 'idx_' + tableName + '_' + suffix;
      let counter = 1;
      while (used.has(name)) {
        name = 'idx_' + tableName + '_' + suffix + '_' + counter;
        counter += 1;
      }
      return name;
    }

    function addIndex() {
      if (!canEdit || draftColumns.length === 0) return;
      activateTab('indexes');
      const columns = [draftColumns.find(column => !column.isPrimaryKey)?.name || draftColumns[0].name];
      const index = {
        id: nextId('idx'),
        name: nextIndexName(columns),
        columns,
        isUnique: false,
        isPrimary: false,
        type: ''
      };
      draftIndexes.push(index);
      selectedIndexId = index.id;
      markDirty();
      renderIndexes();
    }

    function dropSelectedIndex() {
      const index = draftIndexes.findIndex(item => item.id === selectedIndexId);
      if (index < 0) return;
      const removed = draftIndexes[index];
      if (removed.isPrimary) {
        draftColumns.forEach(column => {
          column.isPrimaryKey = false;
        });
      }
      draftIndexes.splice(index, 1);
      selectedIndexId = draftIndexes[Math.min(index, draftIndexes.length - 1)]?.id || null;
      markDirty();
      renderFields();
      renderIndexes();
    }

    function updateSqlPreview() {
      const preview = document.getElementById('sqlPreview');
      if (!preview) return;
      const tableName = getTableName() || 'new_table';
      const columnLines = draftColumns.map(column => {
        const parts = ['  ' + quoteIdentifier(column.name), composeType(column)];
        if (!column.nullable || column.isPrimaryKey) parts.push('NOT NULL');
        if (column.defaultValue) parts.push('DEFAULT ' + column.defaultValue);
        if (column.isAutoIncrement && (driverId === 'mysql' || driverId === 'mariadb')) parts.push('AUTO_INCREMENT');
        if (column.comment && (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'clickhouse')) parts.push('COMMENT ' + sqlString(column.comment));
        return parts.join(' ');
      });
      const primaryKeys = draftColumns.filter(column => column.isPrimaryKey).map(column => quoteIdentifier(column.name));
      if (primaryKeys.length > 0) {
        columnLines.push('  PRIMARY KEY (' + primaryKeys.join(', ') + ')');
      }
      const indexLines = draftIndexes
        .filter(index => !index.isPrimary && index.name && index.columns.length > 0)
        .map(index => 'CREATE ' + (index.isUnique ? 'UNIQUE ' : '') + 'INDEX ' + quoteIdentifier(index.name) + ' ON ' + getQualifiedName(tableName) + ' (' + index.columns.map(quoteIdentifier).join(', ') + ');');
      const commentLines = [];
      if (driverId === 'postgresql' || driverId === 'cockroachdb' || driverId === 'duckdb') {
        if (getTableComment()) {
          commentLines.push('COMMENT ON TABLE ' + getQualifiedName(tableName) + ' IS ' + sqlString(getTableComment()) + ';');
        }
        draftColumns.forEach(column => {
          if (column.comment) {
            commentLines.push('COMMENT ON COLUMN ' + getQualifiedName(tableName) + '.' + quoteIdentifier(column.name) + ' IS ' + sqlString(column.comment) + ';');
          }
        });
      } else if ((driverId === 'mysql' || driverId === 'mariadb') && getTableComment()) {
        commentLines.push('ALTER TABLE ' + getQualifiedName(tableName) + ' COMMENT = ' + sqlString(getTableComment()) + ';');
      } else if (driverId === 'clickhouse' && getTableComment()) {
        commentLines.push('ALTER TABLE ' + getQualifiedName(tableName) + ' MODIFY COMMENT ' + sqlString(getTableComment()) + ';');
      }
      preview.textContent = [
        'CREATE TABLE ' + getQualifiedName(tableName) + ' (',
        columnLines.join(',\\n') || '  -- add fields',
        ');',
        ...commentLines,
        ...indexLines,
        ''
      ].join('\\n');
    }

    function validateDraft() {
      const tableName = getTableName();
      if (!tableName) return labels.tableNameRequired;
      if (draftColumns.length === 0) return labels.columnNameRequired;
      const seenColumns = new Set();
      const columnNames = new Set();
      for (const column of draftColumns) {
        column.name = normalizeName(column.name);
        column.type = normalizeName(column.type);
        if (!column.name) return labels.columnNameRequired;
        if (!column.type) return labels.columnTypeRequired;
        const key = column.name.toLowerCase();
        if (seenColumns.has(key)) return labels.duplicateColumnName.replace('{0}', column.name);
        seenColumns.add(key);
        columnNames.add(column.name);
      }
      for (const index of draftIndexes) {
        if (index.isPrimary) continue;
        index.name = normalizeName(index.name);
        if (!index.name) return labels.indexNameRequired;
        if (index.columns.length === 0) return labels.indexColumnRequired;
        const missing = index.columns.find(column => !columnNames.has(column));
        if (missing) return labels.indexColumnUnknown.replace('{0}', missing);
      }
      return '';
    }

    function saveDesign() {
      if (!canEdit) return;
      const validationMessage = validateDraft();
      if (validationMessage) {
        alert(validationMessage);
        return;
      }
      syncPrimaryIndexFromColumns(false);
      const draft = {
        tableName: getTableName(),
        comment: getTableComment(),
        columns: draftColumns.map((column, index) => ({
          ...column,
          type: normalizeName(column.type),
          length: normalizeName(column.length),
          decimals: normalizeName(column.decimals),
          defaultValue: column.defaultValue || '',
          comment: column.comment || '',
          position: index + 1
        })),
        indexes: draftIndexes
          .filter(index => index.isPrimary || (index.name && index.columns.length > 0))
          .map(index => ({ ...index }))
      };
      vscode.postMessage({ type: 'saveDesign', activeTab: getActiveTab(), draft });
    }

    function cancelDesign() {
      if (!canEdit) return;
      vscode.postMessage({ type: 'reloadSchema', activeTab: getActiveTab() });
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activateTab(tab.dataset.tab);
      });
    });

    document.getElementById('mockDataButton')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'generateMockData' });
    });
    document.getElementById('addColumnButton')?.addEventListener('click', () => {
      addColumn(false);
    });
    document.getElementById('insertColumnButton')?.addEventListener('click', () => {
      addColumn(true);
    });
    document.getElementById('dropColumnButton')?.addEventListener('click', () => {
      dropSelectedColumn();
    });
    document.getElementById('moveUpButton')?.addEventListener('click', () => moveSelectedColumn(-1));
    document.getElementById('moveDownButton')?.addEventListener('click', () => moveSelectedColumn(1));
    document.getElementById('addIndexButton')?.addEventListener('click', addIndex);
    document.getElementById('dropIndexButton')?.addEventListener('click', dropSelectedIndex);
    document.getElementById('saveDesignButton')?.addEventListener('click', saveDesign);
    document.getElementById('cancelDesignButton')?.addEventListener('click', cancelDesign);
    document.getElementById('tableNameInput')?.addEventListener('input', () => {
      const sideTitle = document.querySelector('.side-title');
      if (sideTitle) sideTitle.textContent = getTableName();
      markDirty();
    });
    document.getElementById('tableCommentInput')?.addEventListener('input', markDirty);

    if (selectedIndexName) {
      const selectedIndex = draftIndexes.find(index => index.name === selectedIndexName);
      selectedIndexId = selectedIndex ? selectedIndex.id : null;
    }

    renderFields();
    renderIndexes();
    updateSqlPreview();
    updateToolbarState();

    if (selectedIndexId) {
      const selectedIndexRow = Array.from(document.querySelectorAll('.index-row'))
        .find(row => row.dataset.id === selectedIndexId);
      if (selectedIndexRow) {
        selectedIndexRow.scrollIntoView({ block: 'center' });
      }
    }

    if (isCreateMode) {
      const input = document.getElementById('tableNameInput');
      if (input) {
        input.focus();
        input.select();
      }
    }

    activateTab(initialTab);
  </script>
</body>
</html>`
  }
}

function getActiveClass(activeTab: TableSchemaTab, tab: TableSchemaTab): string {
  return activeTab === tab ? 'active' : ''
}

function isTableSchemaTab(value: unknown): value is TableSchemaTab {
  return value === 'fields'
    || value === 'indexes'
    || value === 'foreignKeys'
    || value === 'checks'
    || value === 'triggers'
    || value === 'options'
    || value === 'comment'
    || value === 'sql'
}

function isTableDesignDraft(value: unknown): value is TableDesignDraft {
  if (!value || typeof value !== 'object') {
    return false
  }

  const draft = value as Partial<TableDesignDraft>
  return typeof draft.tableName === 'string'
    && Array.isArray(draft.columns)
    && Array.isArray(draft.indexes)
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
  const match = String(type).match(/^([a-zA-Z0-9_\s]+?)(?:\(([^)]+)\))?$/)
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
    if (column.comment && (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'clickhouse')) {
      parts.push('COMMENT', sqlString(column.comment))
    }
    return parts.join(' ')
  })

  const primaryKeys = schema.columns.filter(column => column.isPrimaryKey).map(column => quoteIdentifier(driverId, column.name))
  if (primaryKeys.length > 0) {
    columnLines.push(`  PRIMARY KEY (${primaryKeys.join(', ')})`)
  }

  const commentLines: string[] = []
  if (driverId === 'postgresql' || driverId === 'cockroachdb' || driverId === 'duckdb') {
    if (schema.comment) {
      commentLines.push(`COMMENT ON TABLE ${qualifiedName} IS ${sqlString(schema.comment)};`)
    }
    schema.columns.forEach(column => {
      if (column.comment) {
        commentLines.push(`COMMENT ON COLUMN ${qualifiedName}.${quoteIdentifier(driverId, column.name)} IS ${sqlString(column.comment)};`)
      }
    })
  } else if ((driverId === 'mysql' || driverId === 'mariadb') && schema.comment) {
    commentLines.push(`ALTER TABLE ${qualifiedName} COMMENT = ${sqlString(schema.comment)};`)
  } else if (driverId === 'clickhouse' && schema.comment) {
    commentLines.push(`ALTER TABLE ${qualifiedName} MODIFY COMMENT ${sqlString(schema.comment)};`)
  }

  return [
    `CREATE TABLE ${qualifiedName} (`,
    columnLines.join(',\n'),
    ');',
    ...commentLines,
    ''
  ].join('\n')
}

function quoteIdentifier(driverId: string, identifier: string): string {
  if (driverId === 'mysql' || driverId === 'mariadb' || driverId === 'clickhouse') {
    return `\`${String(identifier).replace(/`/g, '``')}\``
  }
  return `"${String(identifier).replace(/"/g, '""')}"`
}

function sqlString(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
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

function formatDuration(value: unknown): string | undefined {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return undefined
  }
  if (numericValue < 1000) {
    return `${numericValue.toFixed(0)} ms`
  }
  return `${(numericValue / 1000).toFixed(2)} s`
}

function formatPercent(value: unknown): string | undefined {
  const numericValue = Number(value)
  if (!Number.isFinite(numericValue)) {
    return undefined
  }
  return `${(numericValue * 100).toFixed(1)}%`
}

function formatDateTime(value: unknown): string | undefined {
  if (!value) {
    return undefined
  }
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return date.toLocaleString()
}

function toNumber(value: unknown): number | undefined {
  const numericValue = Number(value)
  return Number.isFinite(numericValue) ? numericValue : undefined
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
