import { ConnectionStore } from '../core/connectionStore'
import { ConnectionTestResult, DatabaseCatalog, DbConnectionProfile, SchemaObject, SchemaScope } from '../core/types'
import { DriverRegistry } from '../drivers/registry'
import { DatabaseDriver } from '../drivers/base'

export class ConnectionService {
  constructor(
    private readonly store: ConnectionStore,
    private readonly registry: DriverRegistry
  ) {}

  getConnections(): DbConnectionProfile[] {
    return this.store.getAll()
  }

  getConnection(id: string): DbConnectionProfile | undefined {
    return this.store.getById(id)
  }

  getDriver(driverId: string): DatabaseDriver | undefined {
    try {
      return this.registry.getDriver(driverId as any)
    } catch {
      return undefined
    }
  }

  async testConnection(profile: DbConnectionProfile): Promise<ConnectionTestResult> {
    return this.registry.getDriver(profile.driverId).testConnection(profile)
  }

  async listDatabases(profile: DbConnectionProfile): Promise<DatabaseCatalog[]> {
    return this.registry.getDriver(profile.driverId).listDatabases(profile)
  }

  async listObjects(profile: DbConnectionProfile, scope: SchemaScope): Promise<SchemaObject[]> {
    return this.registry.getDriver(profile.driverId).listObjects(profile, scope)
  }
}
