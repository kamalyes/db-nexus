import { PostgreSQLDriver } from './postgresql'
import { DatabaseDriverId, DbConnectionProfile, SchemaScope, SchemaObject, SchemaObjectType } from '@/core/types'
import { Pool } from 'pg'
import { SecretService } from '@/services/secretService'

export class CockroachDBDriver extends PostgreSQLDriver {
  override id: DatabaseDriverId = 'cockroachdb'
  override displayName = 'CockroachDB'

  private cockroachPools = new Map<string, Pool>()

  protected override async getPool(profile: DbConnectionProfile): Promise<Pool> {
    const key = profile.id
    if (!this.cockroachPools.has(key)) {
      const password = await this.getPassword(profile)
      const pool = new Pool({
        host: profile.host || 'localhost',
        port: profile.port || 26257,
        database: profile.database || 'defaultdb',
        user: profile.username || 'root',
        password,
        ssl: profile.ssl !== false ? { rejectUnauthorized: false } : false,
        max: 10
      })
      this.cockroachPools.set(key, pool)
    }
    return this.cockroachPools.get(key)!
  }

  override async listDatabases(): Promise<{ name: string; description?: string }[]> {
    return [{ name: 'defaultdb', description: 'Default database' }]
  }

  override async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    const pool = await this.getPool(profile)
    const objects: SchemaObject[] = []

    if (!scope.database) {
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
        [scope.database]
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
    const pool = this.cockroachPools.get(profileId)
    if (pool) {
      await pool.end()
      this.cockroachPools.delete(profileId)
    }
  }
}
