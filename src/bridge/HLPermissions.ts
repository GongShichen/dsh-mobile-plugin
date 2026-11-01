import { HLBridgeError, record, textField } from './HLBridgeError.ts'
import type { HLParams } from './HLBridgeTypes.ts'

export interface HLPermissionOption { value: string; name: string; description?: string }
export interface HLPermissionCatalog { options: HLPermissionOption[]; defaultOptions: HLPermissionOption[]; defaultPreset: string }

/** Public catalog labels only; policy rules and arbitrary command execution are never mobile parameters. */
export function permissionCatalog(value: unknown): HLPermissionCatalog {
  if (!record(value) || !Array.isArray(value.options) || !Array.isArray(value.defaultOptions) || typeof value.defaultPreset !== 'string') {
    throw new HLBridgeError('permissions/invalid-catalog', '桌面返回了无效的权限选项')
  }
  const options = (rows: unknown[]): HLPermissionOption[] => rows.map(row => {
    if (!record(row)) throw new HLBridgeError('permissions/invalid-catalog', '桌面返回了无效的权限选项')
    return { value: textField(row.value, 'value'), name: textField(row.name, 'name'), ...(typeof row.description === 'string' ? { description: row.description } : {}) }
  })
  return { options: options(value.options), defaultOptions: options(value.defaultOptions), defaultPreset: value.defaultPreset }
}

export function permissionSelection(request: HLParams, catalog: HLPermissionCatalog): { sessionId: string; preset: string; line: string } {
  if (Object.keys(request).some(key => !['sessionId', 'preset', 'acknowledged'].includes(key))) throw new HLBridgeError('mobile/invalid-params', 'Only a current-session permission selection is accepted')
  const sessionId = textField(request.sessionId, 'sessionId')
  const preset = textField(request.preset, 'preset')
  if (preset.length > 256 || preset.trim() !== preset || /[\u0000-\u001f\u007f]/.test(preset) || !catalog.options.some(option => option.value === preset)) {
    throw new HLBridgeError('permissions/unavailable', '此权限模式已不可用，请刷新后重试')
  }
  if ((preset === 'danger-full-access' || preset === 'auto') && request.acknowledged !== true) {
    throw new HLBridgeError('permissions/confirmation-required', '请先阅读并确认此权限模式的说明')
  }
  return { sessionId, preset, line: `/permission ${preset}` }
}
