import { ConfigurationTarget, workspace } from 'vscode'
import { randomUUID } from 'crypto'
import { DatabaseDriverId, DbConnectionProfile } from './types'

const CONFIG_SECTION = 'dbNexus'
const CONNECTIONS_KEY = 'connections'

export class ConnectionStore {
  getAll(): DbConnectionProfile[] {
    return workspace.getConfiguration(CONFIG_SECTION).get<DbConnectionProfile[]>(CONNECTIONS_KEY, [])
  }

  getById(id: string): DbConnectionProfile | undefined {
    return this.getAll().find(profile => profile.id === id)
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
    await workspace.getConfiguration(CONFIG_SECTION).update(CONNECTIONS_KEY, profiles, ConfigurationTarget.Workspace)
  }

  createDefaultProfile(name: string, driverId: DatabaseDriverId): Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      name,
      driverId,
      ssl: false
    }
  }
}

