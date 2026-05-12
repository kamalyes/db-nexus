# 数据库支持矩阵

DB Nexus 支持多种数据库类型，包括关系型数据库、NoSQL 数据库、分析型数据库和文件数据源。

## 已实现驱动

| 数据库 | 类型 | Schema 浏览 | 查询执行 | 数据编辑 | 执行计划 | ER 图 | 导入导出 | 备份恢复 | DDL 查看 | 表元数据 |
|--------|------|:-----------:|:--------:|:--------:|:--------:|:-----:|:--------:|:--------:|:--------:|:--------:|
| PostgreSQL | 关系型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MySQL | 关系型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MariaDB | 关系型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SQLite | 关系型 | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| CockroachDB | 关系型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| DuckDB | 分析型 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ | ✅ | ✅ |
| ClickHouse | 分析型 | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ | ✅ |

图例：✅ 完全支持 | ⚠️ 部分支持 | ❌ 不支持

## 计划中驱动

### 关系型数据库

| 数据库 | 类型 | 默认端口 | 计划阶段 |
|--------|------|----------|----------|
| SQL Server | 关系型 | 1433 | M3 |
| Oracle | 关系型 | 1521 | M3 |

### NoSQL 数据库

| 数据库 | 类型 | 默认端口 | 计划阶段 |
|--------|------|----------|----------|
| MongoDB | 文档数据库 | 27017 | M3 |
| Redis | KV 数据库 | 6379 | M3 |
| Elasticsearch | 搜索引擎 | 9200 | M4 |
| Neo4j | 图数据库 | 7687 | M4 |
| Firebase | 文档数据库 | - | M4 |
| DynamoDB | 文档数据库 | - | M4 |

### 云数据仓库

| 数据库 | 类型 | 计划阶段 |
|--------|------|----------|
| Snowflake | 云数仓 | M4 |
| BigQuery | 云数仓 | M4 |
| Databricks | 云数仓 | M4 |

### 文件数据源

| 格式 | 说明 | 计划阶段 |
|------|------|----------|
| CSV | 逗号分隔值文件 | M3 |
| Excel | Microsoft Excel 文件 | M3 |
| JSON | JSON 文件 | M3 |
| Parquet | 列式存储格式 | M4 |
| Avro | 数据序列化格式 | M4 |

## 能力说明

### Schema 浏览

支持浏览数据库对象层级结构：
- 数据库 / Schema
- 表 / 视图 / 物化视图
- 字段 / 索引 / 外键
- 存储过程 / 函数

不同数据库的层级模型：

| 数据库 | 层级结构 | 说明 |
|--------|----------|------|
| PostgreSQL | database → schema → table | database 和 schema 独立 |
| CockroachDB | database → schema → table | 继承 PostgreSQL 层级 |
| MySQL / MariaDB | database → table | schema 等同于 database |
| ClickHouse | database → table | 单层结构 |
| SQLite | table | 无层级 |
| DuckDB | schema → table | 单层结构 |

### 查询执行

- SQL 编辑器语法高亮
- 查询结果表格展示
- 分页、排序、过滤
- 查询历史记录
- 多语句执行
- SQL 文件执行

### 数据编辑

- 表数据网格编辑
- INSERT / UPDATE / DELETE
- 变更 SQL 预览
- 批量操作支持

### 执行计划

- PostgreSQL: `EXPLAIN ANALYZE`
- MySQL: `EXPLAIN FORMAT=JSON`
- SQLite: `EXPLAIN QUERY PLAN`
- ClickHouse: `EXPLAIN`
- DuckDB: `EXPLAIN`
- 可视化节点树展示

### ER 图

- 自动检测外键关系
- 表关系可视化
- 导出为图片

### 导入导出

- CSV 格式
- JSON 格式
- SQL INSERT 语句

### 备份恢复

- 数据库完整备份（结构/数据/两者）
- SQL / JSON 格式输出
- 数据恢复（支持覆盖/保留现有表）
- PostgreSQL / MySQL / MariaDB / SQLite / CockroachDB 支持

### DDL 查看

- 查看 CREATE TABLE 语句
- 支持表、视图、索引、触发器、存储过程、函数
- 所有已实现驱动均支持

### 数据迁移

- 跨数据库数据迁移
- 可选迁移内容（结构/数据/两者）
- 可配置批次大小
- 冲突处理策略（覆盖/保留）

### 架构对比

- 两个连接的 Schema 差异对比
- 检测表、列、索引、外键差异
- 差异类型分类展示

### 表元数据

每种驱动支持查询表级元数据：

#### PostgreSQL

| 字段 | 说明 |
|------|------|
| tableRows | 估计行数 |
| owner | 表所有者 |
| dataLength | 数据大小 |
| indexLength | 索引大小 |
| totalLength | 总大小 |
| serverVersion | 服务器版本 |
| charset | 字符集 |
| activeSessions | 活跃会话数 |

#### MySQL / MariaDB

