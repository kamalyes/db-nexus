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
  "connection": {
    "added": "Connection added: {0}",
    "deleted": "Connection deleted: {0}",
    "testSuccess": "Connection successful ({0}ms)",
    "testFailed": "Connection failed: {0}"
  },
  "query": {
    "failed": "Query failed: {0}",
    "empty": "Please enter a SQL query",
    "resultTitle": "Query Result - {0}"
  },
  "table": {
    "columns": "Columns",
    "indexes": "Indexes",
    "foreignKeys": "Foreign Keys",
    "schemaTitle": "Table Schema: {0}"
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
