import { OutputChannel } from 'vscode'
import { DataEditResult, DbConnectionProfile, QueryResult } from '@/core/types'
import { QueryHistoryService } from './queryHistoryService'

type SqlExecutionResult = QueryResult | DataEditResult

export class SqlExecutionLogService {
  private static instance: SqlExecutionLogService
  private sequence = Date.now() % 1000000

  static init(outputChannel: OutputChannel): void {
    SqlExecutionLogService.instance = new SqlExecutionLogService(outputChannel)
  }

  static getInstance(): SqlExecutionLogService {
    if (!SqlExecutionLogService.instance) {
      throw new Error('SqlExecutionLogService not initialized')
    }
    return SqlExecutionLogService.instance
  }

  private constructor(private readonly outputChannel: OutputChannel) {}

  async record(
    sql: string,
    profile: DbConnectionProfile,
    resultOrError: SqlExecutionResult | Error,
    elapsedMs?: number
  ): Promise<void> {
    await QueryHistoryService.getInstance().add(
      sql,
      profile,
      resultOrError instanceof Error ? resultOrError : this.toQueryHistoryResult(resultOrError, elapsedMs)
    )
    this.writeConsoleLog(sql, profile, resultOrError, elapsedMs)
  }

  private writeConsoleLog(
    sql: string,
    profile: DbConnectionProfile,
    resultOrError: SqlExecutionResult | Error,
    elapsedMs?: number
  ): void {
    const durationMs = elapsedMs ?? (resultOrError instanceof Error ? undefined : this.getResultElapsedMs(resultOrError))
    const header = [
      this.formatTimestamp(new Date()),
      this.getConnectionLabel(profile),
      this.nextSequence(),
      profile.driverId.toUpperCase()
    ]
      .map(part => `[${part}]`)
      .join('')

    this.outputChannel.appendLine('')
    this.outputChannel.appendLine(header)
    this.outputChannel.appendLine(sql.trim())
    if (resultOrError instanceof Error) {
      this.outputChannel.appendLine(`Error: ${resultOrError.message}`)
    }
    this.outputChannel.appendLine(`Time: ${this.formatDuration(durationMs)}`)
    this.outputChannel.show(true)
  }

  private nextSequence(): string {
    this.sequence = (this.sequence + 1) % 1000000
    return String(this.sequence).padStart(6, '0')
  }

  private getConnectionLabel(profile: DbConnectionProfile): string {
    return profile.host || profile.filePath || profile.database || profile.name
  }

  private formatTimestamp(date: Date): string {
    const pad = (value: number, length = 2) => String(value).padStart(length, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
      + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  }

  private formatDuration(elapsedMs?: number): string {
    if (elapsedMs === undefined || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
      return '--'
    }
    return `${(elapsedMs / 1000).toFixed(3)}s`
  }

  private getResultElapsedMs(result: SqlExecutionResult): number | undefined {
    return 'elapsedMs' in result ? result.elapsedMs : undefined
  }

  private toQueryHistoryResult(result: SqlExecutionResult, elapsedMs?: number): QueryResult {
    if ('rows' in result && 'columns' in result) {
      return result
    }

    return {
      columns: [],
      rows: [],
      rowCount: result.affectedRows,
      elapsedMs: elapsedMs ?? 0
    }
  }
}
