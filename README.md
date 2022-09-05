# DB Nexus

A powerful multi-database workbench for VS Code, Cursor, Windsurf and other VS Code-based editors.

## Features

### Multi-Database Support
- **PostgreSQL** - Full support with schema browsing, query execution, and data editing
- **MySQL** - Complete support for MySQL 5.7+ and MariaDB
- **MariaDB** - Full compatibility with MariaDB 10.x
- **SQLite** - Local database file support
- **CockroachDB** - Distributed SQL database support (PostgreSQL wire protocol compatible)
- **ClickHouse** - OLAP database for analytics workloads

### Core Capabilities
- **Connection Management** - Secure storage of credentials using VS Code SecretStorage
- **Schema Browser** - Navigate databases, schemas, tables, views, and functions
- **Table Schema View** - View table columns, indexes, and foreign keys in detail
- **Table Data View** - Quickly view and browse table data with a single click
- **SQL Editor** - Execute queries with syntax highlighting
- **Result Grid** - View query results in a sortable, filterable table
- **Query History** - Track and view all executed queries with timestamps and results
- **Connection Testing** - Validate connections before saving
- **Internationalization** - English and Simplified Chinese support

### Security
- Passwords are stored in VS Code's SecretStorage (OS-level encryption)
- Connection profiles are stored in workspace settings without sensitive data
- SSL/TLS support for encrypted connections

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "DB Nexus"
4. Click Install

## Quick Start

### Adding a Connection

1. Click the DB Nexus icon in the Activity Bar
2. Click the "+" button or run "DB Nexus: Add Connection"
3. Select your database type
4. Enter connection details:
   - Connection name
   - Host and port
   - Database name
   - Username and password
5. Choose to test the connection before saving
6. Click Save

### Running Queries

1. Open a SQL file or create a new one
2. Write your SQL query
3. Click the "Run Query" button in the editor toolbar
4. Select a connection from the list
5. View results in the result panel

### Browsing Schema

1. Expand a connection in the Connections tree
2. Navigate through databases, schemas, and tables
3. Right-click on a table and select "Show Table Schema" to view detailed column info, indexes, and foreign keys
4. Right-click on a table and select "Show Table Data" to quickly browse the table data

### Viewing Query History

1. Run "DB Nexus: Show Query History" from the command palette
2. View all executed queries with timestamps, results, and error messages (if any)
3. Successful and failed queries are clearly distinguishable
4. History persists across VS Code sessions

## Configuration

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `dbNexus.connections` | Workspace connection profiles | `[]` |
| `dbNexus.defaultQueryLimit` | Default row limit for queries | `500` |
| `dbNexus.displayLanguage` | UI language (empty = auto) | `""` |
| `dbNexus.enablePreviewDrivers` | Show planned database drivers | `true` |

### Language Support

DB Nexus supports multiple languages:
- English (en)
- Simplified Chinese (zh-CN)

Set `dbNexus.displayLanguage` to override the VS Code language setting.

## Architecture

DB Nexus follows a modular architecture:

```
┌─────────────────────────────────────────────────────┐
│                    VS Code UI                        │
│  (TreeView / Webview / Commands / Editor)           │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                   Services                           │
│  (Connection / Query / Secret Storage)              │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│                Driver Registry                       │
└─────────────────────┬───────────────────────────────┘
                      │
    ┌─────────────────┼─────────────────┐
    │                 │                 │
┌───▼───┐       ┌─────▼─────┐     ┌─────▼─────┐
│  SQL  │       │   NoSQL   │     │   File    │
│Drivers│       │  Drivers  │     │  Drivers  │
└───────┘       └───────────┘     └───────────┘
```

## Supported Databases

| Database | Schema Browse | Query | Data Edit | Explain | ER Diagram |
|----------|---------------|-------|-----------|---------|------------|
| PostgreSQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| MySQL | ✅ | ✅ | ✅ | ✅ | ✅ |
| MariaDB | ✅ | ✅ | ✅ | ✅ | ✅ |
| SQLite | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| CockroachDB | ✅ | ✅ | ✅ | ✅ | ✅ |
| ClickHouse | ✅ | ✅ | ❌ | ✅ | ❌ |
| SQL Server | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 |
| MongoDB | 🔜 | 🔜 | 🔜 | - | 🔜 |
| Redis | 🔜 | 🔜 | 🔜 | - | - |
| DuckDB | 🔜 | 🔜 | 🔜 | 🔜 | 🔜 |

Legend: ✅ Supported | ⚠️ Partial | ❌ Not Supported | 🔜 Planned

## Roadmap

### v0.2.0 (Current)
- [x] SQLite driver
- [x] PostgreSQL driver
- [x] MySQL/MariaDB driver
- [x] CockroachDB driver
- [x] ClickHouse driver
- [x] Schema browser
- [x] Query execution
- [x] Result grid
- [x] Secret storage integration
- [x] Table schema view
- [x] Table data view
- [x] Query history

### v0.3.0 (Planned)
- [ ] Data editing with SQL preview
- [ ] Transaction support
- [ ] SQL autocomplete
- [ ] Query history improvements (re-run, copy SQL, etc.)

### v0.4.0 (Planned)
- [ ] Execution plan visualization
- [ ] ER diagram generation
- [ ] Data import/export
- [ ] MongoDB support

### v0.5.0 (Future)
- [ ] AI integration (Copilot context)
- [ ] MCP server
- [ ] Natural language to SQL
- [ ] Query result charts

## Contributing

Contributions are welcome! Please read our contributing guidelines before submitting a pull request.

## License

MIT License - see LICENSE file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/kamalyes/db-nexus/issues)
- **Discussions**: [GitHub Discussions](https://github.com/kamalyes/db-nexus/discussions)

## Acknowledgments

Built with:
- [sql.js](https://github.com/sql-js/sql.js/) - SQLite compiled to JavaScript
- [node-postgres](https://github.com/brianc/node-postgres) - PostgreSQL client
- [mysql2](https://github.com/sidorares/node-mysql2) - MySQL client
