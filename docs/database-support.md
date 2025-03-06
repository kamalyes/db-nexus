# 数据库支持矩阵

DB Nexus 支持多种数据库类型，包括关系型数据库、NoSQL 数据库、分析型数据库和文件数据源。

## 已实现驱动

| 数据库 | 类型 | Schema 浏览 | 查询执行 | 数据编辑 | 执行计划 | ER 图 | 导入导出 | 备份恢复 |
|--------|------|:-----------:|:--------:|:--------:|:--------:|:-----:|:--------:|:--------:|
| PostgreSQL | 关系型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MySQL | 关系型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| MariaDB | 关系型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SQLite | 关系型 | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| CockroachDB | 关系型 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| DuckDB | 分析型 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ❌ |
| ClickHouse | 分析型 | ✅ | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ |

图例：✅ 完全支持 | ⚠️ 部分支持 | ❌ 不支持

## 计划中驱动

### 关系型数据库

| 数据库 | 类型 | 默认端口 | 计划阶段 |
|--------|------|----------|----------|
| SQL Server | 关系型 | 1433 | M2 |
| Oracle | 关系型 | 1521 | M3 |

### NoSQL 数据库

| 数据库 | 类型 | 默认端口 | 计划阶段 |
|--------|------|----------|----------|
| MongoDB | 文档数据库 | 27017 | M2 |
| Redis | KV 数据库 | 6379 | M2 |
| Elasticsearch | 搜索引擎 | 9200 | M3 |
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
| CSV | 逗号分隔值文件 | M2 |
| Excel | Microsoft Excel 文件 | M2 |
| JSON | JSON 文件 | M2 |
| Parquet | 列式存储格式 | M3 |
| Avro | 数据序列化格式 | M3 |

## 能力说明

### Schema 浏览

支持浏览数据库对象层级结构：
- 数据库 / Schema
- 表 / 视图 / 物化视图
- 字段 / 索引 / 外键
- 存储过程 / 函数

### 查询执行

- SQL 编辑器语法高亮
- 查询结果表格展示
- 分页、排序、过滤
- 查询历史记录
- 多语句执行

### 数据编辑

- 表数据网格编辑
- INSERT / UPDATE / DELETE
- 变更 SQL 预览
- 批量操作支持

### 执行计划

- PostgreSQL: `EXPLAIN ANALYZE`
- MySQL: `EXPLAIN FORMAT=JSON`
- SQLite: `EXPLAIN QUERY PLAN`
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

- 数据库完整备份
- 数据恢复
- 跨数据库迁移

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
  explain: true,    // 部分支持
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
  erd: true,        // 部分支持
  importExport: true,
  backupRestore: false,
  streaming: false
}

// ClickHouse
{
  schemaBrowse: true,
  query: true,
  dataEdit: false,  // OLAP 数据库不支持行级编辑
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

### MySQL / MariaDB

| 参数 | 说明 | 默认值 |
|------|------|--------|
| host | 主机地址 | localhost |
| port | 端口号 | 3306 |
| database | 数据库名 | - |
| username | 用户名 | root |
| password | 密码 | - |
| ssl | SSL 连接 | false |

### SQLite

| 参数 | 说明 |
|------|------|
| filePath | 数据库文件路径 |

### CockroachDB

| 参数 | 说明 | 默认值 |
|------|------|--------|
| host | 主机地址 | localhost |
| port | 端口号 | 26257 |
| database | 数据库名 | defaultdb |
| username | 用户名 | root |
| password | 密码 | - |
| ssl | SSL 连接 | true |

### ClickHouse

| 参数 | 说明 | 默认值 |
|------|------|--------|
| host | 主机地址 | localhost |
| port | HTTP 端口 | 8123 |
| database | 数据库名 | default |
| username | 用户名 | default |
| password | 密码 | - |

### DuckDB

| 参数 | 说明 |
|------|------|
| filePath | 数据库文件路径（:memory: 为内存模式） |
