# DB Nexus

中文文档 | [English](README.md)

一个强大的多数据库工作台，支持 VS Code、Cursor、Windsurf 等 VS Code 系编辑器。

## 功能特性

### 多数据库支持
- **PostgreSQL** - 完整支持 Schema 浏览、查询执行和数据编辑
- **MySQL / MariaDB** - 完整支持 MySQL 5.7+ 和 MariaDB 10.x
- **SQLite** - 本地数据库文件支持
- **CockroachDB** - 分布式 SQL 数据库（PostgreSQL 协议兼容）
- **DuckDB** - 进程内分析型数据库
- **ClickHouse** - OLAP 分析型数据库

### 核心能力
- 🔌 **连接管理** - 使用 VS Code SecretStorage 安全存储凭据
- 📊 **Schema 浏览器** - 浏览数据库、Schema、表、视图和函数
- 📝 **SQL 编辑器** - 带语法高亮的查询执行
- 📋 **结果网格** - 可排序、可过滤的表格展示查询结果
- 📜 **查询历史** - 跟踪所有执行过的查询，包含时间戳
- ✏️ **数据编辑** - 表数据网格编辑，支持 INSERT/UPDATE/DELETE 预览
- 📈 **执行计划** - 查询执行计划可视化
- 🔗 **ER 图** - 自动生成实体关系图
- 📦 **导入导出** - 支持 CSV、JSON、SQL 格式
- 🌐 **国际化** - 支持英文和简体中文

## 快速开始

### 安装

1. 打开 VS Code
2. 进入扩展（`Ctrl+Shift+X`）
3. 搜索 "DB Nexus"
4. 点击安装

### 添加连接

1. 点击侧边栏的 DB Nexus 图标
2. 点击 "+" 按钮或运行 `DB Nexus: 添加连接`
3. 选择数据库类型并输入连接信息
4. 保存前测试连接
5. 点击保存

### 执行查询

1. 打开 SQL 文件或创建新文件
2. 编写 SQL 查询
3. 点击编辑器工具栏的"运行查询"按钮
4. 从列表中选择连接
5. 在结果面板查看结果

## 文档

| 文档 | 说明 |
|------|------|
| [架构设计](docs/architecture.md) | 系统架构和设计原则 |
| [数据库支持](docs/database-support.md) | 支持的数据库和能力矩阵 |
| [开发计划](docs/execution-plan.md) | 开发路线图和里程碑 |
| [国际化设计](docs/localization.md) | 国际化设计方案 |

## 配置

| 设置 | 说明 | 默认值 |
|------|------|--------|
| `dbNexus.connections` | 工作区连接配置 | `[]` |
| `dbNexus.defaultQueryLimit` | 查询默认行数限制 | `500` |
| `dbNexus.displayLanguage` | UI 语言（空=自动） | `""` |
| `dbNexus.enablePreviewDrivers` | 显示计划中的数据库驱动 | `true` |

## 安全性

- 密码存储在 VS Code SecretStorage（操作系统级加密）
- 连接配置存储在工作区设置中，不包含敏感数据
- 支持 SSL/TLS 加密连接
- 危险操作需要确认

## 路线图

详细路线图请查看 [开发计划](docs/execution-plan.md)。

| 版本 | 状态 |
|------|------|
| v0.1.0 - 项目骨架 | ✅ 已发布 |
| v0.2.0 - SQL 查询闭环 | ✅ 已发布 |
| v0.3.0 - 数据编辑 | 🚧 进行中 |
| v0.4.0 - 分析与生产力 | 📋 计划中 |
| v0.5.0 - AI 与生态 | 📋 计划中 |

## 贡献

欢迎贡献！提交 Pull Request 前请阅读贡献指南。

## 许可证

MIT 许可证 - 详情见 [LICENSE](LICENSE) 文件。

## 支持

- **问题反馈**: [GitHub Issues](https://github.com/kamalyes/db-nexus/issues)
- **讨论交流**: [GitHub Discussions](https://github.com/kamalyes/db-nexus/discussions)

## 致谢

构建使用：
- [sql.js](https://github.com/sql-js/sql.js/) - SQLite 编译为 JavaScript
- [node-postgres](https://github.com/brianc/node-postgres) - PostgreSQL 客户端
- [mysql2](https://github.com/sidorares/node-mysql2) - MySQL 客户端
- [duckdb](https://github.com/duckdb/duckdb-node) - DuckDB Node.js 绑定
