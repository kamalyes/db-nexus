import { ConfigurationTarget, ExtensionContext, workspace } from 'vscode'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { Database } from 'sql.js'
import { getSqlJsFilePath, loadSqlJs } from './sqlJs'
import { DatabaseDriverId, DbConnectionProfile } from './types'

const CONFIG_SECTION = 'dbNexus'
const CONNECTIONS_KEY = 'connections'
const DATABASE_FILE = 'connections.sqlite'
const LEGACY_MIGRATION_KEY = 'legacyConfigMigrated'

export class ConnectionStore {
  private constructor(
    private readonly db: Database,
    private readonly dbPath: string
  ) {}

  static async create(context: ExtensionContext): Promise<ConnectionStore> {
    const storagePath = context.globalStorageUri.fsPath
    fs.mkdirSync(storagePath, { recursive: true })

    const initSqlJs = loadSqlJs(context.extensionPath)
    const SQL = await initSqlJs({
      locateFile: (file: string) => getSqlJsFilePath(context.extensionPath, file)
    })
    const dbPath = path.join(storagePath, DATABASE_FILE)
    const db = fs.existsSync(dbPath)
      ? new SQL.Database(fs.readFileSync(dbPath))
      : new SQL.Database()

    const store = new ConnectionStore(db, dbPath)
    store.ensureSchema()
    await store.migrateLegacyWorkspaceConfig()
    return store
  }

  getAll(): DbConnectionProfile[] {
    const result = this.db.exec('SELECT profile_json FROM connection_profiles ORDER BY sort_order ASC, created_at ASC')
    if (result.length === 0) {
      return []
    }

    return result[0].values
      .map(row => this.parseProfile(String(row[0] || '{}')))
      .filter((profile): profile is DbConnectionProfile => !!profile)
  }

  getById(id: string): DbConnectionProfile | undefined {
    const stmt = this.db.prepare('SELECT profile_json FROM connection_profiles WHERE id = ?')
    try {
      stmt.bind([id])
      if (!stmt.step()) {
        return undefined
      }
      return this.parseProfile(String(stmt.get()[0] || '{}'))
    } finally {
      stmt.free()
    }
  }

  async add(input: Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>): Promise<DbConnectionProfile> {
    const now = new Date().toISOString()
    const profile: DbConnectionProfile = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    }

    await this.saveAll([...this.getAll(), profile])
    return profile
  }

  async remove(id: string): Promise<void> {
    await this.saveAll(this.getAll().filter(profile => profile.id !== id))
  }

  async saveAll(profiles: DbConnectionProfile[]): Promise<void> {
    this.db.run('BEGIN TRANSACTION')
    try {
      this.db.run('DELETE FROM connection_profiles')
      profiles.forEach((profile, index) => {
        const normalized = this.normalizeProfile(this.stripSensitiveFields(profile))
        this.db.run(
          [
            'INSERT INTO connection_profiles',
            '(id, name, driver_id, profile_json, sort_order, created_at, updated_at)',
            'VALUES (?, ?, ?, ?, ?, ?, ?)'
          ].join(' '),
          [
            normalized.id,
            normalized.name,
            normalized.driverId,
            JSON.stringify(normalized),
            index,
            normalized.createdAt,
            normalized.updatedAt
          ]
        )
      })
      this.db.run('COMMIT')
      this.persist()
    } catch (error) {
      this.db.run('ROLLBACK')
      throw error
    }
  }

  createDefaultProfile(name: string, driverId: DatabaseDriverId): Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      name,
      driverId,
      ssl: false
    }
  }

  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS connection_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        driver_id TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS store_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    this.persist()
  }

  private async migrateLegacyWorkspaceConfig(): Promise<void> {
    if (this.getMetadata(LEGACY_MIGRATION_KEY) === '1') {
      return
    }

    const legacyProfiles = workspace.getConfiguration(CONFIG_SECTION).get<DbConnectionProfile[]>(CONNECTIONS_KEY, [])
    if (legacyProfiles.length > 0) {
      const existingProfiles = this.getAll()
      const existingIds = new Set(existingProfiles.map(profile => profile.id))
      const migratedProfiles = legacyProfiles
        .map(profile => this.normalizeProfile(this.stripSensitiveFields(profile)))
        .filter(profile => !existingIds.has(profile.id))

      if (migratedProfiles.length > 0) {
        await this.saveAll([...existingProfiles, ...migratedProfiles])
      }

      try {
        await workspace.getConfiguration(CONFIG_SECTION).update(CONNECTIONS_KEY, undefined, ConfigurationTarget.Workspace)
      } catch {
        // Keep the migrated profiles in SQLite even if the current window has no writable workspace settings.
      }
    }

    this.setMetadata(LEGACY_MIGRATION_KEY, '1')
    this.persist()
  }

  private normalizeProfile(profile: DbConnectionProfile): DbConnectionProfile {
    const now = new Date().toISOString()
    return {
      ...profile,
      id: profile.id || randomUUID(),
      name: profile.name || 'Untitled connection',
      driverId: profile.driverId || 'mysql',
      createdAt: profile.createdAt || now,
      updatedAt: profile.updatedAt || now
    }
  }

  private stripSensitiveFields(profile: DbConnectionProfile): DbConnectionProfile {
    const {
      password: _password,
      token: _token,
      accessToken: _accessToken,
      secret: _secret,
      ...safeProfile
    } = profile as DbConnectionProfile & {
      password?: string
      token?: string
      accessToken?: string
      secret?: string
    }
    return safeProfile
  }

  private parseProfile(json: string): DbConnectionProfile | undefined {
    try {
      return this.normalizeProfile(this.stripSensitiveFields(JSON.parse(json) as DbConnectionProfile))
    } catch {
      return undefined
    }
  }

  private getMetadata(key: string): string | undefined {
    const stmt = this.db.prepare('SELECT value FROM store_metadata WHERE key = ?')
    try {
      stmt.bind([key])
      if (!stmt.step()) {
        return undefined
      }
      const value = stmt.get()[0]
      return value === undefined || value === null ? undefined : String(value)
    } finally {
      stmt.free()
    }
  }

  private setMetadata(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO store_metadata (key, value) VALUES (?, ?)', [key, value])
  }

  private persist(): void {
    fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()))
  }
}
