import { useId, useRef, useState } from 'react'
import type { HLPersonalConnection } from '../core/HLPersonalTypes.js'
import { hlParseGoogleClientJson, hlSerializeGoogleClient } from '../connectors/google/HLGoogleClient.js'

export function HLGoogleConnection({ configured, connections, busy, run }: {
  configured: boolean; connections: HLPersonalConnection[]; busy: boolean
  run(method: string, params?: unknown): Promise<unknown>
}) {
  const input = useRef<HTMLInputElement>(null); const feedback = useRef<HTMLParagraphElement>(null)
  const [reading, setReading] = useState(false); const [error, setError] = useState(''); const [status, setStatus] = useState('')
  const descriptionId = useId(); const feedbackId = useId()
  const inUse = connections.some(row => row.provider === 'google' && row.state !== 'disconnected')
  const disabled = busy || reading
  const fail = (reason: unknown) => {
    setStatus(''); setError(reason instanceof Error ? reason.message : '配置未完成，请重试。')
    requestAnimationFrame(() => feedback.current?.focus())
  }
  const invoke = (method: string) => {
    setError(''); setStatus('')
    void run(method).then(() => setStatus(method === 'clearGoogleClient' ? '本机 OAuth 配置已移除。' : '请在这台电脑的浏览器完成 Google 登录。')).catch(fail)
  }
  return <section className="hl-p-card hl-p-google" aria-label="Google 连接设置">
    <div className="hl-p-row"><h3>Google 日历与 Gmail</h3><span className="hl-p-status">{configured ? '本机已配置' : '可选 · 未配置'}</span></div>
    <p className="hl-p-muted" id={descriptionId}>需要邮件或日历能力时，使用自己的 Google Cloud OAuth 客户端。未配置也可交办其他事务。</p>
    <input ref={input} type="file" accept=".json,application/json" hidden aria-label="桌面应用 OAuth JSON" aria-describedby={`${descriptionId} ${feedbackId}`} disabled={disabled || inUse}
      onChange={event => {
        const field = event.currentTarget; const file = field.files?.[0]; if (!file) return
        setReading(true); setError(''); setStatus('')
        void (async () => {
          if (file.size > 65536) throw new Error('OAuth JSON 不能超过 64 KB，请选择 Google Cloud 下载的桌面应用配置。')
          const clientJson = hlSerializeGoogleClient(hlParseGoogleClientJson(await file.text()))
          await run('importGoogleClient', { clientJson })
          setStatus('OAuth 配置已保存，可以连接 Google 账户。')
        })().catch(fail).finally(() => { field.value = ''; setReading(false) })
      }}/>
    <div className="hl-p-actions">
      {configured && <button className="hl-p-button hl-p-button-primary" disabled={disabled} onClick={() => invoke('beginGoogleAuth')}>连接 Google 账户</button>}
      <button className={`hl-p-button${configured ? '' : ' hl-p-button-primary'}`} disabled={disabled || inUse} onClick={() => input.current?.click()}>{reading ? '正在导入…' : configured ? '更换 OAuth JSON' : '导入 OAuth JSON'}</button>
    </div>
    <p ref={feedback} id={feedbackId} tabIndex={-1} className={error ? 'hl-p-google-feedback hl-p-error' : 'hl-p-google-feedback hl-p-muted'} role={error ? 'alert' : 'status'}>{error || status}</p>
    <details className="hl-p-google-help"><summary>如何自行配置 Google</summary>
      <ol>
        <li>在 <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud</a> 选择或创建自己的项目，启用 Gmail API 和 Google Calendar API。</li>
        <li>配置 Google Auth Platform 的品牌与受众；应用处于测试状态时，将自己的账号添加为测试用户。</li>
        <li>在 <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">客户端</a> 中创建“桌面应用”OAuth 客户端，并下载 JSON。</li>
        <li>导入 JSON，再点击“连接 Google 账户”完成授权。<a href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noreferrer">查看 Google 官方指南</a></li>
      </ol>
      <p className="hl-p-muted">配置与账户凭据只保存在当前桌面 profile 的 macOS 钥匙串中。查询遵循交办范围，邮件发送和日程写入仍需任务授权。</p>
      {inUse && <p className="hl-p-muted">更换或移除配置前，请先断开下方所有 Google 账户。</p>}
      {configured && <button className="hl-p-button hl-p-danger" disabled={disabled || inUse} onClick={() => invoke('clearGoogleClient')}>移除本机 OAuth 配置</button>}
    </details>
  </section>
}
