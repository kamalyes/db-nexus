import path from 'path'
import { SUPPORTED_DRIVERS } from './constants'
import { DatabaseDriverId, DbConnectionProfile } from './types'

export interface ParsedConnectionUrl {
  profile: Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>
  password?: string
}

export interface BuildConnectionUrlOptions {
  password?: string
}

const DRIVER_ALIASES: Record<string, DatabaseDriverId> = {
  postgres: 'postgresql',
  postgresql: 'postgresql',
  pg: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlite: 'sqlite',
  sqlite3: 'sqlite',
  duckdb: 'duckdb',
  mssql: 'sqlserver',
  sqlserver: 'sqlserver',
  'sql-server': 'sqlserver',
  oracle: 'oracle',
  mongodb: 'mongodb',
  'mongodb+srv': 'mongodb',
  redis: 'redis',
  rediss: 'redis',
  snowflake: 'snowflake',
  bigquery: 'bigquery',
  databricks: 'databricks',
  clickhouse: 'clickhouse',
  'clickhouse+http': 'clickhouse',
  'clickhouse+https': 'clickhouse',
  cassandra: 'cassandra',
  elasticsearch: 'elasticsearch',
  'elasticsearch+http': 'elasticsearch',
  'elasticsearch+https': 'elasticsearch',
  neo4j: 'neo4j',
  bolt: 'neo4j',
  firebase: 'firebase',
  dynamodb: 'dynamodb',
  csv: 'csv',
  excel: 'excel',
  xlsx: 'excel',
  json: 'json',
  parquet: 'parquet',
  avro: 'avro'
}

const FILE_DRIVER_EXTENSIONS: Record<string, DatabaseDriverId> = {
  '.sqlite': 'sqlite',
  '.sqlite3': 'sqlite',
  '.db': 'sqlite',
  '.duckdb': 'duckdb',
  '.ddb': 'duckdb',
  '.csv': 'csv',
  '.tsv': 'csv',
  '.json': 'json',
  '.jsonl': 'json',
  '.xlsx': 'excel',
  '.xls': 'excel',
  '.parquet': 'parquet',
  '.avro': 'avro'
}

const FILE_DRIVERS = new Set<DatabaseDriverId>(['sqlite', 'duckdb', 'csv', 'excel', 'json', 'parquet', 'avro'])

export function parseConnectionUrl(input: string): ParsedConnectionUrl {
  const raw = input.trim()
  if (!raw) {
    throw new Error('Connection URL is empty')
  }

  const url = new URL(normalizeConnectionUrl(raw))
  const params = url.searchParams
  const driverId = resolveDriverId(url)
  const driver = SUPPORTED_DRIVERS.find(item => item.id === driverId)
  if (!driver) {
    throw new Error(`Unsupported driver: ${driverId}`)
  }

  const filePath = getFilePath(url, driverId)
  const database = getDatabase(url, params, driverId)
  const host = params.get('host') || (url.hostname ? decodeURIComponent(url.hostname) : undefined)
  const port = toOptionalNumber(params.get('port') || url.port)
  const username = params.get('username') || params.get('user') || (url.username ? decodeURIComponent(url.username) : undefined)
  const password = params.get('password') || (url.password ? decodeURIComponent(url.password) : undefined)
  const name = params.get('name') || buildDefaultName(driver.displayName, host, database, filePath)

  const profile: Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'> = {
    name,
    driverId,
    host: FILE_DRIVERS.has(driverId) ? undefined : host,
    port,
    database,
    username,
    filePath,
    ssl: resolveSsl(url, params),
    clientDriver: params.get('clientDriver') || params.get('client') || undefined,
    charset: params.get('charset') || undefined,
    keepAliveInterval: toOptionalNumber(params.get('keepAliveInterval')),
    connectTimeout: toOptionalNumber(params.get('connectTimeout') || params.get('timeout')),
    readTimeout: toOptionalNumber(params.get('readTimeout')),
    writeTimeout: toOptionalNumber(params.get('writeTimeout')),
    useCompression: toOptionalBoolean(params.get('compression') || params.get('useCompression')),
    autoConnect: toOptionalBoolean(params.get('autoConnect')),
    initialQuery: params.get('initialQuery') || undefined,
    note: params.get('note') || undefined
  }

  return {
    profile: compactProfile(profile),
    password
  }
}

export function buildConnectionUrl(profile: DbConnectionProfile, options: BuildConnectionUrlOptions = {}): string {
  const params = new URLSearchParams()
  addCommonConnectionParams(params, profile)

  if (FILE_DRIVERS.has(profile.driverId)) {
    params.set('driver', profile.driverId)
    if (profile.filePath) {
      params.set('path', profile.filePath)
    }
    return `dbnexus://local?${params.toString()}`
  }

  if (!profile.host) {
    params.set('driver', profile.driverId)
    if (profile.port !== undefined) {
      params.set('port', String(profile.port))
    }
    if (profile.database) {
      params.set('database', profile.database)
    }
    if (profile.username) {
      params.set('username', profile.username)
    }
    if (options.password) {
      params.set('password', options.password)
    }
    return `dbnexus:///?${params.toString()}`
  }

  const url = new URL(`${profile.driverId}://db-nexus.local`)
  url.hostname = profile.host
  if (profile.port !== undefined) {
    url.port = String(profile.port)
  }
  if (profile.username) {
    url.username = profile.username
  }
  if (options.password) {
    url.password = options.password
  }
  if (profile.database) {
    url.pathname = `/${profile.database}`
  }
  url.search = params.toString()
  return url.toString()
}

