import fs from 'fs'
import path from 'path'
import type { SqlJsStatic } from 'sql.js'

export type InitSqlJs = (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>

export function getSqlJsFilePath(extensionPath: string, file: string): string {
  const packagedPath = path.join(extensionPath, 'dist', file)
  if (fs.existsSync(packagedPath)) {
    return packagedPath
  }

  return path.join(extensionPath, 'node_modules', 'sql.js', 'dist', file)
}

export function loadSqlJs(extensionPath: string): InitSqlJs {
  const runtimeRequire = eval('require') as NodeRequire
  const packagedPath = path.join(extensionPath, 'dist', 'sql-wasm.js')
  const sqlJsModule = runtimeRequire(fs.existsSync(packagedPath) ? packagedPath : 'sql.js')
  return (sqlJsModule.default || sqlJsModule) as InitSqlJs
}
