import { randomBytes } from 'node:crypto'

export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/** Native import is deferred so unit tests never access the login Keychain. */
export class MacKeychainSecretStore implements SecretStore {
  constructor(private readonly service = 'io.github.gongshichen.dsh-mobile', private readonly profile = 'web') {}

  private async entry(key: string) {
    const { AsyncEntry } = await import('@napi-rs/keyring')
    return new AsyncEntry(this.service, `${this.profile}:${key}`)
  }

  async get(key: string): Promise<string | undefined> { return (await (await this.entry(key)).getPassword()) ?? undefined }
  async set(key: string, value: string): Promise<void> { await (await this.entry(key)).setPassword(value) }
  async delete(key: string): Promise<void> { await (await this.entry(key)).deleteCredential() }
}

export async function loadIdentity(store: SecretStore): Promise<Uint8Array> {
  const existing = await store.get('iroh-identity')
  if (existing !== undefined) {
    const bytes = Buffer.from(existing, 'base64')
    if (bytes.length !== 32 || bytes.toString('base64') !== existing) throw new Error('Stored identity is invalid; refusing to silently replace this device')
    return bytes
  }
  const bytes = randomBytes(32)
  await store.set('iroh-identity', bytes.toString('base64'))
  return bytes
}
