import * as path from 'path'
import { TreeItem, TreeItemCollapsibleState, Uri, ExtensionContext } from 'vscode'
import { DbConnectionProfile, SchemaScope, TableColumn, TableIndex, TableForeignKey } from '@/core/types'

export type FieldConstraintType = 'primary' | 'foreign' | 'unique' | 'notnull' | 'null'

export class FieldNode {
  constructor(
    public readonly connectionProfile: DbConnectionProfile,
    public readonly tableName: string,
    public readonly column: TableColumn,
    public readonly indexes: TableIndex[],
    public readonly foreignKeys: TableForeignKey[],
    public readonly scope: SchemaScope = {}
  ) {}

  getTreeItem(context: ExtensionContext): TreeItem {
    const label = `${this.column.name}: ${this.column.type}`
    const item = new TreeItem(label, TreeItemCollapsibleState.None)
    item.tooltip = this.getTooltip()
    item.iconPath = this.getFieldIcon(context)
    item.contextValue = 'field'
    return item
  }

  private getTooltip(): string {
    const parts: string[] = [
      this.column.name,
      this.column.type
    ]
    
    if (this.column.isPrimaryKey) {
      parts.push('PRIMARY KEY')
    }
    if (this.isForeignKey()) {
      parts.push('FOREIGN KEY')
    }
    if (this.isUnique()) {
      parts.push('UNIQUE')
    }
    if (this.column.nullable) {
      parts.push('NULL')
    } else {
      parts.push('NOT NULL')
    }
    if (this.column.defaultValue !== undefined && this.column.defaultValue !== null) {
      parts.push(`DEFAULT: ${this.column.defaultValue}`)
    }
    
    return parts.join('\n')
  }

  private getFieldIcon(context: ExtensionContext): { dark: Uri; light: Uri } {
    const constraintType = this.getConstraintType()
    return this.getIconUri(context, constraintType)
  }

  isForeignKey(): boolean {
    return this.foreignKeys.some(fk => 
      fk.columns.includes(this.column.name)
    )
  }

  isUnique(): boolean {
    return this.indexes.some(idx => 
      idx.isUnique && !idx.isPrimary && idx.columns.includes(this.column.name)
    )
  }

  getConstraintType(): FieldConstraintType {
    if (this.column.isPrimaryKey) {
      return 'primary'
    }
    if (this.isForeignKey()) {
      return 'foreign'
    }
    if (this.isUnique()) {
      return 'unique'
    }
    if (!this.column.nullable) {
      return 'notnull'
    }
    return 'null'
  }

  private getIconUri(context: ExtensionContext, type: FieldConstraintType): { dark: Uri; light: Uri } {
    return {
      dark: Uri.file(path.join(context.extensionPath, 'resources', 'icons', 'dark', `${type}.svg`)),
      light: Uri.file(path.join(context.extensionPath, 'resources', 'icons', 'light', `${type}.svg`))
    }
  }
}

export class IconHelper {
  static getIconUri(context: ExtensionContext, name: string): { dark: Uri; light: Uri } {
    return {
      dark: Uri.file(path.join(context.extensionPath, 'resources', 'icons', 'dark', `${name}.svg`)),
      light: Uri.file(path.join(context.extensionPath, 'resources', 'icons', 'light', `${name}.svg`))
    }
  }
}
