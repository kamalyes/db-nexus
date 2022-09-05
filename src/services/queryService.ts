import { workspace } from 'vscode'
import { DbConnectionProfile, QueryRequest, QueryResult } from '../core/types'
import { DriverRegistry } from '../drivers/registry'

export class QueryService {
  constructor(private readonly registry: DriverRegistry) {}

  async run(profile: DbConnectionProfile, request: QueryRequest): Promise<QueryResult> {
    const defaultLimit = workspace.getConfiguration('dbNexus').get<number>('defaultQueryLimit', 500)
    const driver = this.registry.getDriver(profile.driverId)
    return driver.executeQuery(profile, {
      ...request,
      limit: request.limit ?? defaultLimit
    })
  }
}

