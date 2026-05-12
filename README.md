# DB Nexus

[中文文档](README_zh-CN.md) | English

A powerful multi-database workbench for VS Code, Cursor, Windsurf and other VS Code-based editors.

## Features

### Multi-Database Support
- **PostgreSQL** - Full support with schema browsing, query execution, data editing, and connection pool isolation
- **MySQL / MariaDB** - Complete support for MySQL 5.7+ and MariaDB 10.x (MariaDB inherits MySQL driver)
- **SQLite** - Local database file support with in-memory mode
- **CockroachDB** - Distributed SQL database (PostgreSQL wire protocol compatible, inherits PG driver)
- **DuckDB** - In-process analytical database with file-based and in-memory modes
- **ClickHouse** - OLAP database for analytics workloads (HTTP protocol, data-skipping index support)

### Core Capabilities
- 🔌 **Connection Management** - Secure credential storage via VS Code SecretStorage, smart default naming
- 📊 **Schema Browser** - Navigate databases, schemas, tables, views, and functions with multi-level hierarchy
- 📝 **SQL Editor** - Execute queries with syntax highlighting and result pagination
- 📋 **Result Grid** - Sortable, filterable table view for query results with total row count
- 📜 **Query History** - Track all executed queries with timestamps, connection info, and duration
- ✏️ **Data Editing** - Table data grid with INSERT/UPDATE/DELETE preview and mutation plan
- 📈 **Execution Plan** - Visualize query execution plans with cost and timing analysis
- 🔗 **ER Diagram** - Generate entity-relationship diagrams from foreign key relationships
- 📦 **Import/Export** - CSV, JSON, SQL format support with wizard-driven workflow
- 🌐 **Internationalization** - English and Simplified Chinese support (56 commands fully translated)

### Table Management
- 📋 **Open Table** - Browse table data with pagination, filtering, and sorting
- 🏗️ **Design Table** - View table schema with column, index, and foreign key details in split layout
- ➕ **Create Table** - Create new tables with visual form
- ✏️ **Rename Table** - Rename existing tables
- 🗑️ **Drop Table** - Drop tables with confirmation
- 🧹 **Truncate Table** - Clear all table data
- 📄 **Show DDL** - View CREATE TABLE statement (supports table, view, index, trigger, procedure, function)

### SQL Template Generator
- 🔍 **SELECT Template** - Auto-generate SELECT with pagination (MySQL/PG/Oracle/SQL Server)
- ➕ **INSERT Template** - Auto-fill columns with sample values (excludes auto-increment)
- ✏️ **UPDATE Template** - Primary key-aware WHERE clause generation
- 🗑️ **DELETE Template** - Safe delete statement template
- 🔢 **Count Rows** - One-click row count

### Column & Index Operations
- ✏️ **Rename Column** - Rename columns with ALTER TABLE
- 🗑️ **Drop Column** - Remove columns with confirmation
- 📋 **Copy Column Name** - Quick copy to clipboard
- ➕ **Create Index** - Create new indexes on tables (normal/unique)
- 🗑️ **Drop Index** - Remove indexes with confirmation
- 📋 **Copy Index Name** - Quick copy to clipboard

### Advanced Connection Configuration
- 🔌 **Client Driver** - Choose native or HTTP driver mode
- 🔤 **Charset** - Configure client character set (auto/utf8/utf8mb4)
- ⏱️ **Timeout Control** - Fine-grained connect/read/write timeout settings
- 💓 **Keep Alive** - Customizable connection heartbeat interval
- 🗜️ **Compression** - Enable network compression
- 🚀 **Auto Connect** - Automatically connect on startup
- 📝 **Initial Query** - Execute SQL after connection
- 📌 **Notes** - Add descriptions to connections

### Table Schema Panel
- 📐 **Split Layout** - Table + detail sidebar
- 📋 **Column Details** - Type, length, default, comment, charset, nullable, auto-increment
- 📊 **Table Info** - Engine, rows, auto increment, data size, index size, owner, create/update time
- 🔑 **Index Details** - Index type, included columns, uniqueness, primary key flag
- 🔗 **Foreign Key Details** - Referenced table, column mapping, cascade rules (ON UPDATE/ON DELETE)
- 📝 **DDL Preview** - Real-time CREATE TABLE statement generation
- 🗄️ **Database Info** - Server version, charset, collation, active sessions

### Database-Level Operations
- 📋 **Show Table List** - Browse all tables in database/schema with search
- ➕ **Create Table** - Create tables at database/schema level
- 📖 **Data Dictionary** - Generate Markdown data dictionary
- 📄 **Run SQL File** - Execute SQL files
- 🔍 **Search Database** - Search across database objects

### Backup & Migration
- 💾 **Backup Database** - Full backup with schema/data selection (SQL/JSON format)
- 📥 **Restore Database** - Restore from backup files (drop/keep existing tables)
- 🔄 **Data Migration** - Cross-database migration with batch processing and DDL adaptation
- 🔀 **Schema Compare** - Compare schemas between two connections (table/column/index/FK differences)

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
4. Configure advanced options (timeout, charset, etc.)
5. Test connection before saving
6. Click Save

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
- SSL/TLS support for encrypted connections (enabled by default for CockroachDB)
- Destructive operations require confirmation
- Mutation plan preview before executing data changes
- Driver resource cleanup on connection deletion (`driver.dispose()`)

## Roadmap

See [Execution Plan](docs/execution-plan.md) for detailed roadmap.

| Version | Status |
|---------|--------|
| v0.1.0 - Project Skeleton | ✅ Released |
| v0.2.0 - SQL Query Pipeline | ✅ Released |
| v0.3.0 - Data Editing | ✅ Released |
| v0.4.0 - Analytics & Productivity | 🚧 In Progress |
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
- [mysql2](https://github.com/sidorares/mysql2) - MySQL client
- [duckdb](https://github.com/duckdb/duckdb-node) - DuckDB Node.js bindings
