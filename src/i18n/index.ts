import { env, workspace } from 'vscode'
import fs from 'fs'
import path from 'path'

interface LocaleData {
  [key: string]: string | LocaleData
}

class I18n {
  private extensionPath = ''
  private currentLanguage = 'en'
  private messages: Record<string, string> = {}
  private fallbackMessages: Record<string, string> = {}

  init(extensionPath: string): void {
    this.extensionPath = extensionPath
    this.reload()
  }

  reload(): void {
    if (!this.extensionPath) return

    const configuredLanguage = workspace.getConfiguration('dbNexus').get<string>('displayLanguage', '').trim()
    const language = configuredLanguage || env.language || 'en'

    this.fallbackMessages = this.loadLocale('en')
    this.messages = this.loadLocale(language)
    this.currentLanguage = language
  }

  getCurrentLanguage(): string {
    return this.currentLanguage
  }

  t(key: string, ...args: unknown[]): string {
    const template = this.messages[key] ?? this.fallbackMessages[key] ?? key
    return template.replace(/{(\d+)}/g, (_match, index) => {
      const value = args[Number(index)]
      return value === undefined ? `{${index}}` : String(value)
    })
  }

  private loadLocale(locale: string): Record<string, string> {
    const raw = this.readLocaleFile(locale)
    return flatten(raw)
  }

  private readLocaleFile(locale: string): LocaleData {
    const localeDir = path.join(this.extensionPath, 'locales')
    const candidates = this.getLocaleCandidates(locale)

    for (const candidate of candidates) {
      const filepath = path.join(localeDir, `${candidate}.json`)
      if (fs.existsSync(filepath)) {
        try {
          return JSON.parse(fs.readFileSync(filepath, 'utf-8'))
        } catch {
          return {}
        }
      }
    }

    return {}
  }

  private getLocaleCandidates(locale: string): string[] {
    const normalized = locale.replace('_', '-')
    const lower = normalized.toLowerCase()
    const prefix = lower.split('-')[0]

    const knownAliases: Record<string, string[]> = {
      zh: ['zh-CN'],
      'zh-cn': ['zh-CN'],
      'zh-hans': ['zh-CN'],
      en: ['en']
    }

    return [
      normalized,
      lower,
      ...(knownAliases[lower] || knownAliases[prefix] || []),
      prefix,
      'en'
    ]
  }
}

function flatten(data: LocaleData, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(data)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      result[fullKey] = value
    } else if (value && typeof value === 'object') {
      Object.assign(result, flatten(value, fullKey))
    }
  }

  return result
}

const i18n = new I18n()

export function initI18n(extensionPath: string): void {
  i18n.init(extensionPath)
}

export function reloadI18n(): void {
  i18n.reload()
}

export function getCurrentLanguage(): string {
  return i18n.getCurrentLanguage()
}

export function t(key: string, ...args: unknown[]): string {
  return i18n.t(key, ...args)
}
