import { ExtensionContext, ViewColumn, WebviewPanel, window } from 'vscode'
import { ExecutionPlan, ExecutionPlanNode } from '@/core/types'
import { t } from '@/i18n'

export class ExecutionPlanPanel {
  private static currentPanel: ExecutionPlanPanel | undefined
  private readonly _panel: WebviewPanel
  private _disposables: any[] = []

  static show(context: ExtensionContext, plan: ExecutionPlan, sql: string): void {
    const column = ViewColumn.Beside

    if (ExecutionPlanPanel.currentPanel) {
      ExecutionPlanPanel.currentPanel._panel.webview.postMessage({
        type: 'update',
        plan,
        sql
      })
      ExecutionPlanPanel.currentPanel._panel.reveal(column)
      return
    }

    const panel = window.createWebviewPanel(
      'dbNexus.executionPlan',
      t('executionPlan.title'),
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    )

    ExecutionPlanPanel.currentPanel = new ExecutionPlanPanel(panel, context, plan, sql)
  }

  private constructor(
    panel: WebviewPanel,
    context: ExtensionContext,
    plan: ExecutionPlan,
    sql: string
  ) {
    this._panel = panel

    this._panel.webview.html = this._getHtml(plan, sql)

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables)

    this._panel.webview.onDidReceiveMessage(
      message => {
        switch (message.type) {
          case 'close':
            this._panel.dispose()
            break
        }
      },
      null,
      this._disposables
    )
  }

  private _getHtml(plan: ExecutionPlan, sql: string): string {
    const planTree = this._renderPlanTree(plan.nodes)

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('executionPlan.title')}</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 16px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }
    .sql-preview {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 16px;
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .plan-summary {
      display: flex;
      gap: 24px;
      margin-bottom: 16px;
      padding: 12px;
      background: var(--vscode-input-background);
      border-radius: 4px;
    }
    .plan-summary-item {
      display: flex;
      flex-direction: column;
    }
    .plan-summary-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    .plan-summary-value {
      font-size: 18px;
      font-weight: 600;
    }
    .plan-tree {
      font-family: var(--vscode-editor-font-family);
    }
    .plan-node {
      margin-left: 20px;
      border-left: 1px solid var(--vscode-widget-border);
      padding-left: 12px;
    }
    .plan-node-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-input-background);
      border-radius: 4px;
      margin-bottom: 8px;
      cursor: pointer;
    }
    .plan-node-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .plan-node-type {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
    }
    .plan-node-cost {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .plan-node-details {
      display: none;
      padding: 8px 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      margin-bottom: 8px;
      font-size: 12px;
    }
    .plan-node-details.visible {
      display: block;
    }
    .plan-node-detail-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .plan-node-detail-label {
      color: var(--vscode-descriptionForeground);
    }
    .expand-icon {
      transition: transform 0.2s;
    }
    .expand-icon.expanded {
      transform: rotate(90deg);
    }
  </style>
</head>
<body>
  <h2>${t('executionPlan.title')}</h2>
  
  <div class="sql-preview">${this._escapeHtml(sql)}</div>
  
  <div class="plan-summary">
    <div class="plan-summary-item">
      <span class="plan-summary-label">${t('executionPlan.totalCost')}</span>
      <span class="plan-summary-value">${plan.totalCost?.toFixed(2) || 'N/A'}</span>
    </div>
    <div class="plan-summary-item">
      <span class="plan-summary-label">${t('executionPlan.estimatedRows')}</span>
      <span class="plan-summary-value">${plan.totalRows?.toLocaleString() || 'N/A'}</span>
    </div>
    ${plan.executionTime ? `
    <div class="plan-summary-item">
      <span class="plan-summary-label">${t('executionPlan.executionTime')}</span>
      <span class="plan-summary-value">${plan.executionTime.toFixed(2)} ms</span>
    </div>
    ` : ''}
  </div>
  
  <div class="plan-tree">
    ${planTree}
  </div>
  
  <script>
    document.querySelectorAll('.plan-node-header').forEach(header => {
      header.addEventListener('click', () => {
        const details = header.nextElementSibling;
        const icon = header.querySelector('.expand-icon');
        if (details) {
          details.classList.toggle('visible');
          icon.classList.toggle('expanded');
        }
      });
    });
  </script>
</body>
</html>`
  }

  private _renderPlanTree(nodes: ExecutionPlanNode[], level: number = 0): string {
    return nodes.map(node => this._renderNode(node, level)).join('')
  }

  private _renderNode(node: ExecutionPlanNode, level: number): string {
    const hasChildren = node.children && node.children.length > 0
    const details = Object.entries(node.details || {})
      .filter(([key]) => !['Node Type', 'Plans', 'Total Cost', 'Plan Rows'].includes(key))

    return `
    <div class="plan-node" style="margin-left: ${level * 20}px">
      <div class="plan-node-header">
        <span class="expand-icon ${details.length > 0 ? '' : 'expanded'}">▶</span>
        <span class="plan-node-type">${this._escapeHtml(node.type)}</span>
        ${node.cost !== undefined ? `<span class="plan-node-cost">cost: ${node.cost.toFixed(2)}</span>` : ''}
        ${node.rows !== undefined ? `<span class="plan-node-cost">rows: ${node.rows.toLocaleString()}</span>` : ''}
      </div>
      ${details.length > 0 ? `
      <div class="plan-node-details">
        ${details.map(([key, value]) => `
          <div class="plan-node-detail-row">
            <span class="plan-node-detail-label">${this._escapeHtml(key)}:</span>
            <span>${this._escapeHtml(String(value))}</span>
          </div>
        `).join('')}
      </div>
      ` : ''}
      ${hasChildren ? this._renderPlanTree(node.children!, level + 1) : ''}
    </div>`
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
    ExecutionPlanPanel.currentPanel = undefined

    this._panel.dispose()

    while (this._disposables.length) {
      const x = this._disposables.pop()
      if (x) {
        x.dispose()
      }
    }
  }
}
