import { ExtensionContext, SecretStorage } from 'vscode'

const SECRET_KEY_PREFIX = 'dbNexus.password.'

export class SecretService {
  private static instance: SecretService
  private secretStorage: SecretStorage

  private constructor(context: ExtensionContext) {
    this.secretStorage = context.secrets
  }

  static init(context: ExtensionContext): void {
    SecretService.instance = new SecretService(context)
  }

  static getInstance(): SecretService {
    if (!SecretService.instance) {
      throw new Error('SecretService not initialized')
    }
    return SecretService.instance
  }

  async storePassword(profileId: string, password: string): Promise<void> {
    await this.secretStorage.store(SECRET_KEY_PREFIX + profileId, password)
  }

  async getPassword(profileId: string): Promise<string | undefined> {
    return await this.secretStorage.get(SECRET_KEY_PREFIX + profileId)
  }

  async deletePassword(profileId: string): Promise<void> {
    await this.secretStorage.delete(SECRET_KEY_PREFIX + profileId)
  }
}
