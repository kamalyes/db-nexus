import { FileType, Uri, workspace } from 'vscode'
import { DbConnectionProfile, SchemaScope } from '@/core/types'

export interface StoredQueryFile {
  name: string
  uri: Uri
}

export class QueryFileService {
  constructor(private readonly storageRoot: Uri) {}

  async list(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): Promise<StoredQueryFile[]> {
    const folderUri = this.getFolderUri(profile, tableName, scope)

    try {
      const entries = await workspace.fs.readDirectory(folderUri)
      return entries
        .filter(([name, type]) => type === FileType.File && name.toLowerCase().endsWith('.sql'))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name]) => ({
          name,
          uri: Uri.joinPath(folderUri, name)
        }))
    } catch {
      return []
    }
  }

  async create(
    profile: DbConnectionProfile,
    tableName: string,
    scope: SchemaScope,
    fileName: string,
    content: string
  ): Promise<StoredQueryFile> {
    const folderUri = this.getFolderUri(profile, tableName, scope)
    await workspace.fs.createDirectory(folderUri)

    const name = await this.getAvailableName(folderUri, this.normalizeFileName(fileName))
    const uri = Uri.joinPath(folderUri, name)
    await workspace.fs.writeFile(uri, new TextEncoder().encode(content.endsWith('\n') ? content : `${content}\n`))
    return { name, uri }
  }

  async importFile(
    profile: DbConnectionProfile,
    tableName: string,
    scope: SchemaScope,
    sourceUri: Uri
  ): Promise<StoredQueryFile> {
    const folderUri = this.getFolderUri(profile, tableName, scope)
    await workspace.fs.createDirectory(folderUri)

    const name = await this.getAvailableName(folderUri, this.normalizeFileName(this.getFileName(sourceUri)))
    const uri = Uri.joinPath(folderUri, name)
    await workspace.fs.copy(sourceUri, uri, { overwrite: false })
    return { name, uri }
  }

  async delete(uri: Uri): Promise<void> {
    await workspace.fs.delete(uri, { recursive: false, useTrash: true })
  }

  private getFolderUri(profile: DbConnectionProfile, tableName: string, scope: SchemaScope): Uri {
    return Uri.joinPath(
      this.storageRoot,
      this.sanitizePathPart(profile.id || profile.name),
      this.sanitizePathPart(scope.database || '_default'),
      this.sanitizePathPart(scope.schema || '_default'),
      this.sanitizePathPart(scope.parentName || '_default'),
      this.sanitizePathPart(tableName)
    )
  }

  private async getAvailableName(folderUri: Uri, preferredName: string): Promise<string> {
    let entries: [string, FileType][] = []
    try {
      entries = await workspace.fs.readDirectory(folderUri)
    } catch {
      entries = []
    }
    const existingNames = new Set(entries.map(([name]) => name.toLowerCase()))
    if (!existingNames.has(preferredName.toLowerCase())) {
      return preferredName
    }

    const extensionIndex = preferredName.toLowerCase().endsWith('.sql')
      ? preferredName.length - '.sql'.length
      : preferredName.length
    const baseName = preferredName.slice(0, extensionIndex)
    for (let index = 2; index < 10000; index++) {
      const nextName = `${baseName}-${index}.sql`
      if (!existingNames.has(nextName.toLowerCase())) {
        return nextName
      }
    }

    return `${baseName}-${Date.now()}.sql`
  }

  private normalizeFileName(fileName: string): string {
    const sanitized = this.sanitizePathPart(fileName.trim() || 'query.sql')
    return sanitized.toLowerCase().endsWith('.sql') ? sanitized : `${sanitized}.sql`
  }

  private sanitizePathPart(value: string): string {
    return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '_') || '_'
  }

  private getFileName(uri: Uri): string {
    return uri.path.split('/').pop() || 'query.sql'
  }
}
