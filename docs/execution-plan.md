# 开发计划

DB Nexus 采用里程碑式开发，每个里程碑都能独立运行和交付。

## 里程碑概览

| 里程碑 | 目标 | 状态 |
|--------|------|------|
| M0 | 项目骨架与架构 | ✅ 已完成 |
| M1 | SQL 查询闭环 | ✅ 已完成 |
| M2 | 数据查看与编辑 | 🚧 进行中 |
| M3 | 分析与生产力 | 📋 计划中 |
| M4 | AI 与生态 | 📋 计划中 |

---

## M0: 项目骨架 ✅

**目标**：建立独立 VS Code 插件项目和长期架构文档。

**交付内容**：
- [x] `package.json` 扩展配置
- [x] 核心类型定义 (`src/core/types.ts`)
- [x] 驱动注册机制 (`src/drivers/registry.ts`)
- [x] 连接存储服务 (`src/core/connectionStore.ts`)
- [x] 国际化框架 (`src/i18n/`)
- [x] 架构文档 (`docs/`)

**验收标准**：
- `npm run build` 通过
- 扩展可在 VS Code 中激活
- 命令标题支持中英文

---

## M1: SQL 查询闭环 ✅

**目标**：跑通最小数据库查询链路。

**交付内容**：
- [x] SQLite 驱动
- [x] PostgreSQL 驱动
- [x] MySQL / MariaDB 驱动
- [x] CockroachDB 驱动
- [x] ClickHouse 驱动
- [x] DuckDB 驱动
- [x] 连接管理面板
- [x] 连接测试功能
- [x] Schema 树形浏览
- [x] SQL 查询执行
- [x] 结果表格展示
- [x] 查询历史记录
- [x] 表结构查看
- [x] 表数据浏览

**验收标准**：
- 能连接 SQLite 文件并执行 `SELECT 1`
- 能连接 PostgreSQL 并列出 Schema/Table
- 能连接 MySQL 并列出 Database/Table
- 能连接 CockroachDB 执行基础查询
- 能连接 ClickHouse 执行只读分析查询
- 查询结果可分页展示

---

## M2: 数据查看与编辑 🚧

**目标**：从查询工具演进为数据库客户端。

**交付内容**：
- [x] 表数据网格编辑
- [x] 数据过滤、排序、分页
- [x] INSERT / UPDATE / DELETE 预览
- [ ] 事务提交/回滚
- [ ] MongoDB 浏览器
- [ ] Redis Key 浏览器
- [ ] SQL Server 驱动
- [ ] CSV / JSON 文件支持

**验收标准**：
- 表数据可以网格方式查看和编辑
- 单行编辑生成可预览 SQL
- 危险变更需要确认
- MongoDB 文档可展开查看
- Redis Key 可按 Pattern 浏览

---

## M3: 分析与生产力 📋

**目标**：补齐高级数据库客户端能力。

**交付内容**：
- [ ] 查询历史增强（搜索、重新执行）
- [ ] 参数化查询支持
- [ ] 执行计划可视化
- [ ] ER 图生成
- [ ] 数据对比
- [ ] CSV / Excel / JSON / Parquet 导入导出
- [ ] Elasticsearch 驱动
- [ ] Oracle 驱动

**验收标准**：
- 查询历史可搜索、可重新执行
- PostgreSQL/MySQL 执行计划可视化
- 关系型数据库可生成 ER 图
- 两个表可比较差异并生成同步脚本

---

## M4: AI 与生态 📋

**目标**：成为 AI-Ready 数据库工作台。

**交付内容**：
- [ ] MCP Server
- [ ] Copilot Chat Context Provider
- [ ] 自然语言生成 SQL
- [ ] Inline SQL 补全
- [ ] Schema 感知 Prompt Builder
- [ ] 认证配置（SSH Tunnel、OAuth）
- [ ] 安全报告分享
- [ ] Snowflake / BigQuery / Databricks 驱动
- [ ] Neo4j / Cassandra / DynamoDB 驱动

**验收标准**：
- AI 可读取当前连接 Schema Context
- MCP 客户端可查询 Schema Metadata
- 自然语言生成 SQL 时感知数据库方言
- 分享报告不包含连接凭据

---

## 实现原则

1. **驱动优先只读**：每个驱动先实现只读查询，再实现数据编辑
2. **敏感信息隔离**：密码只进入 VS Code SecretStorage
3. **差异下沉驱动**：数据库差异放在 Driver，通用体验放在 Service
4. **Webview 无状态**：Webview 只负责展示，不直接连接数据库
5. **核心链路优先**：先跑通可靠的核心功能，再做视觉和高级能力

---

## 版本规划

| 版本 | 包含里程碑 | 发布时间 |
|------|------------|----------|
| v0.1.0 | M0 | 已发布 |
| v0.2.0 | M1 | 已发布 |
| v0.3.0 | M2 | 计划中 |
| v0.4.0 | M3 | 计划中 |
| v0.5.0 | M4 | 计划中 |
| v1.0.0 | M0-M4 稳定版 | 未来 |
