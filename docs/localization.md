# 国际化设计

DB Nexus 支持多语言界面，国际化只负责插件 UI 文案，不影响数据库内容、查询结果或用户数据。

## 设计目标

- 命令标题、视图名称、配置说明跟随 VS Code 语言
- 运行时提示、输入框、QuickPick、Webview 支持多语言
- 新增语言无需修改业务代码
- 默认跟随 VS Code 语言，支持用户覆盖

## 语言资源分层

| 资源 | 用途 | 示例 |
|------|------|------|
| `package.nls.json` | VS Code 扩展清单默认文案 | 命令标题、视图名称、配置说明 |
| `package.nls.zh-cn.json` | VS Code 扩展清单中文文案 | 中文命令标题、中文配置说明 |
| `locales/en.json` | 运行时英文文案 | 提示消息、表单标签、错误信息 |
| `locales/zh-CN.json` | 运行时中文文案 | 提示消息、表单标签、错误信息 |
| `src/i18n/index.ts` | 运行时加载和格式化 | `t('query.failed', message)` |

## 语言选择优先级

1. 用户配置 `dbNexus.displayLanguage`
2. VS Code 当前语言 `env.language`
3. 默认英文 `en`

如果某个语言文件不存在，运行时自动回退到英文。

## 文案组织结构

运行时文案按功能域组织：

```json
{
  "dashboard": {
    "title": "连接管理",
    "refresh": "刷新",
    "addConnection": "添加连接",
    "noConnections": "暂无连接"
  },
  "form": {
    "addConnection": "添加连接",
    "editConnection": "编辑连接",
    "connectionName": "连接名称",
    "host": "主机",
    "port": "端口"
  },
  "connection": {
    "added": "连接已添加：{0}",
    "deleted": "连接已删除：{0}",
    "testSuccess": "连接成功（{0} 毫秒）",
    "testFailed": "连接失败：{0}"
  },
  "query": {
    "failed": "查询失败：{0}",
    "empty": "请输入 SQL 查询",
    "resultTitle": "查询结果 - {0}"
  },
  "table": {
    "columns": "列",
    "indexes": "索引",
    "foreignKeys": "外键",
    "schemaTitle": "表结构：{0}",
    "renamed": "表已重命名：{0} → {1}",
    "truncated": "表已清空：{0}",
    "columnRenamed": "列已重命名：{0} → {1}",
    "indexCreated": "索引已创建：{0}",
    "indexDropped": "索引已删除：{0}"
  },
  "schema": {
    "info": "信息",
    "columns": "列",
    "indexes": "索引",
    "foreignKeys": "外键",
    "ddl": "DDL"
  },
  "executionPlan": {
    "title": "执行计划",
    "totalCost": "总成本",
    "estimatedRows": "预估行数",
    "executionTime": "执行时间",
    "notSupported": "该驱动不支持执行计划",
    "failed": "获取执行计划失败：{0}"
  },
  "ddl": {
    "selectObject": "请选择一个数据库对象",
    "notSupported": "该驱动不支持 DDL 查看",
    "failed": "获取 DDL 失败：{0}"
  },
  "erd": {
    "title": "ER 图",
    "notSupported": "该驱动不支持 ER 图生成",
    "failed": "生成 ER 图失败：{0}"
  },
  "backup": {
    "notSupported": "该驱动不支持备份",
    "inProgress": "正在备份数据库...",
    "preparing": "准备备份...",
    "exportingSchema": "导出结构...",
    "exportingData": "导出数据...",
    "writingFile": "写入文件...",
    "completed": "备份完成",
    "success": "备份已保存到 {0}",
    "selectContent": "选择备份内容",
    "selectFormat": "选择备份格式",
    "schemaAndData": "结构和数据",
    "schemaOnly": "仅结构",
    "dataOnly": "仅数据"
  },
  "restore": {
    "notSupported": "该驱动不支持恢复",
    "inProgress": "正在恢复数据库...",
    "preparing": "准备恢复...",
    "executingStatement": "执行语句 {0}/{1}...",
    "processingItem": "处理项目 {0}/{1}...",
    "completed": "恢复完成",
    "success": "数据库已从 {0} 恢复",
    "selectFormat": "选择恢复格式",
    "selectOption": "选择恢复选项",
    "dropExisting": "删除现有表",
    "keepExisting": "保留现有表"
  },
  "compare": {
    "title": "结构对比",
    "notSupported": "一个或两个驱动不支持结构对比",
    "needTwoConnections": "至少需要两个连接才能进行对比",
    "selectSource": "选择源连接",
    "selectTarget": "选择目标连接",
    "source": "源",
    "target": "目标",
    "sourceTables": "源表数",
    "targetTables": "目标表数",
    "differences": "差异数",
    "noDifferences": "未发现差异 - 结构完全相同"
  },
  "migration": {
    "inProgress": "正在迁移数据...",
    "preparing": "准备迁移...",
    "processingTable": "处理表：{0}",
    "migratingRows": "从 {0} 迁移行（偏移：{1}）...",
    "tableCompleted": "完成 {0}：已迁移 {1} 行",
    "completed": "迁移完成",
    "success": "数据迁移成功完成",
    "needTwoConnections": "至少需要两个连接才能进行迁移",
    "selectSource": "选择源连接",
    "selectTarget": "选择目标连接",
    "selectContent": "选择要迁移的内容",
    "selectOption": "选择迁移选项",
    "batchSizePrompt": "数据迁移的批次大小",
    "invalidBatchSize": "请输入有效的正数"
  }
}
```

