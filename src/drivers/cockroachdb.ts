import { PostgreSQLDriver } from './postgresql'
import { DatabaseDriverId, DbConnectionProfile, SchemaScope, SchemaObject, SchemaObjectType } from '@/core/types'
import { Pool } from 'pg'
import { SecretService } from '@/services/secretService'

export class CockroachDBDriver extends PostgreSQLDriver {
  override id: DatabaseDriverId = 'cockroachdb'
  override displayName = 'CockroachDB'

  private cockroachPools = new Map<string, Pool>()

  protected override getDefaultDatabase(profile: DbConnectionProfile): string {
    return profile.database || 'defaultdb'
  }

  protected override async getPool(profile: DbConnectionProfile, database = this.getDefaultDatabase(profile)): Promise<Pool> {
    const key = this.getPoolKey(profile, database)
    if (!this.cockroachPools.has(key)) {
      const password = await this.getPassword(profile)
      const pool = new Pool({
        host: profile.host || 'localhost',
        port: profile.port || 26257,
        database,
        user: profile.username || 'root',
        password,
        ssl: profile.ssl !== false ? { rejectUnauthorized: false } : false,
        max: 10
      })
      this.cockroachPools.set(key, pool)
    }
    return this.cockroachPools.get(key)!
  }

  override async listDatabases(profile: DbConnectionProfile): Promise<{ name: string; description?: string }[]> {
    const pool = await this.getPool(profile)
    const result = await pool.query(`
      SELECT datname AS name
      FROM pg_database
      WHERE datistemplate = false
      ORDER BY datname
    `)
    return result.rows.map((row: { name: string }) => ({
      name: row.name
    }))
  }

  override async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const database = scope.database || this.getDefaultDatabase(profile)
    const pool = await this.getPool(profile, database)
    const objects: SchemaObject[] = []

    if (!scope.database || (scope.database && !scope.schema)) {
      const result = await pool.query(`
        SELECT schema_name as name 
        FROM information_schema.schemata 
        WHERE schema_name NOT LIKE 'pg_%' 
          AND schema_name != 'information_schema'
          AND schema_name NOT LIKE 'crdb_%'
          AND schema_name NOT LIKE '%_pg_catalog'
          AND schema_name NOT LIKE 'persistence%'
        ORDER BY schema_name
      `)
      for (const row of result.rows as Array<{ name: string }>) {
        objects.push({
          name: row.name,
          type: 'schema' as SchemaObjectType,
          description: 'Schema'
        })
      }
    } else {
      const result = await pool.query(
        `SELECT table_name as name, table_type as type
         FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [scope.schema]
      )
      for (const row of result.rows as Array<{ name: string; type: string }>) {
        objects.push({
          name: row.name,
          type: row.type === 'VIEW' ? 'view' : 'table' as SchemaObjectType,
          description: row.type
        })
      }
    }

    return objects
  }

  override async dispose(profileId: string): Promise<void> {
    const entries = Array.from(this.cockroachPools.entries())
      .filter(([key]) => key === profileId || key.startsWith(`${profileId}:`))

    for (const [key, pool] of entries) {
      await pool.end()
      this.cockroachPools.delete(key)
    }
  }
}
