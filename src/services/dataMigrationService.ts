import { window, ProgressLocation } from 'vscode'
import { DbConnectionProfile, SchemaScope } from '@/core/types'
import { DatabaseDriver } from '@/drivers/base'
import { t } from '@/i18n'

export interface MigrationOptions {
  tables?: string[]
  batchSize: number
  includeData: boolean
  includeSchema: boolean
  dropExisting: boolean
}

export interface MigrationProgress {
  currentTable: string
  currentStep: string
  totalTables: number
  completedTables: number
  rowsProcessed: number
  totalRows: number
}

export class DataMigrationService {
  static async migrateData(
    sourceProfile: DbConnectionProfile,
    sourceDriver: DatabaseDriver,
    targetProfile: DbConnectionProfile,
    targetDriver: DatabaseDriver,
    options: MigrationOptions
  ): Promise<void> {
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: t('migration.inProgress'),
        cancellable: false
      },
      async (progress) => {
        progress.report({ increment: 0, message: t('migration.preparing') })

        const sourceObjects = await sourceDriver.listObjects(sourceProfile, {})
        let tables = sourceObjects.filter(obj => obj.type === 'table')
        
        if (options.tables && options.tables.length > 0) {
          tables = tables.filter(t => options.tables!.includes(t.name))
        }

        const totalTables = tables.length
        let completedTables = 0

        for (const table of tables) {
          progress.report({
            increment: 0,
            message: t('migration.processingTable', table.name)
          })

          if (options.includeSchema && options.dropExisting) {
            await DataMigrationService._dropTableIfExists(targetProfile, targetDriver, table.name)
          }

          if (options.includeSchema) {
            await DataMigrationService._migrateSchema(
              sourceProfile,
              sourceDriver,
              targetProfile,
              targetDriver,
              table.name
            )
          }

          if (options.includeData) {
            const rowsMigrated = await DataMigrationService._migrateData(
              sourceProfile,
              sourceDriver,
              targetProfile,
              targetDriver,
              table.name,
              options.batchSize,
              progress
            )
            
            progress.report({
              increment: (100 / totalTables),
              message: t('migration.tableCompleted', table.name, String(rowsMigrated))
            })
          }

          completedTables++
        }

        progress.report({ increment: 100, message: t('migration.completed') })
      }
    )

    window.showInformationMessage(t('migration.success'))
  }

  private static async _dropTableIfExists(
    profile: DbConnectionProfile,
    driver: DatabaseDriver,
    tableName: string
  ): Promise<void> {
    try {
      await driver.executeQuery(profile, {
        sql: `DROP TABLE IF EXISTS ${tableName} CASCADE`
      })
    } catch (error) {
      console.error(`Failed to drop table ${tableName}:`, error)
    }
  }

  private static async _migrateSchema(
    sourceProfile: DbConnectionProfile,
    sourceDriver: DatabaseDriver,
    targetProfile: DbConnectionProfile,
    targetDriver: DatabaseDriver,
    tableName: string
  ): Promise<void> {
    if (!sourceDriver.getDDL) {
      throw new Error(t('migration.ddlNotSupported'))
    }

    try {
      const ddl = await sourceDriver.getDDL(sourceProfile, tableName, 'table', {})
      
      const adaptedDDL = DataMigrationService._adaptDDL(
        ddl,
        sourceProfile.driverId,
        targetProfile.driverId
      )
      
      await targetDriver.executeQuery(targetProfile, { sql: adaptedDDL })
    } catch (error) {
      console.error(`Failed to migrate schema for ${tableName}:`, error)
      throw error
    }
  }

  private static async _migrateData(
    sourceProfile: DbConnectionProfile,
    sourceDriver: DatabaseDriver,
    targetProfile: DbConnectionProfile,
    targetDriver: DatabaseDriver,
    tableName: string,
    batchSize: number,
    progress: { report: (value: { message: string }) => void }
  ): Promise<number> {
    let totalRows = 0
    let offset = 0
    let hasMore = true

    while (hasMore) {
      progress.report({ message: t('migration.migratingRows', tableName, String(offset)) })

      const result = await sourceDriver.executeQuery(sourceProfile, {
        sql: `SELECT * FROM ${tableName} LIMIT ${batchSize} OFFSET ${offset}`
      })

      if (result.rows.length === 0) {
        hasMore = false
        break
      }

      for (const row of result.rows) {
        const columns = result.columns.map(c => c.name)
        const values = columns.map(col => {
          const value = (row as Record<string, unknown>)[col]
          return DataMigrationService._formatValue(value, targetProfile.driverId)
        })

        const insertSQL = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')})`
        
        try {
          await targetDriver.executeQuery(targetProfile, { sql: insertSQL })
        } catch (error) {
          console.error(`Failed to insert row in ${tableName}:`, error)
        }
      }

      totalRows += result.rows.length
      offset += batchSize

      if (result.rows.length < batchSize) {
        hasMore = false
      }
    }

    return totalRows
  }

  private static _formatValue(value: unknown, _driverId: string): string {
    if (value === null || value === undefined) {
      return 'NULL'
    }
    if (typeof value === 'string') {
      return `'${value.replace(/'/g, "''")}'`
    }
    if (typeof value === 'boolean') {
      return value ? 'TRUE' : 'FALSE'
    }
    if (value instanceof Date) {
      return `'${value.toISOString()}'`
    }
    if (typeof value === 'object') {
      return `'${JSON.stringify(value).replace(/'/g, "''")}'`
    }
    return String(value)
  }

  private static _adaptDDL(
    ddl: string,
    sourceDriverId: string,
    targetDriverId: string
  ): string {
    if (sourceDriverId === targetDriverId) {
      return ddl
    }

    let adaptedDDL = ddl

    const typeMappings: Record<string, Record<string, string>> = {
      'postgresql': {
        'SERIAL': 'INTEGER AUTO_INCREMENT',
        'BIGSERIAL': 'BIGINT AUTO_INCREMENT',
        'TEXT': 'TEXT',
        'BOOLEAN': 'BOOLEAN',
        'TIMESTAMPTZ': 'TIMESTAMP',
        'JSONB': 'JSON'
      },
      'mysql': {
        'AUTO_INCREMENT': 'SERIAL',
        'TINYINT(1)': 'BOOLEAN',
        'DATETIME': 'TIMESTAMP'
      },
      'sqlite': {
        'SERIAL': 'INTEGER',
        'AUTO_INCREMENT': 'AUTOINCREMENT'
      }
    }

    const sourceMapping = typeMappings[sourceDriverId]
    const targetMapping = typeMappings[targetDriverId]

    if (sourceMapping) {
      for (const [from, to] of Object.entries(sourceMapping)) {
        adaptedDDL = adaptedDDL.replace(new RegExp(from, 'gi'), to)
      }
    }

    if (targetMapping) {
      for (const [from, to] of Object.entries(targetMapping)) {
        adaptedDDL = adaptedDDL.replace(new RegExp(from, 'gi'), to)
      }
    }

    return adaptedDDL
  }
}