业务代码使用 Key 引用：

```typescript
window.showErrorMessage(t('query.failed', message))
window.showInformationMessage(t('connection.testSuccess', latencyMs))
```

## 已支持语言

| 语言 | VS Code 清单 | 运行时资源 | 状态 |
|------|--------------|------------|------|
| English | `package.nls.json` | `locales/en.json` | ✅ 已实现 |
| 简体中文 | `package.nls.zh-cn.json` | `locales/zh-CN.json` | ✅ 已实现 |

## 国际化覆盖范围

### 命令标题

所有 55+ 命令标题均支持中英文：

| 命令 | 英文 | 中文 |
|------|------|------|
| `dbNexus.addConnection` | Add Connection | 添加连接 |
| `dbNexus.runQuery` | Run Query | 运行查询 |
| `dbNexus.openTable` | Open Table | 打开表 |
| `dbNexus.showTableSchema` | Show Table Schema | 查看表结构 |
| `dbNexus.showTableData` | Show Table Data | 查看表数据 |
| `dbNexus.showTableList` | Show Table List | 查看表列表 |
| `dbNexus.renameTable` | Rename Table | 重命名表 |
| `dbNexus.truncateTable` | Truncate Table | 清空表 |
| `dbNexus.openSelectSql` | Open SELECT SQL | 打开 SELECT 语句 |
| `dbNexus.openInsertSql` | Open INSERT SQL | 打开 INSERT 语句 |
| `dbNexus.openUpdateSql` | Open UPDATE SQL | 打开 UPDATE 语句 |
| `dbNexus.openDeleteSql` | Open DELETE SQL | 打开 DELETE 语句 |
| `dbNexus.countRows` | Count Rows | 统计行数 |
| `dbNexus.createIndex` | Create Index | 创建索引 |
| `dbNexus.dropColumn` | Drop Column | 删除列 |
| `dbNexus.showDDL` | Show DDL | 查看 DDL |
| `dbNexus.showDataDictionary` | Show Data Dictionary | 查看数据字典 |
| `dbNexus.runSqlFile` | Run SQL File | 执行 SQL 文件 |
| `dbNexus.searchDatabase` | Search Database | 搜索数据库 |
| `dbNexus.showExecutionPlan` | Show Execution Plan | 查看执行计划 |
| `dbNexus.showERDiagram` | Show ER Diagram | 查看 ER 图 |
| `dbNexus.backupDatabase` | Backup Database | 备份数据库 |
| `dbNexus.restoreDatabase` | Restore Database | 恢复数据库 |
| `dbNexus.compareSchemas` | Compare Schemas | 对比架构 |
| `dbNexus.migrateData` | Migrate Data | 迁移数据 |
| `dbNexus.exportToCSV` | Export to CSV | 导出 CSV |
| `dbNexus.exportToJSON` | Export to JSON | 导出 JSON |
| `dbNexus.exportToSQL` | Export to SQL | 导出 SQL |
| `dbNexus.importFromCSV` | Import from CSV | 导入 CSV |
| `dbNexus.importFromJSON` | Import from JSON | 导入 JSON |

