import { SUPPORTED_DRIVERS } from '../core/constants'
import { DatabaseDriverId, DriverDefinition } from '../core/types'
import { DatabaseDriver, PlannedDriver } from './base'
import { SQLiteDriver } from './sqlite'
import { PostgreSQLDriver } from './postgresql'
import { MySQLDriver } from './mysql'
import { MariaDBDriver } from './mariadb'
import { CockroachDBDriver } from './cockroachdb'
import { ClickHouseDriver } from './clickhouse'
import { DuckDBDriver } from './duckdb'

export class DriverRegistry {
  private readonly drivers = new Map<DatabaseDriverId, DatabaseDriver>()
  private readonly definitions = new Map<DatabaseDriverId, DriverDefinition>()

  constructor(private readonly extensionPath = '') {
    for (const definition of SUPPORTED_DRIVERS) {
      this.definitions.set(definition.id, definition)
    }

    this.register(new SQLiteDriver(this.extensionPath))
    this.register(new PostgreSQLDriver())
    this.register(new MySQLDriver())
    this.register(new MariaDBDriver())
    this.register(new CockroachDBDriver())
    this.register(new ClickHouseDriver())
    this.register(new DuckDBDriver())

    const plannedIds: DatabaseDriverId[] = [
      'sqlserver', 'oracle', 'mongodb', 'redis',
      'snowflake', 'bigquery', 'databricks', 'cassandra',
      'elasticsearch', 'neo4j', 'firebase', 'dynamodb',
      'csv', 'excel', 'json', 'parquet', 'avro'
    ]

    for (const id of plannedIds) {
      if (!this.drivers.has(id)) {
        const def = this.definitions.get(id)
        if (def) {
          this.drivers.set(id, new PlannedDriver(id, def.displayName, def.capabilities))
        }
      }
    }
  }

  getDefinitions(): DriverDefinition[] {
    return Array.from(this.definitions.values())
  }

  getDefinition(id: DatabaseDriverId): DriverDefinition | undefined {
    return this.definitions.get(id)
  }

  getDriver(id: DatabaseDriverId): DatabaseDriver {
    const driver = this.drivers.get(id)
    if (!driver) {
      throw new Error(`No driver registered for ${id}`)
    }
    return driver
  }

  register(driver: DatabaseDriver, definition?: DriverDefinition): void {
    this.drivers.set(driver.id, driver)
    if (definition) {
      this.definitions.set(driver.id, definition)
    }
  }
}
