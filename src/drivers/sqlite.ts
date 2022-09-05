import initSqlJs, { Database, SqlJsStatic } from 'sql.js'
import * as fs from 'fs'
import * as path from 'path'
import {
  ConnectionTestResult,
  DatabaseCatalog,
  DatabaseDriverId,
  DbConnectionProfile,
  QueryRequest,
  QueryResult,
  SchemaObject,
  SchemaObjectType,
  SchemaScope
} from '@/core/types'
import { SQL_CAPABILITIES } from '@/core/constants'
import { DatabaseDriver } from './base'

export class SQLiteDriver implements DatabaseDriver {
  id: DatabaseDriverId = 'sqlite'
  displayName = 'SQLite'
  capabilities = SQL_CAPABILITIES

  private SQL: SqlJsStatic | null = null
  private connections = new Map<string, Database>()

  private async initSqlJs(): Promise<SqlJsStatic> {
    if (!this.SQL) {
      this.SQL = await initSqlJs()
    }
    return this.SQL
  }

  private async getConnection(profile: DbConnectionProfile): Promise<Database> {
    const key = profile.id
    if (!this.connections.has(key)) {
      if (!profile.filePath) {
        throw new Error('SQLite connection requires a file path')
      }
      const SQL = await this.initSqlJs()
      
      if (fs.existsSync(profile.filePath)) {
        const buffer = fs.readFileSync(profile.filePath)
        const db = new SQL.Database(buffer)
        this.connections.set(key, db)
      } else {
        const db = new SQL.Database()
        this.connections.set(key, db)
      }
    }
    return this.connections.get(key)!
  }

  async testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult> {
    const start = Date.now()
    try {
      if (!profile.filePath) {
        return {
          ok: false,
          message: 'SQLite connection requires a file path'
        }
      }
      const SQL = await this.initSqlJs()
      
      if (fs.existsSync(profile.filePath)) {
        const buffer = fs.readFileSync(profile.filePath)
        const db = new SQL.Database(buffer)
        db.run('SELECT 1')
        db.close()
      } else {
        const db = new SQL.Database()
        db.run('SELECT 1')
        db.close()
      }
      
      return {
        ok: true,
        message: 'Connection successful',
        latencyMs: Date.now() - start
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async listDatabases(_profile: DbConnectionProfile): Promise<DatabaseCatalog[]> {
    return [{ name: 'main', description: 'SQLite main database' }]
  }

  async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const db = await this.getConnection(profile)
    const objects: SchemaObject[] = []

    if (!scope.parentName) {
      objects.push({
        name: 'main',
        type: 'schema' as SchemaObjectType,
        description: 'Main schema'
      })
    } else if (scope.parentName === 'main' && !scope.database) {
      const result = db.exec(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      
      if (result.length > 0) {
        const rows = result[0].values
        for (const row of rows) {
          objects.push({
            name: String(row[0]),
            type: String(row[1]) as SchemaObjectType,
            description: `${row[1]} in main`
          })
        }
      }
    }

    return objects
  }

  async executeQuery(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    const start = Date.now()
    const db = await this.getConnection(profile)

    try {
      const result = db.exec(request.sql)
      
      if (result.length === 0) {
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          elapsedMs: Date.now() - start
        }
      }

      const firstResult = result[0]
      const columns = firstResult.columns.map((col: string) => ({
        name: col,
        type: 'TEXT'
      }))

      const rows = firstResult.values.map((row: (string | number | null | Uint8Array)[]) => {
        const obj: Record<string, unknown> = {}
        firstResult.columns.forEach((col: string, i: number) => {
          obj[col] = row[i]
        })
        return obj
      })

      return {
        columns,
        rows,
        rowCount: rows.length,
        elapsedMs: Date.now() - start
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  }

  async dispose(profileId: string): Promise<void> {
    const db = this.connections.get(profileId)
    if (db) {
      db.close()
      this.connections.delete(profileId)
    }
  }
}
