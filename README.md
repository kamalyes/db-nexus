# DB Nexus

[中文文档](README_zh-CN.md) | English

A powerful multi-database workbench for VS Code, Cursor, Windsurf and other VS Code-based editors.

## Features

### Multi-Database Support
- **PostgreSQL** - Full support with schema browsing, query execution, and data editing
- **MySQL / MariaDB** - Complete support for MySQL 5.7+ and MariaDB 10.x
- **SQLite** - Local database file support
- **CockroachDB** - Distributed SQL database (PostgreSQL wire protocol compatible)
- **DuckDB** - In-process analytical database
- **ClickHouse** - OLAP database for analytics workloads

### Core Capabilities
- 🔌 **Connection Management** - Secure credential storage via VS Code SecretStorage
- 📊 **Schema Browser** - Navigate databases, schemas, tables, views, and functions
- 📝 **SQL Editor** - Execute queries with syntax highlighting
- 📋 **Result Grid** - Sortable, filterable table view for query results
- 📜 **Query History** - Track all executed queries with timestamps
- ✏️ **Data Editing** - Table data grid with INSERT/UPDATE/DELETE preview
- 📈 **Execution Plan** - Visualize query execution plans
- 🔗 **ER Diagram** - Generate entity-relationship diagrams
- 📦 **Import/Export** - CSV, JSON, SQL format support
- 🌐 **Internationalization** - English and Simplified Chinese support

## Quick Start

### Installation

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X`)
3. Search for "DB Nexus"
4. Click Install

### Add Connection

1. Click the DB Nexus icon in the Activity Bar
2. Click the "+" button or run `DB Nexus: Add Connection`
3. Select database type and enter connection details
4. Test connection before saving
5. Click Save

### Run Queries

1. Open a SQL file or create a new one
2. Write your SQL query
3. Click the "Run Query" button in the editor toolbar
4. Select a connection from the list
5. View results in the result panel

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System architecture and design principles |
| [Database Support](docs/database-support.md) | Supported databases and capabilities matrix |
| [Execution Plan](docs/execution-plan.md) | Development roadmap and milestones |
| [Localization](docs/localization.md) | Internationalization design |

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `dbNexus.connections` | Workspace connection profiles | `[]` |
| `dbNexus.defaultQueryLimit` | Default row limit for queries | `500` |
| `dbNexus.displayLanguage` | UI language (empty = auto) | `""` |
| `dbNexus.enablePreviewDrivers` | Show planned database drivers | `true` |

## Security

- Passwords stored in VS Code SecretStorage (OS-level encryption)
- Connection profiles stored in workspace settings without sensitive data
- SSL/TLS support for encrypted connections
- Destructive operations require confirmation

## Roadmap

See [Execution Plan](docs/execution-plan.md) for detailed roadmap.

| Version | Status |
|---------|--------|
| v0.1.0 - Project Skeleton | ✅ Released |
| v0.2.0 - SQL Query Pipeline | ✅ Released |
| v0.3.0 - Data Editing | 🚧 In Progress |
| v0.4.0 - Analytics & Productivity | 📋 Planned |
| v0.5.0 - AI & Ecosystem | 📋 Planned |

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a pull request.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/kamalyes/db-nexus/issues)
- **Discussions**: [GitHub Discussions](https://github.com/kamalyes/db-nexus/discussions)

## Acknowledgments

Built with:
- [sql.js](https://github.com/sql-js/sql.js/) - SQLite compiled to JavaScript
- [node-postgres](https://github.com/brianc/node-postgres) - PostgreSQL client
- [mysql2](https://github.com/sidorares/node-mysql2) - MySQL client
- [duckdb](https://github.com/duckdb/duckdb-node) - DuckDB Node.js bindings