function normalizeConnectionUrl(raw: string): string {
  if (/^jdbc:/i.test(raw)) {
    return raw.replace(/^jdbc:/i, '')
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return raw
  }
  if (/^[a-z]:[\\/]/i.test(raw)) {
    return `file:///${raw.replace(/\\/g, '/')}`
  }
  if (raw.startsWith('\\\\') || raw.startsWith('/')) {
    return `file://${raw.replace(/\\/g, '/')}`
  }
  return raw
}

function resolveDriverId(url: URL): DatabaseDriverId {
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  const driverParam = url.searchParams.get('driver') || url.searchParams.get('type')
  if ((scheme === 'dbnexus' || scheme === 'db') && driverParam) {
    return normalizeDriverId(driverParam)
  }
  if (scheme === 'file') {
    return inferFileDriver(url)
  }
  return normalizeDriverId(scheme)
}

function normalizeDriverId(value: string): DatabaseDriverId {
  const normalized = value.trim().toLowerCase()
  const mapped = DRIVER_ALIASES[normalized] || normalized
  if (SUPPORTED_DRIVERS.some(driver => driver.id === mapped)) {
    return mapped as DatabaseDriverId
  }
  throw new Error(`Unsupported URL scheme: ${value}`)
}

function inferFileDriver(url: URL): DatabaseDriverId {
  const filepath = decodeFilePath(url)
  const extension = path.extname(filepath).toLowerCase()
  const driverId = FILE_DRIVER_EXTENSIONS[extension]
  if (!driverId) {
    throw new Error(`Cannot infer driver from file extension: ${extension || 'none'}`)
  }
  return driverId
}

function getFilePath(url: URL, driverId: DatabaseDriverId): string | undefined {
  if (!FILE_DRIVERS.has(driverId)) {
    return undefined
  }
  const paramPath = url.searchParams.get('path') || url.searchParams.get('file')
  if (paramPath) {
    return normalizeFilePath(paramPath)
  }
  return decodeFilePath(url)
}

function decodeFilePath(url: URL): string {
  if (url.protocol === 'file:') {
    return normalizeFilePath(decodeURIComponent(url.pathname))
  }

  const pathPart = decodeURIComponent(url.pathname || '')
  if (!url.hostname) {
    return normalizeFilePath(pathPart)
  }
  if (url.hostname === 'localhost') {
    return normalizeFilePath(pathPart)
  }
  return normalizeFilePath(`${url.hostname}${pathPart}`)
}

function normalizeFilePath(value: string): string {
  const normalized = value.replace(/\//g, path.sep)
  if (/^[/\\][a-z]:[/\\]/i.test(normalized)) {
    return normalized.slice(1)
  }
  return normalized
}

function getDatabase(url: URL, params: URLSearchParams, driverId: DatabaseDriverId): string | undefined {
  const databaseParam = params.get('database') || params.get('db')
  if (databaseParam) {
    return databaseParam
  }
  if (FILE_DRIVERS.has(driverId)) {
    return undefined
  }
  const pathname = decodeURIComponent(url.pathname || '').replace(/^\/+/, '')
  return pathname || undefined
}

function resolveSsl(url: URL, params: URLSearchParams): boolean | undefined {
  const sslValue = params.get('ssl') || params.get('secure')
  if (sslValue !== null) {
    return toOptionalBoolean(sslValue)
  }
  const sslMode = params.get('sslmode')
  if (sslMode) {
    return !['disable', 'false', '0', 'off'].includes(sslMode.toLowerCase())
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  if (scheme.endsWith('+https') || scheme === 'rediss') {
    return true
  }
  return undefined
}

function buildDefaultName(driverName: string, host?: string, database?: string, filePath?: string): string {
  const target = database || (filePath ? path.basename(filePath) : undefined) || host || 'Connection'
  return `${driverName} ${target}`
}

function toOptionalNumber(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toOptionalBoolean(value: string | null | undefined): boolean | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined
  }
  return ['1', 'true', 'yes', 'on', 'require', 'required'].includes(value.toLowerCase())
}

function addCommonConnectionParams(params: URLSearchParams, profile: DbConnectionProfile): void {
  params.set('name', profile.name)
  if (profile.ssl !== undefined) {
    params.set('ssl', String(profile.ssl))
  }
  if (profile.clientDriver) {
    params.set('clientDriver', profile.clientDriver)
  }
  if (profile.charset) {
    params.set('charset', profile.charset)
  }
  if (profile.keepAliveInterval !== undefined) {
    params.set('keepAliveInterval', String(profile.keepAliveInterval))
  }
  if (profile.connectTimeout !== undefined) {
    params.set('connectTimeout', String(profile.connectTimeout))
  }
  if (profile.readTimeout !== undefined) {
    params.set('readTimeout', String(profile.readTimeout))
  }
  if (profile.writeTimeout !== undefined) {
    params.set('writeTimeout', String(profile.writeTimeout))
  }
  if (profile.useCompression !== undefined) {
    params.set('compression', String(profile.useCompression))
  }
  if (profile.autoConnect !== undefined) {
    params.set('autoConnect', String(profile.autoConnect))
  }
  if (profile.initialQuery) {
    params.set('initialQuery', profile.initialQuery)
  }
  if (profile.note) {
    params.set('note', profile.note)
  }
}

function compactProfile(profile: Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>): Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'> {
  return Object.fromEntries(
    Object.entries(profile).filter(([, value]) => value !== undefined && value !== '')
  ) as Omit<DbConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>
}
