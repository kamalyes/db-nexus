import { EventEmitter, Event } from 'vscode'

export type ConnectionStatusType = 'connected' | 'disconnected' | 'error' | 'connecting'

export interface ConnectionStatus {
  profileId: string
  status: ConnectionStatusType
  latency?: number
  error?: string
}

class ConnectionStatusManager {
  private readonly _statuses = new Map<string, ConnectionStatus>()
  private readonly _onDidChangeStatusEmitter = new EventEmitter<ConnectionStatus>()
  readonly onDidChangeStatus: Event<ConnectionStatus> = this._onDidChangeStatusEmitter.event

  getStatus(profileId: string): ConnectionStatus | undefined {
    return this._statuses.get(profileId)
  }

  getAllStatuses(): ConnectionStatus[] {
    return Array.from(this._statuses.values())
  }

  setStatus(profileId: string, status: ConnectionStatusType, latency?: number, error?: string): void {
    const newStatus: ConnectionStatus = {
      profileId,
      status,
      latency,
      error
    }
    this._statuses.set(profileId, newStatus)
    this._onDidChangeStatusEmitter.fire(newStatus)
  }

  clearStatus(profileId: string): void {
    this._statuses.delete(profileId)
    this._onDidChangeStatusEmitter.fire({
      profileId,
      status: 'disconnected'
    })
  }

  isConnected(profileId: string): boolean {
    return this._statuses.get(profileId)?.status === 'connected'
  }
}

export const connectionStatusManager = new ConnectionStatusManager()
