import { ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode'
import { DbConnectionProfile, QueryResult, TableSchema, SchemaScope, DataQueryOptions } from '@/core/types'
import { DatabaseDriver } from '@/drivers/base'
import { t } from '@/i18n'

export class TableDataPanel {
  private static currentPanel: TableDataPanel | undefined
  private readonly _panel: WebviewPanel
  private _disposables: any[] = []
  private _profile: DbConnectionProfile
  private _driver: DatabaseDriver
  private _tableName: string
  private _scope: SchemaScope
  private _schema: TableSchema | undefined
  private _currentPage: number = 1
  private _pageSize: number = 10
  private _totalRows: number = 0
  private _totalRowsKnown: boolean = true
  private _hasMoreRows: boolean = false
  private _filters: { column: string; operator: string; value: string }[] = []
  private _sorts: { column: string; direction: 'ASC' | 'DESC' }[] = []
  private _disposed = false

  static show(
    context: ExtensionContext,
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    tableName: string,
    scope: SchemaScope
  ): void {
    const column = ViewColumn.One

    if (TableDataPanel.currentPanel) {
      TableDataPanel.currentPanel.dispose()
    }

    const panel = window.createWebviewPanel(
      'dbNexus.tableData',
      t('table.dataTitle', tableName),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    TableDataPanel.currentPanel = new TableDataPanel(
      panel,
      context,
      profile,
      driver,
      tableName,
      scope
    )
  }

  static closeFor(profile: DbConnectionProfile): boolean {
    if (TableDataPanel.currentPanel?._profile.id !== profile.id) {
      return false
    }

    TableDataPanel.currentPanel.dispose()
    return true
  }

  private constructor(
    panel: WebviewPanel,
    context: ExtensionContext,
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    tableName: string,
    scope: SchemaScope
  ) {
    this._panel = panel
    this._profile = profile
    this._driver = driver
    this._tableName = tableName
    this._scope = scope

    this._panel.webview.html = this._getLoadingHtml()

    this._panel.onDidDispose(() => this.dispose(true), null, this._disposables)

    this._panel.webview.onDidReceiveMessage(
      async message => {
        if (!this._isActive()) {
          return
        }

        switch (message.type) {
          case 'ready':
            await this._loadData()
            break
          case 'refresh':
            await this._loadData()
            break
          case 'pageChange':
            this._currentPage = Math.max(1, Number(message.page) || 1)
            await this._loadData()
            break
          case 'pageSizeChange':
            this._pageSize = Math.min(10000, Math.max(1, Number(message.pageSize) || 10))
            this._currentPage = 1
            await this._loadData()
            break
          case 'filter':
            this._filters = message.filters || []
            this._currentPage = 1
            await this._loadData()
            break
          case 'sort':
            this._sorts = message.sorts || []
            this._currentPage = 1
            await this._loadData()
            break
          case 'insert':
            await this._handleInsert(message.row)
            break
          case 'update':
            await this._handleUpdate(message.row, message.originalRow)
            break
          case 'delete':
            await this._handleDelete(message.row)
            break
          case 'deleteRows':
            await this._handleDeleteRows(message.rows || [])
            break
          case 'commitChanges':
            await this._handleCommitChanges(message.changes || [], message.deletes || [])
            break
        }
      },
      null,
      this._disposables
    )
  }

  private async _loadData(): Promise<void> {
    try {
      if (!this._isActive()) {
        return
      }

      if (!this._schema && this._driver.getTableSchema) {
        this._schema = await this._driver.getTableSchema(
          this._profile,
          this._tableName,
          this._scope
        )
        if (!this._isActive()) {
          return
        }
      }

      const options: DataQueryOptions = {
        limit: this._pageSize,
        offset: (this._currentPage - 1) * this._pageSize,
        filters: this._filters.map(f => ({
          column: f.column,
          operator: f.operator as any,
          value: f.value
        })),
        sorts: this._sorts
      }

      if (!this._driver.getTableData) {
        throw new Error('Driver does not support table data')
      }

      const result = await this._driver.getTableData(
        this._profile,
        this._tableName,
        this._scope,
        options
      )
      if (!this._isActive()) {
        return
      }

      const explicitTotalRows = typeof result.totalRows === 'number' && Number.isFinite(result.totalRows)
        ? Math.max(0, result.totalRows)
        : undefined
      const loadedEnd = (this._currentPage - 1) * this._pageSize + result.rows.length

      if (
        explicitTotalRows !== undefined
        && result.rows.length === 0
        && this._currentPage > 1
        && explicitTotalRows > 0
        && (this._currentPage - 1) * this._pageSize >= explicitTotalRows
      ) {
        this._currentPage = Math.max(1, Math.ceil(explicitTotalRows / this._pageSize))
        await this._loadData()
        return
      }

      this._totalRowsKnown = explicitTotalRows !== undefined
      this._hasMoreRows = typeof result.hasMore === 'boolean'
        ? result.hasMore
        : result.rows.length >= this._pageSize
      this._totalRows = explicitTotalRows ?? Math.max(this._totalRows, loadedEnd + (this._hasMoreRows ? 1 : 0))

      this._setHtml(this._getEditableGridHtml(result))
    } catch (error: unknown) {
      if (!this._isActive()) {
        return
      }

      const message = error instanceof Error ? error.message : String(error)
      this._setHtml(this._getErrorHtml(message))
    }
  }

  private async _handleInsert(row: Record<string, unknown>): Promise<void> {
    try {
      if (!this._driver.planInsert || !this._driver.executeMutation) {
        throw new Error('Driver does not support insert')
      }

      const plan = await this._driver.planInsert(
        this._profile,
        this._tableName,
        row,
        this._scope
      )

      const result = await this._driver.executeMutation(this._profile, plan)
      if (result.success) {
        this._sendMessage({ type: 'operationSuccess', message: `Inserted ${result.affectedRows} row(s)` })
        await this._loadData()
      } else {
        this._sendMessage({ type: 'operationError', error: result.error || 'Unknown error' })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this._sendMessage({ type: 'operationError', error: message })
    }
  }

  private async _handleUpdate(
    row: Record<string, unknown>,
    originalRow: Record<string, unknown>
  ): Promise<void> {
    try {
      if (!this._driver.planUpdate || !this._driver.executeMutation) {
        throw new Error('Driver does not support update')
      }

      const plan = await this._driver.planUpdate(
        this._profile,
        this._tableName,
        row,
        originalRow,
        this._scope
      )

      const result = await this._driver.executeMutation(this._profile, plan)
      if (result.success) {
        this._sendMessage({ type: 'operationSuccess', message: `Updated ${result.affectedRows} row(s)` })
        await this._loadData()
      } else {
        this._sendMessage({ type: 'operationError', error: result.error || 'Unknown error' })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this._sendMessage({ type: 'operationError', error: message })
    }
  }

  private async _handleCommitChanges(
    changes: Array<{ row: Record<string, unknown>; originalRow: Record<string, unknown> }>,
    deletes: Array<Record<string, unknown>> = []
  ): Promise<void> {
    try {
      if (!this._driver.executeMutation) {
        throw new Error('Driver does not support mutations')
      }
      if (changes.length > 0 && !this._driver.planUpdate) {
        throw new Error('Driver does not support update')
      }
      if (deletes.length > 0 && !this._driver.planDelete) {
        throw new Error('Driver does not support delete')
      }

      let affectedRows = 0
      for (const change of changes) {
        const plan = await this._driver.planUpdate!(
          this._profile,
          this._tableName,
          change.row,
          change.originalRow,
          this._scope
        )
        const result = await this._driver.executeMutation(this._profile, plan)
        if (!result.success) {
          throw new Error(result.error || 'Unknown error')
        }
        affectedRows += result.affectedRows || 0
      }

      for (const row of deletes) {
        const plan = await this._driver.planDelete!(
          this._profile,
          this._tableName,
          row,
          this._scope
        )
        const result = await this._driver.executeMutation(this._profile, plan)
        if (!result.success) {
          throw new Error(result.error || 'Unknown error')
        }
        affectedRows += result.affectedRows || 0
      }

      this._sendMessage({ type: 'operationSuccess', message: `Committed ${affectedRows} row(s)` })
      await this._loadData()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this._sendMessage({ type: 'operationError', error: message })
    }
  }

  private async _handleDelete(row: Record<string, unknown>): Promise<void> {
    await this._handleDeleteRows(row ? [row] : [])
  }

  private async _handleDeleteRows(rows: Record<string, unknown>[]): Promise<void> {
    try {
      if (!this._driver.planDelete || !this._driver.executeMutation) {
        throw new Error('Driver does not support delete')
      }

      if (!Array.isArray(rows) || rows.length === 0) {
        return
      }

      let affectedRows = 0
      for (const row of rows) {
        const plan = await this._driver.planDelete(
          this._profile,
          this._tableName,
          row,
          this._scope
        )

        const result = await this._driver.executeMutation(this._profile, plan)
        if (!result.success) {
          throw new Error(result.error || 'Unknown error')
        }
        affectedRows += result.affectedRows || 0
      }

      this._sendMessage({ type: 'operationSuccess', message: `Deleted ${affectedRows} row(s)` })
      await this._loadData()
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this._sendMessage({ type: 'operationError', error: message })
    }
  }

  private _sendMessage(message: any): void {
    if (!this._isActive()) {
      return
    }

    try {
      void this._panel.webview.postMessage(message)
    } catch (error: unknown) {
      if (!this._isDisposedError(error)) {
        throw error
      }
      this.dispose(true)
    }
  }

  private _setHtml(html: string): void {
    if (!this._isActive()) {
      return
    }

    try {
      this._panel.webview.html = html
    } catch (error: unknown) {
      if (!this._isDisposedError(error)) {
        throw error
      }
      this.dispose(true)
    }
  }

  private _isActive(): boolean {
    return !this._disposed && TableDataPanel.currentPanel === this
  }

  private _isDisposedError(error: unknown): boolean {
    return error instanceof Error && /webview is disposed/i.test(error.message)
  }

  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('table.dataTitle', this._tableName)}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
    }
    .loading {
      font-size: 16px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="loading">${t('connection.loading')}</div>
  <script>
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }

  private _getErrorHtml(error: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('table.dataTitle', this._tableName)}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }
    .error {
      color: var(--vscode-errorForeground);
      padding: 12px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 4px;
    }
    .retry-btn {
      margin-top: 12px;
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    .retry-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <div class="error">${this._escapeHtml(error)}</div>
  <button class="retry-btn" onclick="refresh()">${t('common.refresh') || 'Refresh'}</button>
  <script>
    const vscode = acquireVsCodeApi();
    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }
    window.addEventListener('keydown', event => {
      if (event.key === 'F5') {
        event.preventDefault();
        refresh();
      }
    });
  </script>
</body>
</html>`
  }

  private _getEditableGridHtml(result: QueryResult): string {
    const schemaColumns = this._schema?.columns.map(column => column.name) || []
    const columns = result.columns.length > 0 ? result.columns.map(c => c.name) : schemaColumns
    const rows = result.rows
    const offset = (this._currentPage - 1) * this._pageSize
    const totalPages = this._totalRowsKnown
      ? Math.max(1, Math.ceil(this._totalRows / this._pageSize))
      : Math.max(1, this._currentPage + (this._hasMoreRows ? 1 : 0))
    const canGoNext = this._hasMoreRows || (this._totalRowsKnown && this._currentPage < totalPages)
    const canGoLast = this._totalRowsKnown && this._currentPage < totalPages
    const pageInfo = this._totalRowsKnown
      ? `Page ${this._currentPage} of ${totalPages}`
      : `Page ${this._currentPage}${this._hasMoreRows ? ' · more rows available' : ''}`
    const statsText = this._totalRowsKnown
      ? `${this._totalRows.toLocaleString()} rows total`
      : rows.length > 0
        ? `${(offset + 1).toLocaleString()}-${(offset + rows.length).toLocaleString()} rows${this._hasMoreRows ? '+' : ''}`
        : '0 rows'
    const primaryKeyColumns = this._schema?.columns.filter(c => c.isPrimaryKey).map(c => c.name) || []
    const canEdit = primaryKeyColumns.length > 0
    const canInsert = !!(this._driver.planInsert && this._driver.executeMutation && this._schema)
    const canDelete = !!(canEdit && this._driver.planDelete && this._driver.executeMutation)
    const hasBottomBar = canEdit || canInsert || canDelete
    const insertColumnDetails = this._schema?.columns || []
    const insertColumns = insertColumnDetails.map(column => column.name)
    const defaultColumnWidth = 180

    const colgroup = [
      '<col class="select-col" style="width: 42px">',
      ...columns.map((column, index) => `<col data-col-index="${index}" style="width: ${defaultColumnWidth}px">`)
    ].join('')

    const selectHeader = `
      <th class="select-header">
        <input id="selectAllRows" type="checkbox" title="Select all rows on this page" ${rows.length === 0 ? 'disabled' : ''}>
      </th>
    `

    const headers = columns.map((column, index) => {
      const isPk = primaryKeyColumns.includes(column)
      const sort = this._sorts.find(s => s.column === column)
      const sortLabel = sort ? (sort.direction === 'ASC' ? 'ASC' : 'DESC') : ''
      return `
        <th class="sortable" data-column="${this._escapeAttr(column)}" data-col-index="${index}">
          <div class="header-content">
            <span>${isPk ? '<span class="pk-indicator" title="Primary Key">&#128273; PK</span> ' : ''}${this._escapeHtml(column)}</span>
            <span class="sort-icon">${sortLabel}</span>
          </div>
          <span class="col-resizer" data-col-index="${index}"></span>
        </th>
      `
    }).join('')

    const bodyRows = rows.length > 0 ? rows.map((row, rowIndex) => `
      <tr data-row-index="${rowIndex}">
        <td class="select-cell">
          <input type="checkbox" class="row-select" data-row-select="${rowIndex}" title="Select row ${offset + rowIndex + 1}">
        </td>
        ${columns.map((column, columnIndex) => {
          const value = row[column]
          const raw = value === null || value === undefined ? '' : String(value)
          const displayValue = value === null || value === undefined
            ? '<span class="null-value">NULL</span>'
            : this._escapeHtml(raw)
          const rowHandle = columnIndex === 0 ? '<span class="row-resizer" title="Resize row"></span>' : ''
          return `<td class="data-cell" data-row-index="${rowIndex}" data-column="${this._escapeAttr(column)}" data-raw="${this._escapeAttr(raw)}">${displayValue}${rowHandle}</td>`
        }).join('')}
      </tr>
    `).join('') : `
      <tr class="empty-row">
        <td class="empty-cell" colspan="${Math.max(1, columns.length + 1)}">No rows on this page</td>
      </tr>
    `

    const insertPanel = canInsert ? `
  <div class="insert-panel hidden" id="insertPanel">
    <div class="insert-grid">
      ${insertColumnDetails.map(column => `
        <label>
          <span>${column.isPrimaryKey ? '<span class="pk-indicator" title="Primary Key">&#128273; PK</span> ' : ''}${this._escapeHtml(column.name)}</span>
          <input data-insert-column="${this._escapeAttr(column.name)}" type="text" placeholder="${this._escapeAttr(column.isAutoIncrement ? t('table.autoIncrementLeaveBlank') : column.type)}">
        </label>
      `).join('')}
    </div>
    <div class="insert-actions">
      <button id="insertSaveBtn">Insert</button>
      <button id="insertCancelBtn" class="secondary">Cancel</button>
    </div>
  </div>
    ` : ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this._escapeHtml(t('table.dataTitle', this._tableName))}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      min-height: 100vh;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-size: 13px;
      padding-bottom: ${hasBottomBar ? '58px' : '12px'};
    }
    .toolbar, .filter-bar, .pagination {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .toolbar {
      margin-bottom: 10px;
    }
    .filter-bar {
      margin-bottom: 10px;
    }
    .insert-panel {
      margin-bottom: 10px;
      padding: 10px;
      border: 1px solid var(--vscode-widget-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
    }
    .insert-panel.hidden {
      display: none;
    }
    .insert-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 8px;
    }
    .insert-grid label {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .insert-grid span {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .insert-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 10px;
    }
    .stats {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    button, select, input {
      font: inherit;
    }
    button {
      border: 0;
      border-radius: 4px;
      padding: 5px 10px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    button:disabled {
      opacity: .45;
      cursor: not-allowed;
    }
    select, input {
      padding: 5px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    .table-container {
      overflow: auto;
      border: 1px solid var(--vscode-widget-border);
      max-height: calc(100vh - ${hasBottomBar ? '188px' : '138px'});
    }
    table {
      border-collapse: collapse;
      table-layout: fixed;
      width: max-content;
      min-width: 100%;
      font-size: 13px;
    }
    th, td {
      position: relative;
      min-width: 56px;
      height: 32px;
      padding: 6px 10px;
      border: 1px solid var(--vscode-widget-border);
      text-align: left;
      vertical-align: top;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      user-select: none;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      font-weight: 600;
    }
    .select-header,
    .select-cell {
      width: 42px;
      min-width: 42px;
      max-width: 42px;
      padding: 0;
      text-align: center;
      vertical-align: middle;
    }
    .select-header {
      left: 0;
      z-index: 4;
    }
    .select-cell {
      background: var(--vscode-editor-background);
    }
    .select-cell input,
    .select-header input {
      width: 14px;
      height: 14px;
      margin: 0;
      cursor: pointer;
    }
    .header-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .sort-icon {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
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
    .col-resizer {
      position: absolute;
      top: 0;
      right: -3px;
      width: 7px;
      height: 100%;
      cursor: col-resize;
      z-index: 3;
    }
    .row-resizer {
      position: absolute;
      left: 0;
      bottom: -3px;
      width: 100%;
      height: 7px;
      cursor: row-resize;
      z-index: 2;
    }
    tr:hover td {
      background: var(--vscode-list-hoverBackground);
    }
    tr.selected-row td {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    tr.selected-row .select-cell {
      background: var(--vscode-list-activeSelectionBackground);
    }
    tr.row-delete-pending td {
      color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
      background: color-mix(in srgb, var(--vscode-errorForeground) 12%, var(--vscode-editor-background));
      text-decoration: line-through;
    }
    tr.row-delete-pending .select-cell {
      text-decoration: none;
    }
    .empty-cell {
      height: 96px;
      text-align: center;
      vertical-align: middle;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
    }
    .data-cell {
      cursor: cell;
    }
    .data-cell.dirty {
      background: var(--vscode-editor-inactiveSelectionBackground);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .cell-editor {
      width: 100%;
      height: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 2px;
      padding: 3px 5px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    tr.row-dirty td:first-child::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 3px;
      background: var(--vscode-textLink-foreground);
    }
    .null-value {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .pagination {
      margin-top: 10px;
    }
    .page-size-input {
      width: 82px;
    }
    .page-info {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .commit-bar {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      min-height: 46px;
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorGroupHeader-tabsBackground);
      z-index: 10;
    }
    .pending-status {
      margin-right: auto;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .row-actions {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      padding-right: 8px;
      border-right: 1px solid var(--vscode-panel-border);
    }
    .icon-button {
      min-width: 34px;
      font-size: 15px;
      line-height: 1;
    }
    .context-menu {
      position: fixed;
      z-index: 30;
      min-width: 132px;
      padding: 4px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      box-shadow: 0 8px 24px rgba(0,0,0,.24);
    }
    .context-menu.hidden {
      display: none;
    }
    .context-menu button {
      width: 100%;
      justify-content: flex-start;
      border-radius: 2px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: transparent;
    }
    .context-menu button:hover:not(:disabled) {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
    }
    .delete-confirm-backdrop {
      position: fixed;
      inset: 0;
      z-index: 40;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, .28);
    }
    .delete-confirm-backdrop.hidden {
      display: none;
    }
    .delete-confirm {
      width: min(420px, calc(100vw - 32px));
      padding: 14px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 6px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      box-shadow: 0 12px 36px rgba(0,0,0,.34);
    }
    .delete-confirm-title {
      margin-bottom: 8px;
      font-weight: 600;
    }
    .delete-confirm-message {
      margin-bottom: 14px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }
    .delete-confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .danger-button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-errorForeground);
    }
    .danger-button:hover:not(:disabled) {
      background: color-mix(in srgb, var(--vscode-errorForeground) 84%, black);
    }
    .toast {
      position: fixed;
      right: 16px;
      bottom: ${hasBottomBar ? '62px' : '16px'};
      z-index: 20;
      max-width: min(520px, calc(100vw - 32px));
      padding: 10px 14px;
      border-radius: 4px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      box-shadow: 0 8px 24px rgba(0,0,0,.24);
    }
    .toast.error {
      border-color: var(--vscode-inputValidation-errorBorder);
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="refreshBtn" class="secondary" title="F5">${this._escapeHtml(t('common.refresh'))}</button>
    <span class="page-info" id="selectionStatus">0 selected</span>
    <div class="stats">${this._escapeHtml(statsText)} / ${this._escapeHtml(pageInfo)}</div>
  </div>

  ${insertPanel}

  <div class="filter-bar">
    <select id="filterColumn">
      <option value="">Select column...</option>
      ${columns.map(column => `<option value="${this._escapeAttr(column)}">${this._escapeHtml(column)}</option>`).join('')}
    </select>
    <select id="filterOperator">
      <option value="=">=</option>
      <option value="!=">!=</option>
      <option value=">">&gt;</option>
      <option value="<">&lt;</option>
      <option value=">=">&gt;=</option>
      <option value="<=">&lt;=</option>
      <option value="LIKE">LIKE</option>
      <option value="IS NULL">IS NULL</option>
      <option value="IS NOT NULL">IS NOT NULL</option>
    </select>
    <input id="filterValue" type="text" placeholder="Filter value...">
    <button id="applyFilterBtn" class="secondary">Apply Filter</button>
    <button id="clearFilterBtn" class="secondary">Clear</button>
  </div>

  <div class="table-container">
    <table id="dataGrid">
      <colgroup>${colgroup}</colgroup>
      <thead>
        <tr>
          ${selectHeader}
          ${headers}
        </tr>
      </thead>
      <tbody id="tableBody">${bodyRows}</tbody>
    </table>
  </div>
  <div class="context-menu hidden" id="rowContextMenu">
    <button id="contextDeleteRow" type="button">Delete row</button>
    <button id="contextUndoDelete" type="button">Undo delete</button>
  </div>
  <div class="delete-confirm-backdrop hidden" id="deleteConfirmDialog" role="dialog" aria-modal="true">
    <div class="delete-confirm">
      <div class="delete-confirm-title">Confirm delete</div>
      <div class="delete-confirm-message" id="deleteConfirmMessage"></div>
      <div class="delete-confirm-actions">
        <button id="deleteConfirmCancel" class="secondary" type="button">Cancel</button>
        <button id="deleteConfirmPrimary" class="danger-button" type="button">Mark delete</button>
      </div>
    </div>
  </div>

  <div class="pagination">
    <button id="firstPage" class="secondary" ${this._currentPage === 1 ? 'disabled' : ''}>First</button>
    <button id="prevPage" class="secondary" ${this._currentPage === 1 ? 'disabled' : ''}>Prev</button>
    <span class="page-info">${this._escapeHtml(pageInfo)}</span>
    <button id="nextPage" class="secondary" ${canGoNext ? '' : 'disabled'}>Next</button>
    <button id="lastPage" class="secondary" ${canGoLast ? '' : 'disabled'}>Last</button>
    <select id="pageSizeSelect">
      <option value="10" ${this._pageSize === 10 ? 'selected' : ''}>10 rows</option>
      <option value="25" ${this._pageSize === 25 ? 'selected' : ''}>25 rows</option>
      <option value="50" ${this._pageSize === 50 ? 'selected' : ''}>50 rows</option>
      <option value="100" ${this._pageSize === 100 ? 'selected' : ''}>100 rows</option>
      <option value="200" ${this._pageSize === 200 ? 'selected' : ''}>200 rows</option>
      ${[10, 25, 50, 100, 200].includes(this._pageSize) ? '' : `<option value="${this._pageSize}" selected>${this._pageSize} rows</option>`}
    </select>
    <input id="pageSizeInput" class="page-size-input" type="number" min="1" max="10000" value="${this._pageSize}" title="Custom rows per page">
    <button id="applyPageSize" class="secondary">Rows</button>
  </div>

  ${hasBottomBar ? `
  <div class="commit-bar">
    <div class="row-actions">
      ${canInsert ? '<button class="icon-button" id="addRowBtn" type="button" title="New row">+</button>' : ''}
      ${canDelete ? '<button class="icon-button secondary" id="removeRowsBtn" type="button" title="Mark selected rows for delete" disabled>-</button>' : ''}
    </div>
    <span class="pending-status" id="pendingStatus">No pending changes</span>
    ${canEdit ? '<button class="icon-button" id="commitBtn" title="Commit changes (Ctrl+S)" disabled>&#10003;</button><button class="icon-button secondary" id="revertBtn" title="Cancel and restore" disabled>&#8634;</button>' : ''}
  </div>
  ` : ''}

  <script>
    const vscode = acquireVsCodeApi();
    const rows = ${this._escapeScriptJson(JSON.stringify(rows))};
    const columns = ${this._escapeScriptJson(JSON.stringify(columns))};
    const primaryKeyColumns = ${this._escapeScriptJson(JSON.stringify(primaryKeyColumns))};
    const canEdit = ${canEdit ? 'true' : 'false'};
    const canInsert = ${canInsert ? 'true' : 'false'};
    const canDelete = ${canDelete ? 'true' : 'false'};
    const insertColumns = ${this._escapeScriptJson(JSON.stringify(insertColumns))};
    const pendingUpdates = new Map();
    const pendingDeletes = new Map();
    const selectedRows = new Set();
    let pendingDeleteTargets = [];
    let contextRowIndex = null;

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
    window.addEventListener('keydown', event => {
      if (event.key === 'F5') {
        event.preventDefault();
        vscode.postMessage({ type: 'refresh' });
      }
    });

    function selectedRowIndexes() {
      return Array.from(selectedRows).sort((left, right) => left - right);
    }

    function syncSelectedRowsFromCheckboxes() {
      selectedRows.clear();
      document.querySelectorAll('.row-select').forEach(checkbox => {
        if (checkbox.checked) {
          selectedRows.add(Number(checkbox.dataset.rowSelect));
        }
      });
    }

    function updateSelectedRowState() {
      document.querySelectorAll('tr[data-row-index]').forEach(row => {
        const rowIndex = Number(row.dataset.rowIndex);
        const selected = selectedRows.has(rowIndex);
        row.classList.toggle('selected-row', selected);
        row.classList.toggle('row-delete-pending', pendingDeletes.has(rowIndex));
        const checkbox = row.querySelector('.row-select');
        if (checkbox) {
          checkbox.checked = selected;
        }
      });

      const count = selectedRows.size;
      const selectionStatus = document.getElementById('selectionStatus');
      if (selectionStatus) {
        selectionStatus.textContent = count === 1 ? '1 selected' : count + ' selected';
      }

      const deleteButton = document.getElementById('deleteRowBtn');
      if (deleteButton) {
        deleteButton.disabled = !canDelete || count === 0;
        deleteButton.textContent = count > 1 ? 'Delete ' + count + ' Rows' : 'Delete Selected';
      }
      const removeButton = document.getElementById('removeRowsBtn');
      if (removeButton) {
        removeButton.disabled = !canDelete || count === 0;
      }

      const selectAll = document.getElementById('selectAllRows');
      if (selectAll) {
        const selectableRows = document.querySelectorAll('tr[data-row-index]').length;
        selectAll.checked = selectableRows > 0 && count === selectableRows;
        selectAll.indeterminate = count > 0 && count < selectableRows;
      }
    }

    document.querySelectorAll('tr[data-row-index]').forEach(row => {
      row.addEventListener('click', event => {
        if (event.target.closest('input')) return;
        const rowIndex = Number(row.dataset.rowIndex);
        if (selectedRows.has(rowIndex)) {
          selectedRows.delete(rowIndex);
        } else {
          selectedRows.add(rowIndex);
        }
        updateSelectedRowState();
      });
    });

    document.querySelectorAll('.row-select').forEach(checkbox => {
      checkbox.addEventListener('change', event => {
        const rowIndex = Number(checkbox.dataset.rowSelect);
        if (checkbox.checked) {
          selectedRows.add(rowIndex);
        } else {
          selectedRows.delete(rowIndex);
        }
        updateSelectedRowState();
        event.stopPropagation();
      });
    });

    document.getElementById('selectAllRows')?.addEventListener('change', event => {
      selectedRows.clear();
      if (event.target.checked) {
        document.querySelectorAll('tr[data-row-index]').forEach(row => {
          selectedRows.add(Number(row.dataset.rowIndex));
        });
      }
      updateSelectedRowState();
    });

    function hideRowContextMenu() {
      const menu = document.getElementById('rowContextMenu');
      if (menu) {
        menu.classList.add('hidden');
      }
      contextRowIndex = null;
    }

    function showRowContextMenu(event, rowIndex) {
      const menu = document.getElementById('rowContextMenu');
      if (!menu) return;
      contextRowIndex = rowIndex;
      const deleteButton = document.getElementById('contextDeleteRow');
      const undoButton = document.getElementById('contextUndoDelete');
      if (deleteButton) {
        deleteButton.disabled = !canDelete || pendingDeletes.has(rowIndex);
      }
      if (undoButton) {
        undoButton.disabled = !pendingDeletes.has(rowIndex);
      }
      menu.style.left = Math.min(event.clientX, window.innerWidth - 150) + 'px';
      menu.style.top = Math.min(event.clientY, window.innerHeight - 78) + 'px';
      menu.classList.remove('hidden');
    }

    function clearRowPendingUpdate(rowIndex) {
      pendingUpdates.delete(rowIndex);
      const row = document.querySelector('tr[data-row-index="' + rowIndex + '"]');
      if (!row) return;
      row.classList.remove('row-dirty');
      row.querySelectorAll('.data-cell').forEach(cell => {
        const column = cell.dataset.column;
        renderCellValue(cell, rows[rowIndex][column]);
        cell.classList.remove('dirty');
      });
    }

    function markRowsForDelete(rowIndexes) {
      if (!canDelete) return;
      const targets = rowIndexes
        .filter(rowIndex => rows[rowIndex] && !pendingDeletes.has(rowIndex));
      if (targets.length === 0) return;

      targets.forEach(rowIndex => {
        pendingDeletes.set(rowIndex, rows[rowIndex]);
        selectedRows.delete(rowIndex);
        clearRowPendingUpdate(rowIndex);
      });
      hideRowContextMenu();
      updateSelectedRowState();
      updateCommitState();
      showToast(targets.length === 1 ? 'Row marked for delete' : targets.length + ' rows marked for delete', 'success');
    }

    function undoDelete(rowIndexes) {
      rowIndexes.forEach(rowIndex => pendingDeletes.delete(rowIndex));
      hideRowContextMenu();
      updateSelectedRowState();
      updateCommitState();
    }

    function hideDeleteConfirm() {
      pendingDeleteTargets = [];
      document.getElementById('deleteConfirmDialog')?.classList.add('hidden');
    }

    function requestDeleteRows(rowIndexes) {
      syncSelectedRowsFromCheckboxes();
      const sourceIndexes = rowIndexes.length > 0 ? rowIndexes : selectedRowIndexes();
      const targets = sourceIndexes
        .filter(rowIndex => rows[rowIndex] && !pendingDeletes.has(rowIndex));
      if (targets.length === 0) {
        showToast('Select rows to delete', 'error');
        return;
      }
      pendingDeleteTargets = targets;
      const message = targets.length === 1
        ? 'This row will be marked for delete. You can still undo before commit.'
        : targets.length + ' rows will be marked for delete. You can still undo before commit.';
      document.getElementById('deleteConfirmMessage').textContent = message;
      document.getElementById('deleteConfirmPrimary').textContent = targets.length === 1 ? 'Mark delete' : 'Mark ' + targets.length + ' deletes';
      document.getElementById('deleteConfirmDialog').classList.remove('hidden');
    }

    document.querySelectorAll('tr[data-row-index]').forEach(row => {
      row.addEventListener('contextmenu', event => {
        event.preventDefault();
        const rowIndex = Number(row.dataset.rowIndex);
        if (!selectedRows.has(rowIndex)) {
          selectedRows.clear();
          selectedRows.add(rowIndex);
          updateSelectedRowState();
        }
        showRowContextMenu(event, rowIndex);
      });
    });

    document.getElementById('contextDeleteRow')?.addEventListener('click', () => {
      if (contextRowIndex === null) return;
      const targets = selectedRows.has(contextRowIndex) ? selectedRowIndexes() : [contextRowIndex];
      requestDeleteRows(targets);
    });
    document.getElementById('contextUndoDelete')?.addEventListener('click', () => {
      if (contextRowIndex === null) return;
      undoDelete([contextRowIndex]);
    });
    document.addEventListener('click', event => {
      if (!event.target.closest || !event.target.closest('#rowContextMenu')) {
        hideRowContextMenu();
      }
    });
    document.getElementById('deleteConfirmCancel')?.addEventListener('click', hideDeleteConfirm);
    document.getElementById('deleteConfirmDialog')?.addEventListener('click', event => {
      if (event.target.id === 'deleteConfirmDialog') {
        hideDeleteConfirm();
      }
    });
    document.getElementById('deleteConfirmPrimary')?.addEventListener('click', () => {
      const targets = pendingDeleteTargets.slice();
      hideDeleteConfirm();
      markRowsForDelete(targets);
    });

    const addRowButton = document.getElementById('addRowBtn');
    const insertPanel = document.getElementById('insertPanel');
    const insertSaveButton = document.getElementById('insertSaveBtn');
    const insertCancelButton = document.getElementById('insertCancelBtn');
    if (addRowButton && insertPanel) {
      addRowButton.addEventListener('click', () => {
        insertPanel.classList.toggle('hidden');
        const firstInput = insertPanel.querySelector('input[data-insert-column]');
        if (!insertPanel.classList.contains('hidden') && firstInput) {
          firstInput.focus();
        }
      });
    }
    if (insertSaveButton && insertPanel) {
      insertSaveButton.addEventListener('click', () => {
        const row = {};
        insertPanel.querySelectorAll('input[data-insert-column]').forEach(input => {
          const value = input.value;
          if (value !== '') {
            row[input.dataset.insertColumn] = value.toLowerCase() === 'null' ? null : value;
          }
        });
        vscode.postMessage({ type: 'insert', row });
      });
    }
    if (insertCancelButton && insertPanel) {
      insertCancelButton.addEventListener('click', () => {
        insertPanel.querySelectorAll('input[data-insert-column]').forEach(input => input.value = '');
        insertPanel.classList.add('hidden');
      });
    }
    document.getElementById('deleteRowBtn')?.addEventListener('click', () => {
      requestDeleteRows(selectedRowIndexes());
    });
    document.getElementById('removeRowsBtn')?.addEventListener('click', () => {
      requestDeleteRows(selectedRowIndexes());
    });
    updateSelectedRowState();

    function parseTemporalValue(raw) {
      if (!raw || typeof raw !== 'string') return '';
      const value = raw.trim();
      if (!/[T:\\-\\/]/.test(value)) return '';
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return '';
      const date = new Date(time);
      return 'Local: ' + date.toLocaleString() + '\\nISO: ' + date.toISOString();
    }

    function renderCellValue(cell, value) {
      cell.textContent = '';
      if (value === null || value === undefined || value === '') {
        const span = document.createElement('span');
        span.className = 'null-value';
        span.textContent = value === '' ? '' : 'NULL';
        cell.appendChild(span);
      } else {
        cell.textContent = String(value);
      }
      if (!cell.querySelector('.row-resizer') && cell.parentElement.querySelector('.data-cell') === cell) {
        const handle = document.createElement('span');
        handle.className = 'row-resizer';
        handle.title = 'Resize row';
        cell.appendChild(handle);
      }
    }

    function hasDiff(originalRow, nextRow) {
      return columns.some(column => String(originalRow[column] ?? '') !== String(nextRow[column] ?? ''));
    }

    function setPendingCell(rowIndex, column, value, cell) {
      const originalRow = rows[rowIndex];
      const pending = pendingUpdates.get(rowIndex) || { originalRow, row: { ...originalRow } };
      pending.row[column] = value;

      const originalValue = String(originalRow[column] ?? '');
      cell.classList.toggle('dirty', String(value ?? '') !== originalValue);

      if (hasDiff(originalRow, pending.row)) {
        pendingUpdates.set(rowIndex, pending);
        cell.parentElement.classList.add('row-dirty');
      } else {
        pendingUpdates.delete(rowIndex);
        cell.parentElement.classList.remove('row-dirty');
        cell.parentElement.querySelectorAll('.data-cell').forEach(item => item.classList.remove('dirty'));
      }
      updateCommitState();
    }

    function startCellEdit(cell) {
      if (!canEdit || cell.querySelector('input')) return;
      const rowIndex = Number(cell.dataset.rowIndex);
      if (pendingDeletes.has(rowIndex)) return;
      const column = cell.dataset.column;
      const pending = pendingUpdates.get(rowIndex);
      const sourceRow = pending ? pending.row : rows[rowIndex];
      const currentValue = sourceRow[column] === null || sourceRow[column] === undefined ? '' : String(sourceRow[column]);

      cell.textContent = '';
      const input = document.createElement('input');
      input.className = 'cell-editor';
      input.value = currentValue;
      cell.appendChild(input);
      input.focus();
      input.select();

      let finished = false;
      function finish(commit) {
        if (finished) return;
        finished = true;
        const nextValue = input.value;
        renderCellValue(cell, commit ? nextValue : currentValue);
        if (commit) {
          setPendingCell(rowIndex, column, nextValue, cell);
        }
      }

      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          finish(true);
          commitChanges();
        }
      });
      input.addEventListener('blur', () => finish(true), { once: true });
    }

    document.querySelectorAll('.data-cell').forEach(cell => {
      cell.addEventListener('dblclick', () => startCellEdit(cell));
      cell.addEventListener('mouseenter', () => {
        const parsed = parseTemporalValue(cell.dataset.raw || cell.textContent || '');
        if (parsed) cell.title = parsed;
      });
    });

    function updateCommitState() {
      if (!canEdit) return;
      const updateCount = pendingUpdates.size;
      const deleteCount = pendingDeletes.size;
      const count = updateCount + deleteCount;
      const parts = [];
      if (updateCount) parts.push(updateCount + ' edited');
      if (deleteCount) parts.push(deleteCount + ' delete pending');
      document.getElementById('pendingStatus').textContent = count ? parts.join(', ') : 'No pending changes';
      document.getElementById('commitBtn').disabled = count === 0;
      document.getElementById('revertBtn').disabled = count === 0;
    }

    function commitChanges() {
      if (!pendingUpdates.size && !pendingDeletes.size) return;
      const changes = Array.from(pendingUpdates.values());
      const deletes = Array.from(pendingDeletes.values());
      vscode.postMessage({ type: 'commitChanges', changes, deletes });
    }

    function revertChanges() {
      pendingUpdates.clear();
      pendingDeletes.clear();
      document.querySelectorAll('tr[data-row-index]').forEach(row => {
        const rowIndex = Number(row.dataset.rowIndex);
        row.classList.remove('row-dirty');
        row.classList.remove('row-delete-pending');
        row.querySelectorAll('.data-cell').forEach(cell => {
          const column = cell.dataset.column;
          renderCellValue(cell, rows[rowIndex][column]);
          cell.classList.remove('dirty');
        });
      });
      updateSelectedRowState();
      updateCommitState();
    }

    if (canEdit) {
      document.getElementById('commitBtn').addEventListener('click', commitChanges);
      document.getElementById('revertBtn').addEventListener('click', revertChanges);
      window.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          commitChanges();
        }
      });
    }

    document.querySelectorAll('.col-resizer').forEach(handle => {
      handle.addEventListener('mousedown', event => {
        event.preventDefault();
        event.stopPropagation();
        const index = handle.dataset.colIndex;
        const col = document.querySelector('col[data-col-index="' + index + '"]');
        const startX = event.clientX;
        const startWidth = col.getBoundingClientRect().width;

        function onMove(moveEvent) {
          col.style.width = Math.max(64, startWidth + moveEvent.clientX - startX) + 'px';
        }
        function onUp() {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
    });

    document.getElementById('tableBody').addEventListener('mousedown', event => {
      if (!event.target.classList.contains('row-resizer')) return;
      event.preventDefault();
      const row = event.target.closest('tr');
      const startY = event.clientY;
      const startHeight = row.getBoundingClientRect().height;

      function onMove(moveEvent) {
        row.style.height = Math.max(24, startHeight + moveEvent.clientY - startY) + 'px';
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', event => {
        if (event.target.classList.contains('col-resizer')) return;
        const column = th.dataset.column;
        const currentSort = ${this._escapeScriptJson(JSON.stringify(this._sorts))};
        const existingSort = currentSort.find(sort => sort.column === column);
        const direction = existingSort && existingSort.direction === 'ASC' ? 'DESC' : 'ASC';
        vscode.postMessage({ type: 'sort', sorts: [{ column, direction }] });
      });
    });

    document.getElementById('applyFilterBtn').addEventListener('click', () => {
      const column = document.getElementById('filterColumn').value;
      const operator = document.getElementById('filterOperator').value;
      const value = document.getElementById('filterValue').value;
      if (column && operator) {
        vscode.postMessage({ type: 'filter', filters: [{ column, operator, value }] });
      }
    });
    document.getElementById('clearFilterBtn').addEventListener('click', () => {
      document.getElementById('filterColumn').value = '';
      document.getElementById('filterValue').value = '';
      vscode.postMessage({ type: 'filter', filters: [] });
    });

    document.getElementById('firstPage').addEventListener('click', () => vscode.postMessage({ type: 'pageChange', page: 1 }));
    document.getElementById('prevPage').addEventListener('click', () => vscode.postMessage({ type: 'pageChange', page: ${this._currentPage - 1} }));
    document.getElementById('nextPage').addEventListener('click', () => vscode.postMessage({ type: 'pageChange', page: ${this._currentPage + 1} }));
    document.getElementById('lastPage').addEventListener('click', () => vscode.postMessage({ type: 'pageChange', page: ${totalPages} }));
    document.getElementById('pageSizeSelect').addEventListener('change', event => {
      const nextSize = Number(event.target.value);
      document.getElementById('pageSizeInput').value = String(nextSize);
      vscode.postMessage({ type: 'pageSizeChange', pageSize: nextSize });
    });
    function applyCustomPageSize() {
      const input = document.getElementById('pageSizeInput');
      const nextSize = Math.max(1, Math.min(10000, Number(input.value) || ${this._pageSize}));
      input.value = String(nextSize);
      vscode.postMessage({ type: 'pageSizeChange', pageSize: nextSize });
    }
    document.getElementById('applyPageSize').addEventListener('click', applyCustomPageSize);
    document.getElementById('pageSizeInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyCustomPageSize();
      }
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'operationSuccess') {
        showToast(message.message, 'success');
      } else if (message.type === 'operationError') {
        showToast(message.error, 'error');
      }
    });

    function showToast(message, type) {
      const toast = document.createElement('div');
      toast.className = 'toast ' + (type || '');
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3200);
    }
  </script>
</body>
</html>`
  }

  private _getHtml(result: QueryResult): string {
    const columns = result.columns.map(c => c.name)
    const rows = result.rows
    const totalPages = Math.ceil(this._totalRows / this._pageSize)

    const primaryKeyColumns = this._schema?.columns.filter(c => c.isPrimaryKey).map(c => c.name) || []
    const canEdit = primaryKeyColumns.length > 0

    return this._getEditableGridHtml(result)

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('table.dataTitle', this._tableName)}</title>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      font-family: var(--vscode-font-family);
      padding: 16px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      margin: 0;
    }
    .toolbar {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
      align-items: center;
    }
    .toolbar-group {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .btn {
      padding: 6px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
    }
    .btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .stats {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-left: auto;
    }
    .table-container {
      overflow-x: auto;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid var(--vscode-widget-border);
      white-space: nowrap;
    }
    th {
      background: var(--vscode-editorGroupHeader-tabsBackground);
      font-weight: 600;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    th.sortable {
      cursor: pointer;
    }
    th.sortable:hover {
      background: var(--vscode-list-hoverBackground);
    }
    th .sort-icon {
      margin-left: 4px;
      opacity: 0.5;
    }
    th.sorted .sort-icon {
      opacity: 1;
    }
    tr:hover {
      background: var(--vscode-list-hoverBackground);
    }
    tr.editing {
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    tr.insert-row {
      background: var(--vscode-diffEditor-insertedTextBackground);
    }
    td {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    td.editable {
      cursor: pointer;
    }
    td.editable:hover {
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    td input, td select {
      width: 100%;
      padding: 4px 8px;
      border: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 2px;
      font-family: inherit;
      font-size: inherit;
    }
    td input:focus, td select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    .row-actions {
      display: flex;
      gap: 4px;
      min-width: 80px;
    }
    .row-actions button {
      padding: 2px 6px;
      font-size: 11px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 2px;
      cursor: pointer;
    }
    .row-actions button:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .row-actions button.delete-btn:hover {
      background: var(--vscode-inputValidation-errorBackground);
      border-color: var(--vscode-inputValidation-errorBorder);
    }
    .pagination {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 16px;
      flex-wrap: wrap;
    }
    .pagination button {
      padding: 4px 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .pagination button:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .pagination button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .page-info {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .page-size-select {
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      font-size: 12px;
    }
    .filter-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .filter-input {
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      font-size: 12px;
      min-width: 150px;
    }
    .filter-select {
      padding: 4px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      font-size: 12px;
    }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 4px;
      font-size: 13px;
      z-index: 1000;
      animation: slideIn 0.3s ease;
    }
    .toast.success {
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
      color: var(--vscode-inputValidation-infoForeground);
    }
    .toast.error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-inputValidation-errorForeground);
    }
    @keyframes slideIn {
      from {
        transform: translateX(100%);
        opacity: 0;
      }
      to {
        transform: translateX(0);
        opacity: 1;
      }
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
    .null-value {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="toolbar-group">
      <button class="btn" id="refreshBtn" title="Refresh">↻ Refresh</button>
      ${canEdit ? `<button class="btn btn-secondary" id="insertBtn" title="Insert new row">+ Insert Row</button>` : ''}
    </div>
    <div class="stats">
      ${this._totalRows.toLocaleString()} rows total · Page ${this._currentPage} of ${totalPages}
    </div>
  </div>

  <div class="filter-bar">
    <select class="filter-select" id="filterColumn">
      <option value="">Select column...</option>
      ${columns.map(c => `<option value="${c}">${c}</option>`).join('')}
    </select>
    <select class="filter-select" id="filterOperator">
      <option value="=">=</option>
      <option value="!=">!=</option>
      <option value=">">></option>
      <option value="<"><</option>
      <option value=">=">>=</option>
      <option value="<="><=</option>
      <option value="LIKE">LIKE</option>
      <option value="IS NULL">IS NULL</option>
      <option value="IS NOT NULL">IS NOT NULL</option>
    </select>
    <input type="text" class="filter-input" id="filterValue" placeholder="Filter value...">
    <button class="btn btn-secondary" id="applyFilterBtn">Apply Filter</button>
    <button class="btn btn-secondary" id="clearFilterBtn">Clear</button>
  </div>

  <div class="table-container">
    <table>
      <thead>
        <tr>
          ${canEdit ? '<th></th>' : ''}
          ${columns.map(c => {
            const isPk = primaryKeyColumns.includes(c)
            const sort = this._sorts.find(s => s.column === c)
            return `<th class="sortable ${sort ? 'sorted' : ''}" data-column="${c}">
              ${isPk ? '<span class="pk-indicator" title="Primary Key">&#128273;</span> ' : ''}${c}
              <span class="sort-icon">${sort ? (sort.direction === 'ASC' ? '▲' : '▼') : '↕'}</span>
            </th>`
          }).join('')}
        </tr>
      </thead>
      <tbody id="tableBody">
        ${canEdit ? `
        <tr class="insert-row" id="insertRow" style="display: none;">
          <td>
            <div class="row-actions">
              <button onclick="saveInsert()">Save</button>
              <button onclick="cancelInsert()">Cancel</button>
            </div>
          </td>
          ${columns.map(c => {
            const col = this._schema?.columns.find(col => col.name === c)
            return `<td><input type="text" data-column="${c}" placeholder="${col?.type || ''}" ${col?.isPrimaryKey ? 'readonly' : ''}></td>`
          }).join('')}
        </tr>
        ` : ''}
        ${rows.map((row, rowIndex) => `
        <tr data-row-index="${rowIndex}">
          ${canEdit ? `
          <td>
            <div class="row-actions">
              <button onclick="editRow(${rowIndex})">Edit</button>
              <button class="delete-btn" onclick="deleteRow(${rowIndex})">Del</button>
            </div>
          </td>
          ` : ''}
          ${columns.map(c => {
            const value = row[c]
            const displayValue = value === null || value === undefined 
              ? '<span class="null-value">NULL</span>' 
              : this._escapeHtml(String(value))
            const isPk = primaryKeyColumns.includes(c)
            return `<td class="editable" data-column="${c}" data-original="${this._escapeHtml(String(value ?? ''))}">${displayValue}</td>`
          }).join('')}
        </tr>
        `).join('')}
      </tbody>
    </table>
  </div>

  <div class="pagination">
    <button id="firstPage" ${this._currentPage === 1 ? 'disabled' : ''}>« First</button>
    <button id="prevPage" ${this._currentPage === 1 ? 'disabled' : ''}>‹ Prev</button>
    <span class="page-info">Page ${this._currentPage} of ${totalPages}</span>
    <button id="nextPage" ${this._currentPage >= totalPages ? 'disabled' : ''}>Next ›</button>
    <button id="lastPage" ${this._currentPage >= totalPages ? 'disabled' : ''}>Last »</button>
    <select class="page-size-select" id="pageSizeSelect">
      <option value="25" ${this._pageSize === 25 ? 'selected' : ''}>25 rows</option>
      <option value="50" ${this._pageSize === 50 ? 'selected' : ''}>50 rows</option>
      <option value="100" ${this._pageSize === 100 ? 'selected' : ''}>100 rows</option>
      <option value="200" ${this._pageSize === 200 ? 'selected' : ''}>200 rows</option>
    </select>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const rows = ${JSON.stringify(rows)};
    const columns = ${JSON.stringify(columns)};
    const primaryKeyColumns = ${JSON.stringify(primaryKeyColumns)};
    let editingRow = null;
    let originalRowData = null;

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    ${canEdit ? `
    document.getElementById('insertBtn').addEventListener('click', () => {
      const insertRow = document.getElementById('insertRow');
      insertRow.style.display = '';
      insertRow.querySelector('input').focus();
    });

    function saveInsert() {
      const insertRow = document.getElementById('insertRow');
      const inputs = insertRow.querySelectorAll('input');
      const row = {};
      inputs.forEach(input => {
        if (input.value) {
          row[input.dataset.column] = input.value;
        }
      });
      vscode.postMessage({ type: 'insert', row });
      cancelInsert();
    }

    function cancelInsert() {
      const insertRow = document.getElementById('insertRow');
      insertRow.style.display = 'none';
      insertRow.querySelectorAll('input').forEach(input => input.value = '');
    }

    window.saveInsert = saveInsert;
    window.cancelInsert = cancelInsert;

    function editRow(rowIndex) {
      if (editingRow !== null) {
        cancelEdit();
      }
      
      const tr = document.querySelector('tr[data-row-index="' + rowIndex + '"]');
      tr.classList.add('editing');
      editingRow = rowIndex;
      originalRowData = { ...rows[rowIndex] };
      
      const cells = tr.querySelectorAll('td.editable');
      cells.forEach(cell => {
        const column = cell.dataset.column;
        const value = originalRowData[column];
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value === null || value === undefined ? '' : String(value);
        input.dataset.column = column;
        if (primaryKeyColumns.includes(column)) {
          input.readOnly = true;
        }
        cell.textContent = '';
        cell.appendChild(input);
      });

      const actionsCell = tr.querySelector('td .row-actions');
      actionsCell.innerHTML = '<button onclick="saveEdit()">Save</button><button onclick="cancelEdit()">Cancel</button>';
    }

    function saveEdit() {
      const tr = document.querySelector('tr[data-row-index="' + editingRow + '"]');
      const inputs = tr.querySelectorAll('td.editable input');
      const row = {};
      inputs.forEach(input => {
        row[input.dataset.column] = input.value === '' ? null : input.value;
      });
      vscode.postMessage({ type: 'update', row, originalRow: originalRowData });
      cancelEdit();
    }

    function cancelEdit() {
      if (editingRow === null) return;
      const tr = document.querySelector('tr[data-row-index="' + editingRow + '"]');
      tr.classList.remove('editing');
      
      const cells = tr.querySelectorAll('td.editable');
      cells.forEach(cell => {
        const column = cell.dataset.column;
        const value = originalRowData[column];
        cell.textContent = value === null || value === undefined ? '' : String(value);
      });

      const actionsCell = tr.querySelector('td .row-actions');
      actionsCell.innerHTML = '<button onclick="editRow(' + editingRow + ')">Edit</button><button class="delete-btn" onclick="deleteRow(' + editingRow + ')">Del</button>';
      editingRow = null;
      originalRowData = null;
    }

    function deleteRow(rowIndex) {
      if (confirm('Are you sure you want to delete this row?')) {
        vscode.postMessage({ type: 'delete', row: rows[rowIndex] });
      }
    }

    window.editRow = editRow;
    window.saveEdit = saveEdit;
    window.cancelEdit = cancelEdit;
    window.deleteRow = deleteRow;
    ` : ''}

    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const column = th.dataset.column;
        const currentSort = ${JSON.stringify(this._sorts)};
        let newDirection = 'ASC';
        
        const existingSort = currentSort.find(s => s.column === column);
        if (existingSort) {
          newDirection = existingSort.direction === 'ASC' ? 'DESC' : 'ASC';
        }
        
        vscode.postMessage({ 
          type: 'sort', 
          sorts: [{ column, direction: newDirection }] 
        });
      });
    });

    document.getElementById('applyFilterBtn').addEventListener('click', () => {
      const column = document.getElementById('filterColumn').value;
      const operator = document.getElementById('filterOperator').value;
      const value = document.getElementById('filterValue').value;
      
      if (column && operator) {
        vscode.postMessage({ 
          type: 'filter', 
          filters: [{ column, operator, value }] 
        });
      }
    });

    document.getElementById('clearFilterBtn').addEventListener('click', () => {
      document.getElementById('filterColumn').value = '';
      document.getElementById('filterValue').value = '';
      vscode.postMessage({ type: 'filter', filters: [] });
    });

    document.getElementById('firstPage').addEventListener('click', () => {
      vscode.postMessage({ type: 'pageChange', page: 1 });
    });

    document.getElementById('prevPage').addEventListener('click', () => {
      vscode.postMessage({ type: 'pageChange', page: ${this._currentPage} - 1 });
    });

    document.getElementById('nextPage').addEventListener('click', () => {
      vscode.postMessage({ type: 'pageChange', page: ${this._currentPage} + 1 });
    });

    document.getElementById('lastPage').addEventListener('click', () => {
      vscode.postMessage({ type: 'pageChange', page: ${totalPages} });
    });

    document.getElementById('pageSizeSelect').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'pageSizeChange', pageSize: parseInt(e.target.value) });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'operationSuccess':
          showToast(message.message, 'success');
          break;
        case 'operationError':
          showToast(message.error, 'error');
          break;
      }
    });

    function showToast(message, type) {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
  </script>
</body>
</html>`
  }

  private _getLegacyEditableGridHtml(
    _result: QueryResult,
    columns: string[],
    rows: Record<string, unknown>[],
    primaryKeyColumns: string[],
    canEdit: boolean
  ): string {
    const totalPages = Math.max(1, Math.ceil(this._totalRows / this._pageSize))
    const colgroup = [
      canEdit ? '<col style="width: 54px">' : '',
      ...columns.map(column => `<col data-column="${this._escapeAttr(column)}" style="width: 180px">`)
    ].join('')
    const headerCells = columns.map(column => {
      const sort = this._sorts.find(item => item.column === column)
      const sortText = sort ? sort.direction : ''
      const pk = primaryKeyColumns.includes(column) ? '<span class="pk-indicator" title="Primary Key">&#128273; PK</span> ' : ''
      return `<th class="sortable" data-column="${this._escapeAttr(column)}">
        <div class="th-content"><span>${pk}${this._escapeHtml(column)}</span><span class="sort-icon">${sortText}</span></div>
        <span class="column-resize-handle" title="Resize column"></span>
      </th>`
    }).join('')
    const rowHtml = rows.map((row, rowIndex) => `
      <tr data-row-index="${rowIndex}">
        ${canEdit ? '<td class="row-marker"></td>' : ''}
        ${columns.map((column, columnIndex) => {
          const value = row[column]
          const rawValue = value === null || value === undefined ? '' : String(value)
          const displayValue = value === null || value === undefined
            ? '<span class="cell-value null-value">NULL</span>'
            : `<span class="cell-value">${this._escapeHtml(rawValue)}</span>`
          const editable = canEdit && !primaryKeyColumns.includes(column)
          return `<td class="${editable ? 'editable' : ''}" data-column="${this._escapeAttr(column)}" data-raw="${this._escapeAttr(rawValue)}" tabindex="0">
            ${displayValue}
            ${columnIndex === 0 ? '<span class="row-resize-handle" title="Resize row"></span>' : ''}
          </td>`
        }).join('')}
      </tr>
    `).join('')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('table.dataTitle', this._tableName)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      height: 100vh;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr) auto auto;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-size: 13px;
    }
    .toolbar, .filter-bar, .pagination, .commit-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding: 9px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .toolbar, .commit-bar { background: var(--vscode-editorGroupHeader-tabsBackground); }
    .pagination, .commit-bar { border-top: 1px solid var(--vscode-panel-border); border-bottom: 0; }
    .stats, .commit-status, .page-info {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .stats { margin-left: auto; }
    .commit-status { margin-right: auto; }
    .btn {
      padding: 5px 10px;
      border: 0;
      border-radius: 4px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font: inherit;
      cursor: pointer;
    }
    .btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .btn:disabled {
      opacity: .45;
      cursor: not-allowed;
    }
    .icon-btn {
      min-width: 34px;
      height: 28px;
      padding: 0 9px;
      font-size: 14px;
      line-height: 28px;
    }
    .filter-input, .filter-select, .page-size-select {
      padding: 4px 8px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: inherit;
      font-size: 12px;
    }
    .filter-input { min-width: 150px; }
    .table-container {
      min-height: 0;
      overflow: auto;
    }
    table {
      width: max-content;
      min-width: 100%;
      table-layout: fixed;
      border-collapse: collapse;
    }
    th, td {
      position: relative;
      height: 32px;
      min-height: 24px;
      padding: 6px 10px;
      border: 1px solid var(--vscode-widget-border);
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--vscode-editorGroupHeader-tabsBackground);
      font-weight: 600;
    }
    .th-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    th.sortable { cursor: pointer; }
    th.sortable:hover, tr:hover { background: var(--vscode-list-hoverBackground); }
    .sort-icon {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
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
    .row-marker {
      color: var(--vscode-descriptionForeground);
      text-align: center;
    }
    tr.dirty-row { background: var(--vscode-editor-inactiveSelectionBackground); }
    tr.dirty-row .row-marker::before { content: "*"; }
    td.editable { cursor: text; }
    td.editable:hover { background: var(--vscode-editor-inactiveSelectionBackground); }
    td.dirty-cell {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    td.cell-editing {
      padding: 0;
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    td input {
      width: 100%;
      height: 100%;
      min-height: 30px;
      padding: 5px 9px;
      border: 0;
      outline: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font: inherit;
    }
    .null-value {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .column-resize-handle {
      position: absolute;
      top: 0;
      right: -3px;
      width: 7px;
      height: 100%;
      cursor: col-resize;
      z-index: 3;
    }
    .row-resize-handle {
      position: absolute;
      left: 0;
      bottom: -3px;
      width: 100%;
      height: 7px;
      cursor: row-resize;
      z-index: 2;
    }
    .toast {
      position: fixed;
      right: 16px;
      bottom: 52px;
      z-index: 10;
      padding: 10px 14px;
      border-radius: 4px;
      background: var(--vscode-inputValidation-infoBackground);
      border: 1px solid var(--vscode-inputValidation-infoBorder);
    }
    .toast.error {
      background: var(--vscode-inputValidation-errorBackground);
      border-color: var(--vscode-inputValidation-errorBorder);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="btn" id="refreshBtn">Refresh</button>
    <div class="stats">
      ${this._totalRows.toLocaleString()} rows total - Page ${this._currentPage} of ${totalPages}
      ${canEdit ? '' : ` - ${this._escapeHtml(t('table.primaryKeyRequiredForEdit'))}`}
    </div>
  </div>

  <div class="filter-bar">
    <select class="filter-select" id="filterColumn">
      <option value="">Select column...</option>
      ${columns.map(c => `<option value="${this._escapeAttr(c)}">${this._escapeHtml(c)}</option>`).join('')}
    </select>
    <select class="filter-select" id="filterOperator">
      <option value="=">=</option>
      <option value="!=">!=</option>
      <option value=">">&gt;</option>
      <option value="<">&lt;</option>
      <option value=">=">&gt;=</option>
      <option value="<=">&lt;=</option>
      <option value="LIKE">LIKE</option>
      <option value="IS NULL">IS NULL</option>
      <option value="IS NOT NULL">IS NOT NULL</option>
    </select>
    <input type="text" class="filter-input" id="filterValue" placeholder="Filter value...">
    <button class="btn btn-secondary" id="applyFilterBtn">Apply Filter</button>
    <button class="btn btn-secondary" id="clearFilterBtn">Clear</button>
  </div>

  <div class="table-container">
    <table>
      <colgroup>${colgroup}</colgroup>
      <thead>
        <tr>
          ${canEdit ? '<th></th>' : ''}
          ${headerCells}
        </tr>
      </thead>
      <tbody>${rowHtml}</tbody>
    </table>
  </div>

  <div class="pagination">
    <button id="firstPage" ${this._currentPage === 1 ? 'disabled' : ''}>First</button>
    <button id="prevPage" ${this._currentPage === 1 ? 'disabled' : ''}>Prev</button>
    <span class="page-info">Page ${this._currentPage} of ${totalPages}</span>
    <button id="nextPage" ${this._currentPage >= totalPages ? 'disabled' : ''}>Next</button>
    <button id="lastPage" ${this._currentPage >= totalPages ? 'disabled' : ''}>Last</button>
    <select class="page-size-select" id="pageSizeSelect">
      <option value="25" ${this._pageSize === 25 ? 'selected' : ''}>25 rows</option>
      <option value="50" ${this._pageSize === 50 ? 'selected' : ''}>50 rows</option>
      <option value="100" ${this._pageSize === 100 ? 'selected' : ''}>100 rows</option>
      <option value="200" ${this._pageSize === 200 ? 'selected' : ''}>200 rows</option>
    </select>
  </div>

  <div class="commit-bar">
    <span class="commit-status" id="pendingStatus">${this._escapeHtml(t('table.noPendingChanges'))}</span>
    <button class="btn icon-btn" id="commitChanges" title="${this._escapeAttr(t('table.commitChanges'))}" disabled>&#10003;</button>
    <button class="btn btn-secondary icon-btn" id="revertChanges" title="${this._escapeAttr(t('table.revertChanges'))}" disabled>&#8634;</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const rows = ${this._escapeScriptJson(JSON.stringify(rows))};
    const primaryKeyColumns = ${this._escapeScriptJson(JSON.stringify(primaryKeyColumns))};
    const pendingTemplate = ${this._escapeScriptJson(JSON.stringify(t('table.pendingChanges')))};
    const noPendingText = ${this._escapeScriptJson(JSON.stringify(t('table.noPendingChanges')))};
    const parsedTimeLabel = ${this._escapeScriptJson(JSON.stringify(t('table.parsedTime')))};
    const pendingUpdates = new Map();
    let activeEditor = null;

    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });

    function cellDisplay(value) {
      return value === null || value === undefined ? 'NULL' : String(value);
    }

    function renderCell(cell, value) {
      const hasHandle = cell.querySelector('.row-resize-handle') !== null;
      cell.classList.remove('cell-editing');
      cell.innerHTML = '<span class="cell-value"></span>' + (hasHandle ? '<span class="row-resize-handle" title="Resize row"></span>' : '');
      const span = cell.querySelector('.cell-value');
      if (value === null || value === undefined) {
        span.classList.add('null-value');
      }
      span.textContent = cellDisplay(value);
      cell.dataset.raw = value === null || value === undefined ? '' : String(value);
    }

    function beginCellEdit(cell) {
      if (!cell.classList.contains('editable') || activeEditor) return;
      const rowIndex = Number(cell.closest('tr').dataset.rowIndex);
      const column = cell.dataset.column;
      const current = pendingUpdates.get(rowIndex)?.row[column] ?? rows[rowIndex][column];
      const input = document.createElement('input');
      input.value = current === null || current === undefined ? '' : String(current);
      cell.classList.add('cell-editing');
      cell.textContent = '';
      cell.appendChild(input);
      activeEditor = { cell, input, rowIndex, column };
      input.focus();
      input.select();
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') finishCellEdit(true);
        if (event.key === 'Escape') finishCellEdit(false);
        event.stopPropagation();
      });
      input.addEventListener('blur', () => finishCellEdit(true));
    }

    function finishCellEdit(save) {
      if (!activeEditor) return;
      const { cell, input, rowIndex, column } = activeEditor;
      activeEditor = null;
      const pending = pendingUpdates.get(rowIndex);
      const previous = pending?.row[column] ?? rows[rowIndex][column];
      const next = input.value;
      renderCell(cell, save ? next : previous);
      if (save && String(previous ?? '') !== String(next ?? '')) {
        const update = pending || { originalRow: { ...rows[rowIndex] }, row: { ...rows[rowIndex] } };
        update.row[column] = next;
        pendingUpdates.set(rowIndex, update);
        markDirty(rowIndex);
      }
      updatePendingState();
    }

    function markDirty(rowIndex) {
      const tr = document.querySelector('tr[data-row-index="' + rowIndex + '"]');
      const pending = pendingUpdates.get(rowIndex);
      if (!tr || !pending) return;
      tr.classList.add('dirty-row');
      tr.querySelectorAll('td.editable').forEach(cell => {
        const column = cell.dataset.column;
        cell.classList.toggle('dirty-cell', String(pending.originalRow[column] ?? '') !== String(pending.row[column] ?? ''));
      });
    }

    function updatePendingState() {
      const count = pendingUpdates.size;
      document.getElementById('pendingStatus').textContent = count === 0 ? noPendingText : pendingTemplate.replace('{0}', String(count));
      document.getElementById('commitChanges').disabled = count === 0;
      document.getElementById('revertChanges').disabled = count === 0;
    }

    function commitChanges() {
      finishCellEdit(true);
      const changes = Array.from(pendingUpdates.values());
      if (changes.length === 0) return;
      vscode.postMessage({ type: 'commitChanges', changes });
    }

    function revertChanges() {
      finishCellEdit(false);
      pendingUpdates.clear();
      document.querySelectorAll('tr[data-row-index]').forEach(tr => {
        const rowIndex = Number(tr.dataset.rowIndex);
        tr.classList.remove('dirty-row');
        tr.querySelectorAll('td.editable').forEach(cell => {
          cell.classList.remove('dirty-cell');
          renderCell(cell, rows[rowIndex][cell.dataset.column]);
        });
      });
      updatePendingState();
    }

    document.querySelectorAll('td.editable').forEach(cell => {
      cell.addEventListener('dblclick', () => beginCellEdit(cell));
      cell.addEventListener('keydown', event => {
        if (event.key === 'Enter') beginCellEdit(cell);
      });
    });

    document.getElementById('commitChanges').addEventListener('click', commitChanges);
    document.getElementById('revertChanges').addEventListener('click', revertChanges);
    window.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        commitChanges();
      }
    });

    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', event => {
        if (event.target.classList.contains('column-resize-handle')) return;
        const column = th.dataset.column;
        const currentSort = ${this._escapeScriptJson(JSON.stringify(this._sorts))};
        const existingSort = currentSort.find(item => item.column === column);
        vscode.postMessage({
          type: 'sort',
          sorts: [{ column, direction: existingSort?.direction === 'ASC' ? 'DESC' : 'ASC' }]
        });
      });
    });

    document.querySelectorAll('td[data-raw]').forEach(cell => {
      cell.addEventListener('mouseenter', () => {
        const parsed = parseTemporalValue(cell.dataset.raw);
        if (parsed) cell.title = parsed;
      });
    });

    function parseTemporalValue(raw) {
      if (!raw || !/\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|T\\d{2}:\\d{2}:\\d{2}|\\d{2}:\\d{2}:\\d{2}/.test(raw)) return '';
      const date = new Date(raw.includes(' ') ? raw.replace(' ', 'T') : raw);
      if (Number.isNaN(date.getTime())) return '';
      return parsedTimeLabel + ': ' + date.toLocaleString() + ' | ISO: ' + date.toISOString();
    }

    document.querySelectorAll('.column-resize-handle').forEach(handle => {
      handle.addEventListener('mousedown', event => {
        event.preventDefault();
        event.stopPropagation();
        const th = handle.closest('th');
        const col = document.querySelector('col[data-column="' + CSS.escape(th.dataset.column) + '"]');
        const startX = event.clientX;
        const startWidth = th.offsetWidth;
        function onMouseMove(moveEvent) {
          col.style.width = Math.max(72, startWidth + moveEvent.clientX - startX) + 'px';
        }
        function onMouseUp() {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        }
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });

    document.addEventListener('mousedown', event => {
      if (!event.target.classList.contains('row-resize-handle')) return;
      event.preventDefault();
      const tr = event.target.closest('tr');
      const startY = event.clientY;
      const startHeight = tr.offsetHeight;
      function onMouseMove(moveEvent) {
        tr.style.height = Math.max(24, startHeight + moveEvent.clientY - startY) + 'px';
      }
      function onMouseUp() {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    document.getElementById('applyFilterBtn').addEventListener('click', () => {
      const column = document.getElementById('filterColumn').value;
      const operator = document.getElementById('filterOperator').value;
      const value = document.getElementById('filterValue').value;
      if (column && operator) {
        vscode.postMessage({ type: 'filter', filters: [{ column, operator, value }] });
      }
    });
    document.getElementById('clearFilterBtn').addEventListener('click', () => {
      document.getElementById('filterColumn').value = '';
      document.getElementById('filterValue').value = '';
      vscode.postMessage({ type: 'filter', filters: [] });
    });
    document.getElementById('firstPage').addEventListener('click', () => vscode.postMessage({ type: 'pageChange', page: 1 }));
    document.getElementById('prevPage').addEventListener('click', () => vscode.postMessage({ type: 'pageChange', page: ${this._currentPage - 1} }));
    document.getElementById('nextPage').addEventListener('click', () => vscode.postMessage({ type: 'pageChange', page: ${this._currentPage + 1} }));
    document.getElementById('lastPage').addEventListener('click', () => vscode.postMessage({ type: 'pageChange', page: ${totalPages} }));
    document.getElementById('pageSizeSelect').addEventListener('change', event => {
      vscode.postMessage({ type: 'pageSizeChange', pageSize: parseInt(event.target.value, 10) });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'operationSuccess') {
        pendingUpdates.clear();
        updatePendingState();
        showToast(message.message, 'success');
      }
      if (message.type === 'operationError') {
        showToast(message.error, 'error');
      }
    });
    function showToast(message, type) {
      const toast = document.createElement('div');
      toast.className = 'toast ' + (type || '');
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3200);
    }
  </script>
</body>
</html>`
  }

  private _escapeHtml(text: string): string {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  private _escapeAttr(text: string): string {
    return this._escapeHtml(text).replace(/`/g, '&#096;')
  }

  private _escapeScriptJson(json: string): string {
    return json
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
  }

  private dispose(panelAlreadyDisposed = false): void {
    if (this._disposed) {
      return
    }

    this._disposed = true
    if (TableDataPanel.currentPanel === this) {
      TableDataPanel.currentPanel = undefined
    }

    if (!panelAlreadyDisposed) {
      this._panel.dispose()
    }

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }
}
