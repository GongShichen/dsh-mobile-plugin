import { HLPersonalError } from '../../core/HLPersonalValidation.js'

export interface HLGoogleClientConfiguration { clientId?: string; clientSecret?: string }
export const HL_GOOGLE_CLIENT_KEY = 'personal:google:oauth-client'

/** Read Google's downloaded Desktop client, never its supplied endpoint URLs. */
export function hlParseGoogleClientJson(value: unknown): Required<HLGoogleClientConfiguration> {
  const invalid = () => new HLPersonalError('PERSONAL_GOOGLE_CLIENT_INVALID', '请选择 Google Cloud 下载的“桌面应用”OAuth JSON，文件应包含 installed、client_id 和 client_secret。')
  if (typeof value !== 'string' || !value.trim() || value.length > 65536) throw invalid()
  let document: unknown
  try { document = JSON.parse(value) } catch { throw invalid() }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw invalid()
  const installed = (document as Record<string, unknown>).installed
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) throw invalid()
  const { client_id: id, client_secret: secret } = installed as Record<string, unknown>
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(id.trim())
    || typeof secret !== 'string' || !secret.trim() || secret.length > 1024 || /[\s\x00-\x1f]/.test(secret)) throw invalid()
  return { clientId: id.trim(), clientSecret: secret }
}

export function hlSerializeGoogleClient(configuration: Required<HLGoogleClientConfiguration>): string {
  return JSON.stringify({ installed: { client_id: configuration.clientId, client_secret: configuration.clientSecret } })
}
