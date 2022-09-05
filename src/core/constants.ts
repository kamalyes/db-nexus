import { DriverCapabilities, DriverDefinition } from './types'

export const NO_CAPABILITIES: DriverCapabilities = {
  schemaBrowse: false,
  query: false,
  dataEdit: false,
  transactions: false,
  explain: false,
  erd: false,
  importExport: false,
  backupRestore: false,
  streaming: false
}

export const SQL_CAPABILITIES: DriverCapabilities = {
  schemaBrowse: true,
  query: true,
  dataEdit: true,
  transactions: true,
  explain: true,
  erd: true,
  importExport: true,
  backupRestore: true,
  streaming: false
}

export const SUPPORTED_DRIVERS: DriverDefinition[] = [
  { id: 'postgresql', displayName: 'PostgreSQL', family: 'sql', defaultPort: 5432, implemented: true, capabilities: SQL_CAPABILITIES },
  { id: 'mysql', displayName: 'MySQL', family: 'sql', defaultPort: 3306, implemented: true, capabilities: SQL_CAPABILITIES },
  { id: 'mariadb', displayName: 'MariaDB', family: 'sql', defaultPort: 3306, implemented: true, capabilities: SQL_CAPABILITIES },
  { id: 'sqlite', displayName: 'SQLite', family: 'sql', implemented: true, capabilities: SQL_CAPABILITIES },
  { id: 'sqlserver', displayName: 'SQL Server', family: 'sql', defaultPort: 1433, implemented: false, capabilities: SQL_CAPABILITIES },
  { id: 'oracle', displayName: 'Oracle', family: 'sql', defaultPort: 1521, implemented: false, capabilities: SQL_CAPABILITIES },
  { id: 'mongodb', displayName: 'MongoDB', family: 'document', defaultPort: 27017, implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true } },
  { id: 'redis', displayName: 'Redis', family: 'keyValue', defaultPort: 6379, implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true, streaming: true } },
  { id: 'duckdb', displayName: 'DuckDB', family: 'warehouse', implemented: true, capabilities: { ...SQL_CAPABILITIES, backupRestore: false } },
  { id: 'snowflake', displayName: 'Snowflake', family: 'warehouse', implemented: false, capabilities: { ...SQL_CAPABILITIES, dataEdit: false, backupRestore: false } },
  { id: 'bigquery', displayName: 'BigQuery', family: 'warehouse', implemented: false, capabilities: { ...SQL_CAPABILITIES, dataEdit: false, backupRestore: false } },
  { id: 'databricks', displayName: 'Databricks', family: 'warehouse', implemented: false, capabilities: { ...SQL_CAPABILITIES, dataEdit: false, backupRestore: false } },
  { id: 'clickhouse', displayName: 'ClickHouse', family: 'warehouse', defaultPort: 8123, implemented: true, capabilities: { ...SQL_CAPABILITIES, transactions: false, dataEdit: false, erd: false, backupRestore: false } },
  { id: 'cassandra', displayName: 'Cassandra', family: 'sql', defaultPort: 9042, implemented: false, capabilities: { ...SQL_CAPABILITIES, transactions: false, explain: false, erd: false, backupRestore: false } },
  { id: 'elasticsearch', displayName: 'Elasticsearch', family: 'search', defaultPort: 9200, implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true } },
  { id: 'neo4j', displayName: 'Neo4j', family: 'graph', defaultPort: 7687, implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true } },
  { id: 'firebase', displayName: 'Firebase', family: 'document', implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true } },
  { id: 'dynamodb', displayName: 'DynamoDB', family: 'document', implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true } },
  { id: 'cockroachdb', displayName: 'CockroachDB', family: 'sql', defaultPort: 26257, implemented: true, capabilities: SQL_CAPABILITIES },
  { id: 'csv', displayName: 'CSV', family: 'file', implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true } },
  { id: 'excel', displayName: 'Excel', family: 'file', implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true } },
  { id: 'json', displayName: 'JSON', family: 'file', implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, dataEdit: true, importExport: true } },
  { id: 'parquet', displayName: 'Parquet', family: 'file', implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, importExport: true } },
  { id: 'avro', displayName: 'Avro', family: 'file', implemented: false, capabilities: { ...NO_CAPABILITIES, schemaBrowse: true, query: true, importExport: true } }
]

