import { createPrivateKey, randomUUID } from 'node:crypto'
import type { HLNotificationImport, HLProviderConfig } from './HLNotificationTypes.js'

function text(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 131072 || (pattern && !pattern.test(value))) throw new Error(`Invalid ${name}`)
  return value.trim()
}
function json(value: string): any {
  try { return JSON.parse(text(value, 'configuration file')) }
  catch { throw new Error('Invalid configuration JSON') }
}

/** Return only explicitly selected public fields; imported JSON must never be echoed. */
export function parseNotificationImport(input: HLNotificationImport): { config: HLProviderConfig; privateKey: string } {
  if (input.provider === 'apns') {
    const privateKey = text(input.p8, 'APNs key')
    let key
    try { key = createPrivateKey(privateKey) } catch { throw new Error('Invalid APNs private key') }
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('APNs requires a P-256 private key')
    if (input.environment !== 'sandbox' && input.environment !== 'production') throw new Error('Invalid APNs environment')
    return { privateKey, config: {
      provider: 'apns', secretRef: `notifications:apns:${randomUUID()}`,
      keyId: text(input.keyId, 'APNs key ID', /^[A-Za-z0-9]{10}$/),
      teamId: text(input.teamId, 'Apple team ID', /^[A-Za-z0-9]{10}$/),
      bundleId: text(input.bundleId, 'bundle ID', /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
      environment: input.environment,
    } }
  }
  if (input.provider !== 'fcm') throw new Error('Unknown notification provider')
  const google = json(input.googleServicesJson)
  const account = json(input.serviceAccountJson)
  if (account.type !== 'service_account') throw new Error('A Google service account is required')
  const projectId = text(google.project_info?.project_id, 'Firebase project', /^[a-z][a-z0-9-]{4,62}$/)
  if (projectId !== account.project_id) throw new Error('Firebase and service account projects differ')
  const clients = Array.isArray(google.client) ? google.client.filter((item: any) => !input.applicationId || item.client_info?.android_client_info?.package_name === input.applicationId) : []
  if (clients.length !== 1) throw new Error('Choose the Android package name in this Firebase configuration')
  const client = clients[0]
  const privateKey = text(account.private_key, 'Google private key')
  let key
  try { key = createPrivateKey(privateKey) } catch { throw new Error('Invalid Google private key') }
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('Google service account requires an RSA private key')
  const storageBucket = google.project_info?.storage_bucket
  return { privateKey, config: {
    provider: 'fcm', projectId, secretRef: `notifications:fcm:${randomUUID()}`,
    packageName: text(client.client_info?.android_client_info?.package_name, 'Android package name', /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
    clientEmail: text(account.client_email, 'Google service account email', /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/),
    publicFirebaseOptions: {
      applicationId: text(client.client_info?.mobilesdk_app_id, 'Firebase application ID'),
      apiKey: text(client.api_key?.[0]?.current_key, 'Firebase public API key'),
      projectId, gcmSenderId: text(google.project_info?.project_number, 'Firebase sender ID', /^\d+$/),
      ...(typeof storageBucket === 'string' ? { storageBucket: text(storageBucket, 'storage bucket') } : {}),
    },
  } }
}