| 字段 | 说明 |
|------|------|
| engine | 存储引擎 |
| tableRows | 行数 |
| autoIncrement | 自增值 |
| dataLength | 数据大小 |
| indexLength | 索引大小 |
| tableCollation | 排序规则 |
| serverVersion | 服务器版本 |
| activeSessions | 活跃会话数 |

#### SQLite

| 字段 | 说明 |
|------|------|
| serverVersion | SQLite 版本 |
| charset | 编码方式 |
| schemaVersion | Schema 版本 |
| pageCount | 页数 |
| pageSize | 页大小 |
| dataLength | 数据大小 |
| databaseSize | 数据库文件大小 |

#### ClickHouse

| 字段 | 说明 |
|------|------|
| engine | 表引擎 |
| tableRows | 行数 |
| dataLength | 数据大小 |
| serverVersion | 服务器版本 |
| primaryKeys | 主键表达式 |
| sortingKey | 排序键 |
| partitionKey | 分区键 |
| createSql | CREATE TABLE 语句 |

#### DuckDB

| 字段 | 说明 |
|------|------|
| serverVersion | DuckDB 版本 |
| tableRows | 估计行数 |
| columnCount | 列数 |
| indexCount | 索引数 |
| databaseSize | 数据库文件大小 |
| createSql | CREATE TABLE 语句 |

#### CockroachDB

继承 PostgreSQL 元数据字段，差异见 [CockroachDB 驱动说明](#cockroachdb-驱动说明)。

## 驱动能力矩阵

不同数据库驱动声明的能力：

```typescript
// PostgreSQL / MySQL / MariaDB / CockroachDB
{
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

// SQLite
{
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

// DuckDB
{
  schemaBrowse: true,
  query: true,
  dataEdit: true,
  transactions: true,
  explain: true,
  erd: true,
  importExport: true,
  backupRestore: false,
  streaming: false
}

// ClickHouse
{
  schemaBrowse: true,
  query: true,
  dataEdit: false,
  transactions: false,
  explain: true,
  erd: false,
  importExport: true,
  backupRestore: false,
  streaming: false
}
```

## 数据库连接参数

### PostgreSQL

| 参数 | 说明 | 默认值 |
|------|------|--------|
| host | 主机地址 | localhost |
| port | 端口号 | 5432 |
| database | 数据库名 | postgres |
| username | 用户名 | - |
| password | 密码 | - |
| ssl | SSL 连接 | false |
| connectTimeout | 连接超时（秒） | 30 |

### MySQL / MariaDB

| 参数 | 说明 | 默认值 |
|------|------|--------|
| host | 主机地址 | localhost |
| port | 端口号 | 3306 |
| database | 数据库名 | - |
| username | 用户名 | root |
| password | 密码 | - |
| ssl | SSL 连接 | false |
| connectTimeout | 连接超时（秒） | 30 |

### SQLite

| 参数 | 说明 |
|------|------|
| filePath | 数据库文件路径（:memory: 为内存模式） |

### CockroachDB

| 参数 | 说明 | 默认值 |
|------|------|--------|
| host | 主机地址 | localhost |
| port | 端口号 | 26257 |
| database | 数据库名 | defaultdb |
| username | 用户名 | root |
| password | 密码 | - |
| ssl | SSL 连接 | true |
| connectTimeout | 连接超时（秒） | 30 |

### ClickHouse

| 参数 | 说明 | 默认值 |
|------|------|--------|
| host | 主机地址 | localhost |
| port | HTTP 端口 | 8123 |
| database | 数据库名 | default |
| username | 用户名 | default |
| password | 密码 | - |
| connectTimeout | 连接超时（秒） | 30 |
| readTimeout | 读取超时（秒） | 30 |

### DuckDB

| 参数 | 说明 |
|------|------|
| filePath | 数据库文件路径（:memory: 为内存模式） |

### 高级配置（所有驱动通用）

| 参数 | 说明 | 默认值 |
|------|------|--------|
| clientDriver | 客户端驱动程序 | default |
| charset | 客户端字符集 | auto |
| keepAliveInterval | 保持连接间隔（秒） | 240 |
| connectTimeout | 连接超时（秒） | 30 |
| readTimeout | 读取超时（秒） | 30 |
| writeTimeout | 写入超时（秒） | 30 |
| useCompression | 使用压缩 | false |
| autoConnect | 自动连接 | false |
| initialQuery | 初始查询 | - |
| note | 备注 | - |

## CockroachDB 驱动说明

CockroachDB 驱动继承自 PostgreSQL 驱动，主要差异：

| 特性 | PostgreSQL | CockroachDB |
|------|-----------|-------------|
| 默认端口 | 5432 | 26257 |
| 默认数据库 | postgres | defaultdb |
| 默认用户 | - | root |
| SSL 默认 | false | true |
| 数据库列表 | `pg_database` 查询 | `pg_database` 查询 |
| 连接池 | 按 profileId + database 隔离 | 按 profileId + database 隔离 |
