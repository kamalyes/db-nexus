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
  private _pageSize: number = 50
  private _totalRows: number = 0
  private _filters: { column: string; operator: string; value: string }[] = []
  private _sorts: { column: string; direction: 'ASC' | 'DESC' }[] = []

  static show(
    context: ExtensionContext,
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    tableName: string,
    scope: SchemaScope
  ): void {
    const column = ViewColumn.One

    if (TableDataPanel.currentPanel) {
      TableDataPanel.currentPanel._panel.dispose()
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

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    this._panel.webview.onDidReceiveMessage(
      async message => {
        switch (message.type) {
          case 'ready':
            await this._loadData()
            break
          case 'refresh':
            await this._loadData()
            break
          case 'pageChange':
            this._currentPage = message.page
            await this._loadData()
            break
          case 'pageSizeChange':
            this._pageSize = message.pageSize
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
        }
      },
      null,
      this._disposables
    )
  }

  private async _loadData(): Promise<void> {
    try {
      if (!this._schema && this._driver.getTableSchema) {
        this._schema = await this._driver.getTableSchema(
          this._profile,
          this._tableName,
          this._scope
        )
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

      this._totalRows = result.totalRows || result.rowCount

      this._panel.webview.html = this._getHtml(result)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this._panel.webview.html = this._getErrorHtml(message)
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

  private async _handleDelete(row: Record<string, unknown>): Promise<void> {
    try {
      if (!this._driver.planDelete || !this._driver.executeMutation) {
        throw new Error('Driver does not support delete')
      }

      const plan = await this._driver.planDelete(
        this._profile,
        this._tableName,
        row,
        this._scope
      )

      const result = await this._driver.executeMutation(this._profile, plan)
      if (result.success) {
        this._sendMessage({ type: 'operationSuccess', message: `Deleted ${result.affectedRows} row(s)` })
        await this._loadData()
      } else {
        this._sendMessage({ type: 'operationError', error: result.error || 'Unknown error' })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      this._sendMessage({ type: 'operationError', error: message })
    }
  }

  private _sendMessage(message: any): void {
    this._panel.webview.postMessage(message)
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
  <button class="retry-btn" onclick="retry()">${t('common.retry') || 'Retry'}</button>
  <script>
    const vscode = acquireVsCodeApi();
    function retry() {
      vscode.postMessage({ type: 'refresh' });
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
      color: var(--vscode-textLink-foreground);
      font-weight: bold;
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
              ${isPk ? '<span class="pk-indicator" title="Primary Key">🔑</span> ' : ''}${c}
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

  private _escapeHtml(text: string): string {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  private dispose(): void {
    TableDataPanel.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }
}
