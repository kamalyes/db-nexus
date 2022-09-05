import { ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode'
import { DbConnectionProfile, SchemaScope, TableSchema, TableForeignKey } from '@/core/types'
import { DatabaseDriver } from '@/drivers/base'
import { t } from '@/i18n'

interface TableInfo {
  name: string
  schema: TableSchema
}

export class ERDiagramPanel {
  private static currentPanel: ERDiagramPanel | undefined
  private readonly _panel: WebviewPanel
  private _disposables: any[] = []

  static async show(
    context: ExtensionContext,
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    scope: SchemaScope
  ): Promise<void> {
    if (!driver.getTableSchema) {
      window.showErrorMessage(t('erd.notSupported'))
      return
    }

    const column = ViewColumn.Beside

    if (ERDiagramPanel.currentPanel) {
      ERDiagramPanel.currentPanel._panel.dispose()
    }

    const panel = window.createWebviewPanel(
      'dbNexus.erDiagram',
      t('erd.title'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    const tables = await ERDiagramPanel._loadTables(profile, driver, scope)
    ERDiagramPanel.currentPanel = new ERDiagramPanel(panel, tables)
  }

  private static async _loadTables(
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    scope: SchemaScope
  ): Promise<TableInfo[]> {
    const tables: TableInfo[] = []
    
    const objects = await driver.listObjects(profile, scope)
    const tableObjects = objects.filter(obj => obj.type === 'table')

    for (const tableObj of tableObjects) {
      try {
        const schema = await driver.getTableSchema!(profile, tableObj.name, scope)
        tables.push({
          name: tableObj.name,
          schema
        })
      } catch (error) {
        console.error(`Failed to load schema for table ${tableObj.name}:`, error)
      }
    }

    return tables
  }

  private constructor(panel: WebviewPanel, tables: TableInfo[]) {
    this._panel = panel

    this._panel.webview.html = this._getHtml(tables)

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)
  }

  private _getHtml(tables: TableInfo[]): string {
    const mermaidCode = this._generateMermaidERD(tables)

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('erd.title')}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
  <style>
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
    .mermaid-container {
      background: var(--vscode-editor-background);
      padding: 20px;
      border-radius: 8px;
      overflow: auto;
    }
    .mermaid {
      display: flex;
      justify-content: center;
    }
    .code-section {
      margin-top: 16px;
      display: none;
    }
    .code-section.visible {
      display: block;
    }
    .code-block {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      overflow-x: auto;
      white-space: pre;
    }
    .stats {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <h2>${t('erd.title')}</h2>
  
  <div class="stats">
    ${tables.length} tables loaded
  </div>

  <div class="toolbar">
    <button class="btn btn-secondary" onclick="toggleCode()">Show/Hide Mermaid Code</button>
    <button class="btn btn-secondary" onclick="copyCode()">Copy Code</button>
    <button class="btn" onclick="downloadSVG()">Download SVG</button>
  </div>

  <div class="mermaid-container">
    <div class="mermaid" id="erd">
${mermaidCode}
    </div>
  </div>

  <div class="code-section" id="codeSection">
    <h3>Mermaid Code</h3>
    <div class="code-block" id="mermaidCode">${this._escapeHtml(mermaidCode)}</div>
  </div>

  <script>
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      er: {
        useMaxWidth: false
      }
    });

    function toggleCode() {
      const codeSection = document.getElementById('codeSection');
      codeSection.classList.toggle('visible');
    }

    function copyCode() {
      const code = document.getElementById('mermaidCode').textContent;
      navigator.clipboard.writeText(code).then(() => {
        alert('Code copied to clipboard!');
      });
    }

    function downloadSVG() {
      const svg = document.querySelector('.mermaid svg');
      if (!svg) {
        alert('SVG not found');
        return;
      }
      
      const svgData = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = 'er-diagram.svg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  </script>
</body>
</html>`
  }

  private _generateMermaidERD(tables: TableInfo[]): string {
    const lines: string[] = ['erDiagram']

    for (const table of tables) {
      const tableName = this._sanitizeName(table.name)
      const fkColumns = new Set<string>()
      
      if (table.schema.foreignKeys) {
        for (const fk of table.schema.foreignKeys) {
          for (const col of fk.columns) {
            fkColumns.add(col)
          }
        }
      }
      
      for (const column of table.schema.columns) {
        const columnName = this._sanitizeName(column.name)
        const columnType = this._sanitizeType(column.type)
        const pk = column.isPrimaryKey ? ' PK' : ''
        const fk = fkColumns.has(column.name) ? ' FK' : ''
        
        lines.push(`    ${tableName} {`)
        lines.push(`        ${columnType} ${columnName}${pk}${fk}`)
        lines.push(`    }`)
      }
    }

    const addedRelationships = new Set<string>()
    
    for (const table of tables) {
      if (!table.schema.foreignKeys) continue
      
      for (const fk of table.schema.foreignKeys) {
        const fromTable = this._sanitizeName(table.name)
        const toTable = this._sanitizeName(fk.referencedTable)
        
        if (fromTable === toTable) continue
        
        const relationshipKey = `${fromTable}-${toTable}`
        if (addedRelationships.has(relationshipKey)) continue
        addedRelationships.add(relationshipKey)
        
        const relationship = this._getRelationshipSymbol(fk)
        lines.push(`    ${fromTable} ${relationship} ${toTable} : "references"`)
      }
    }

    return lines.join('\n')
  }

  private _sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_')
  }

  private _sanitizeType(type: string): string {
    const typeMap: Record<string, string> = {
      'varchar': 'VARCHAR',
      'character varying': 'VARCHAR',
      'int': 'INT',
      'integer': 'INT',
      'bigint': 'BIGINT',
      'smallint': 'SMALLINT',
      'decimal': 'DECIMAL',
      'numeric': 'NUMERIC',
      'float': 'FLOAT',
      'double precision': 'DOUBLE',
      'boolean': 'BOOLEAN',
      'bool': 'BOOLEAN',
      'date': 'DATE',
      'timestamp': 'TIMESTAMP',
      'timestamp without time zone': 'TIMESTAMP',
      'timestamp with time zone': 'TIMESTAMPTZ',
      'time': 'TIME',
      'text': 'TEXT',
      'json': 'JSON',
      'jsonb': 'JSONB',
      'uuid': 'UUID',
      'bytea': 'BLOB',
      'blob': 'BLOB'
    }

    const normalizedType = type.toLowerCase().trim()
    return typeMap[normalizedType] || type.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  }

  private _getRelationshipSymbol(fk: TableForeignKey): string {
    if (fk.onDelete === 'CASCADE' || fk.onDelete === 'SET NULL') {
      return '}o--||'
    }
    return '}o--||'
  }

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  private dispose(): void {
    ERDiagramPanel.currentPanel = undefined
    this._panel.dispose()
    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }
}
