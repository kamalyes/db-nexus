import { DbConnectionProfile, QueryRequest, QueryResult } from '@/core/types';

export interface QueryHistoryItem {
  id: string;
  sql: string;
  connectionId?: string;
  connectionName?: string;
  timestamp: number;
  success: boolean;
  rowCount?: number;
  durationMs?: number;
  error?: string;
}

export class QueryHistoryService {
  private static instance: QueryHistoryService;
  private history: QueryHistoryItem[] = [];
  private readonly maxHistorySize = 100;
  private readonly storageKey = 'dbNexus.queryHistory';
  private context: any;

  static init(context: any): void {
    QueryHistoryService.instance = new QueryHistoryService(context);
  }

  static getInstance(): QueryHistoryService {
    if (!QueryHistoryService.instance) {
      throw new Error('QueryHistoryService not initialized');
    }
    return QueryHistoryService.instance;
  }

  private constructor(context: any) {
    this.context = context;
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    try {
      const stored = this.context.globalState.get(this.storageKey) as string | undefined;
      if (stored) {
        this.history = JSON.parse(stored);
      }
    } catch {
      this.history = [];
    }
  }

  private async saveToStorage(): Promise<void> {
    try {
      await this.context.globalState.update(this.storageKey, JSON.stringify(this.history));
    } catch {
      // ignore
    }
  }

  async add(
    sql: string,
    profile: DbConnectionProfile,
    resultOrError: QueryResult | Error
  ): Promise<void> {
    const item: QueryHistoryItem = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sql,
      connectionId: profile.id,
      connectionName: profile.name,
      timestamp: Date.now(),
      success: !(resultOrError instanceof Error),
      rowCount: resultOrError instanceof Error ? undefined : resultOrError.rowCount,
      durationMs: resultOrError instanceof Error ? undefined : resultOrError.elapsedMs,
      error: resultOrError instanceof Error ? resultOrError.message : undefined
    };

    this.history.unshift(item);
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(0, this.maxHistorySize);
    }
    await this.saveToStorage();
  }

  getAll(): QueryHistoryItem[] {
    return this.history;
  }

  getRecent(limit: number = 20): QueryHistoryItem[] {
    return this.history.slice(0, limit);
  }

  async clear(): Promise<void> {
    this.history = [];
    await this.saveToStorage();
  }
}
