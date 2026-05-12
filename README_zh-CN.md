# DB Nexus

中文文档 | [English](README.md)

一个强大的多数据库工作台，支持 VS Code、Cursor、Windsurf 等 VS Code 系编辑器。

## 功能特性

### 多数据库支持
- **PostgreSQL** - 完整支持 Schema 浏览、查询执行、数据编辑，连接池多数据库隔离
- **MySQL / MariaDB** - 完整支持 MySQL 5.7+ 和 MariaDB 10.x（MariaDB 继承 MySQL 驱动）
- **SQLite** - 本地数据库文件支持，支持内存模式
- **CockroachDB** - 分布式 SQL 数据库（PostgreSQL 协议兼容，继承 PG 驱动）
- **DuckDB** - 进程内分析型数据库，支持文件和内存模式
- **ClickHouse** - OLAP 分析型数据库（HTTP 协议，支持 Data Skipping Index）

### 核心能力
- 🔌 **连接管理** - 使用 VS Code SecretStorage 安全存储凭据，智能默认命名
- 📊 **Schema 浏览器** - 浏览数据库、Schema、表、视图和函数，支持多层级结构
- 📝 **SQL 编辑器** - 带语法高亮的查询执行，支持结果分页
- 📋 **结果网格** - 可排序、可过滤的表格展示查询结果，显示总行数
- 📜 **查询历史** - 跟踪所有执行过的查询，包含时间戳、连接信息和耗时
- ✏️ **数据编辑** - 表数据网格编辑，支持 INSERT/UPDATE/DELETE 预览和变更计划
- 📈 **执行计划** - 查询执行计划可视化，支持成本和时间分析
- 🔗 **ER 图** - 根据外键关系自动生成实体关系图
- 📦 **导入导出** - 支持 CSV、JSON、SQL 格式，向导式工作流
- 🌐 **国际化** - 支持英文和简体中文（56 个命令完整翻译）

### 表管理
- 📋 **打开表** - 分页浏览表数据，支持过滤和排序
- 🏗️ **设计表** - 分栏布局查看表结构，包含列、索引、外键详情
- ➕ **创建表** - 可视化创建新表
- ✏️ **重命名表** - 重命名已有表
- 🗑️ **删除表** - 确认后删除表
- 🧹 **清空表** - 清除所有表数据
- 📄 **查看 DDL** - 查看 CREATE TABLE 语句（支持表、视图、索引、触发器、存储过程、函数）

### SQL 模板生成器
- 🔍 **SELECT 模板** - 自动生成查询语句，支持分页语法（MySQL/PG/Oracle/SQL Server）
- ➕ **INSERT 模板** - 自动填充字段和示例值（排除自增列）
- ✏️ **UPDATE 模板** - 主键感知的 WHERE 条件生成
- 🗑️ **DELETE 模板** - 安全删除语句模板
- 🔢 **统计行数** - 一键获取表记录总数

### 列与索引操作
- ✏️ **重命名列** - 使用 ALTER TABLE 重命名列
- 🗑️ **删除列** - 确认后删除列
- 📋 **复制列名** - 快速复制到剪贴板
- ➕ **创建索引** - 在表上创建新索引（普通/唯一）
- 🗑️ **删除索引** - 确认后删除索引
- 📋 **复制索引名** - 快速复制到剪贴板

### 高级连接配置
- 🔌 **客户端驱动** - 选择 native 或 HTTP 驱动模式
- 🔤 **字符集** - 配置客户端字符集（auto/utf8/utf8mb4）
- ⏱️ **超时控制** - 精细化连接/读取/写入超时设置
- 💓 **保持连接** - 自定义心跳间隔
- 🗜️ **压缩传输** - 启用网络压缩
- 🚀 **自动连接** - 启动时自动连接
- 📝 **初始查询** - 连接后自动执行 SQL
- 📌 **备注** - 为连接添加说明

### 表结构面板
- 📐 **分栏布局** - 表格 + 详情侧边栏
- 📋 **列详情** - 类型、长度、默认值、注释、字符集、可空、自增
- 📊 **表信息** - 引擎、行数、自增值、数据大小、索引大小、所有者、创建/修改时间
- 🔑 **索引详情** - 索引类型、包含列、唯一性、主键标记
- 🔗 **外键详情** - 引用表、关联列、级联规则（ON UPDATE/ON DELETE）
- 📝 **DDL 预览** - 实时生成 CREATE TABLE 语句
- 🗄️ **数据库信息** - 服务器版本、字符集、排序规则、活跃会话

### 数据库级操作
- 📋 **查看表列表** - 浏览数据库/Schema 中的所有表，支持搜索
- ➕ **创建表** - 在数据库/Schema 级别创建表
- 📖 **数据字典** - 生成 Markdown 格式数据字典
- 📄 **执行 SQL 文件** - 执行 SQL 文件
- 🔍 **搜索数据库** - 跨数据库对象搜索

### 备份与迁移
- 💾 **备份数据库** - 完整备份，可选结构/数据（SQL/JSON 格式）
- 📥 **恢复数据库** - 从备份文件恢复（覆盖/保留现有表）
- 🔄 **数据迁移** - 跨数据库迁移，支持批量处理和 DDL 适配
- 🔀 **架构对比** - 对比两个连接的 Schema 差异（表/列/索引/外键差异检测）

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
4. 配置高级选项（超时、字符集等）
5. 保存前测试连接
6. 点击保存

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
- 支持 SSL/TLS 加密连接（CockroachDB 默认启用）
- 危险操作需要确认
- 数据变更前展示变更计划预览
- 删除连接时调用 `driver.dispose()` 清理驱动资源

## 路线图

详细路线图请查看 [开发计划](docs/execution-plan.md)。

| 版本 | 状态 |
|------|------|
| v0.1.0 - 项目骨架 | ✅ 已发布 |
| v0.2.0 - SQL 查询闭环 | ✅ 已发布 |
| v0.3.0 - 数据编辑 | ✅ 已发布 |
| v0.4.0 - 分析与生产力 | 🚧 进行中 |
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
- [mysql2](https://github.com/sidorares/mysql2) - MySQL 客户端
- [duckdb](https://github.com/duckdb/duckdb-node) - DuckDB Node.js 绑定
