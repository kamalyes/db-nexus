# DB Nexus

一个强大的多数据库工作台，支持 VS Code、Cursor、Windsurf 等 VS Code 系编辑器。

## 功能特性

### 多数据库支持
- **PostgreSQL** - 完整支持 Schema 浏览、查询执行和数据编辑
- **MySQL** - 完整支持 MySQL 5.7+ 和 MariaDB
- **MariaDB** - 完全兼容 MariaDB 10.x
- **SQLite** - 本地数据库文件支持
- **CockroachDB** - 分布式 SQL 数据库支持（PostgreSQL 协议兼容）
- **ClickHouse** - OLAP 分析型数据库支持

### 核心能力
- **连接管理** - 使用 VS Code SecretStorage 安全存储凭据
- **Schema 浏览器** - 浏览数据库、Schema、表、视图和函数
- **表结构查看** - 详细查看表的列、索引和外键信息
- **表数据查看** - 一键快速查看表数据
- **SQL 编辑器** - 带语法高亮的查询执行
- **结果网格** - 可排序、可过滤的表格展示查询结果
- **查询历史** - 跟踪和查看所有执行过的查询，包含时间戳和结果
- **连接测试** - 保存前验证连接
- **国际化** - 支持英文和简体中文

### 安全性
- 密码存储在 VS Code 的 SecretStorage（操作系统级加密）
- 连接配置存储在工作区设置中，不包含敏感数据
- 支持 SSL/TLS 加密连接

## 安装

1. 打开 VS Code
2. 进入扩展（Ctrl+Shift+X）
3. 搜索 "DB Nexus"
4. 点击安装

## 快速开始

### 添加连接

1. 点击侧边栏的 DB Nexus 图标
2. 点击 "+" 按钮或运行 "DB Nexus: 添加连接"
3. 选择数据库类型
4. 输入连接信息：
   - 连接名称
   - 主机和端口
   - 数据库名称
   - 用户名和密码
5. 选择是否在保存前测试连接
6. 点击保存

### 执行查询

1. 打开 SQL 文件或创建新文件
2. 编写 SQL 查询
3. 点击编辑器工具栏的"运行查询"按钮
4. 从列表中选择连接
5. 在结果面板查看结果

### 浏览 Schema

1. 在连接树中展开一个连接
2. 导航数据库、Schema 和表
3. 右键点击表，选择"显示表结构"查看详细的列信息、索引和外键
4. 右键点击表，选择"显示表数据"快速浏览表数据

### 查看查询历史

1. 从命令面板运行 "DB Nexus: 显示查询历史"
2. 查看所有执行过的查询，包含时间戳、结果和错误信息（如果有）
3. 成功和失败的查询清晰可辨
4. 历史记录在 VS Code 会话间持久化

## 配置

### 设置

| 设置 | 描述 | 默认值 |
|------|------|--------|
| `dbNexus.connections` | 工作区连接配置 | `[]` |
| `dbNexus.defaultQueryLimit` | 查询默认行数限制 | `500` |
| `dbNexus.displayLanguage` | UI 语言（空=自动） | `""` |
| `dbNexus.enablePreviewDrivers` | 显示计划中的数据库驱动 | `true` |

### 语言支持

DB Nexus 支持多种语言：
- 英文 (en)
- 简体中文 (zh-CN)

设置 `dbNexus.displayLanguage` 可覆盖 VS Code 语言设置。

## 架构

DB Nexus 采用模块化架构：

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

## 支持的数据库

| 数据库 | Schema 浏览 | 查询 | 数据编辑 | 执行计划 | ER 图 |
|--------|-------------|------|----------|----------|-------|
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

图例：✅ 支持 | ⚠️ 部分 | ❌ 不支持 | 🔜 计划中

## 路线图

### v0.2.0（当前版本）
- [x] SQLite 驱动
- [x] PostgreSQL 驱动
- [x] MySQL/MariaDB 驱动
- [x] CockroachDB 驱动
- [x] ClickHouse 驱动
- [x] Schema 浏览器
- [x] 查询执行
- [x] 结果网格
- [x] Secret Storage 集成
- [x] 表结构查看
- [x] 表数据查看
- [x] 查询历史

### v0.3.0（计划中）
- [ ] 数据编辑与 SQL 预览
- [ ] 事务支持
- [ ] SQL 自动补全
- [ ] 查询历史增强（重新运行、复制 SQL 等）

### v0.4.0（计划中）
- [ ] 执行计划可视化
- [ ] ER 图生成
- [ ] 数据导入/导出
- [ ] MongoDB 支持

### v0.5.0（未来）
- [ ] AI 集成（Copilot 上下文）
- [ ] MCP 服务器
- [ ] 自然语言转 SQL
- [ ] 查询结果图表

## 贡献

欢迎贡献！提交 Pull Request 前请阅读贡献指南。

## 许可证

MIT 许可证 - 详情见 LICENSE 文件。

## 支持

- **问题反馈**: [GitHub Issues](https://github.com/kamalyes/db-nexus/issues)
- **讨论交流**: [GitHub Discussions](https://github.com/kamalyes/db-nexus/discussions)

## 致谢

构建使用：
- [sql.js](https://github.com/sql-js/sql.js/) - SQLite 编译为 JavaScript
- [node-postgres](https://github.com/brianc/node-postgres) - PostgreSQL 客户端
- [mysql2](https://github.com/sidorares/node-mysql2) - MySQL 客户端