### Webview 国际化

所有 Webview 组件均支持中英文：

- 连接管理面板：表单标签、按钮文案、状态提示
- 表结构面板：列详情、索引详情、外键详情、DDL 预览
- 查询结果面板：列标题、分页信息、状态提示
- 表数据面板：数据网格、过滤排序、编辑操作
- 表列表面板：表列表、搜索、操作按钮
- 执行计划面板：节点树、成本信息、执行时间
- ER 图面板：表关系、布局控制
- 架构对比面板：源/目标选择、差异列表
- 查询历史面板：历史列表、搜索、清除

### 树视图国际化

连接树视图的节点标签和上下文菜单均支持中英文。

### 服务层国际化

所有服务层提示消息均支持中英文：

- 备份恢复服务：进度提示、完成消息、错误信息
- 数据迁移服务：迁移进度、批次处理、完成消息
- 数据导出服务：导出格式、成功/失败消息
- 数据导入服务：导入格式、成功/失败消息

## 新增语言流程

1. 创建 `package.nls.<locale>.json` 文件
2. 创建 `locales/<locale>.json` 文件
3. 在 `package.json` 的 `dbNexus.displayLanguage` 枚举中添加语言选项
4. 运行 `npm run lint` 验证
5. 运行 `npm run build` 构建

## 配置项

用户可通过设置覆盖语言：

```json
{
  "dbNexus.displayLanguage": "zh-CN"
}
```

可选值：
- `""` - 自动跟随 VS Code 语言（默认）
- `"en"` - 强制英文
- `"zh-CN"` - 强制简体中文

## 实现细节

### 初始化

```typescript
import { initI18n } from '@/i18n'

export function activate(context: ExtensionContext) {
  initI18n(context.extensionPath)
}
```

### 翻译函数

```typescript
import { t } from '@/i18n'

const message = t('connection.testSuccess', 150)
```

### 参数格式化

支持位置参数 `{0}`, `{1}`, `{2}` ...

```typescript
t('connection.added', connectionName)
t('query.resultTitle', profileName)
t('table.renamed', oldName, newName)
t('migration.tableCompleted', tableName, rowCount)
t('restore.executingStatement', current, total)
```

### 语言切换

监听配置变更，运行时切换语言：

```typescript
workspace.onDidChangeConfiguration(event => {
  if (event.affectsConfiguration('dbNexus.displayLanguage')) {
    reloadI18n()
    connectionsTreeProvider?.refresh()
    window.showInformationMessage(t('i18n.languageChanged', getCurrentLanguage()))
  }
})
```

## Webview 国际化

Webview 通过消息传递实现国际化：

```typescript
panel.webview.postMessage({
  type: 'locale',
  data: {
    columns: t('table.columns'),
    indexes: t('table.indexes')
  }
})
```

## 注意事项

- 不翻译数据库返回的数据（表名、字段名、数据值）
- 不翻译 SQL 语句
- 错误消息翻译原始错误信息，保留技术细节
- 保持 Key 命名一致性（camelCase）
- 新增功能必须同步更新中英文文案
