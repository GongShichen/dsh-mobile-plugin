import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import QRCode from 'qrcode'
import type { HLAccessStatus, HLNotificationStatus, HLOwnerCall } from './HLContract.js'
import { mobileStyles } from './HLStyles.js'
import { HLBrandMark } from './HLBrandMark.js'

const column: CSSProperties = { display: 'grid', gap: 16, minWidth: 0 }
const card: CSSProperties = { display: 'grid', gap: 16 }
const muted: CSSProperties = { color: 'var(--dm-muted)', fontSize: 13, lineHeight: 1.6 }
const field: CSSProperties = { display: 'grid', gap: 7 }
const time = (value: number) => new Date(value).toLocaleString()

function HLGlyph({ name, size = 20 }: { name: 'phone' | 'laptop' | 'scan' | 'arrow' | 'check' | 'copy' | 'refresh' | 'more'; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'more' ? <><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></> : name === 'phone' ? <><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/></> : name === 'laptop' ? <><rect x="4" y="3" width="16" height="13" rx="2"/><path d="m4 16-3 4h22l-3-4"/></> : name === 'scan' ? <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/></> : name === 'arrow' ? <path d="M5 12h14m-5-5 5 5-5 5"/> : name === 'check' ? <path d="m5 12 4 4L19 6"/> : name === 'copy' ? <><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></> : <><path d="M20 7v5h-5"/><path d="M4 17a8 8 0 1 0 0-10"/></>}
  </svg>
}

export function HLAccessLauncher({ call, wide }: { call: HLOwnerCall; wide?: boolean }) {
  const [open, setOpen] = useState(false)
  return <>
    <style>{mobileStyles}</style>
    <button className={`dm-launcher${wide ? ' dm-launcher-wide' : ''}`} type="button" title="移动访问" aria-label="移动访问" aria-haspopup="dialog" onClick={() => setOpen(true)}><HLBrandMark size={20}/>{wide && <span>移动访问</span>}</button>
    <Modal open={open} onClose={() => setOpen(false)} title="移动访问" closeLabel="关闭移动访问" className="dsh-mobile-modal" contentClassName="dsh-mobile-modal-content">
      {open && <HLAccessPage call={call}/>}
    </Modal>
  </>
}

export function HLAccessPage({ call }: { call: HLOwnerCall }) {
  const [state, setState] = useState<HLAccessStatus>()
  const [view, setView] = useState<'connection' | 'notifications'>('connection')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState('')
  const alive = useRef(true)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await call<HLAccessStatus>('status', {}, signal)
    if (alive.current) setState(next)
  }, [call])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    const poll = () => { void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setError('暂时无法读取连接状态，请稍后重试。') }) }
    poll(); const timer = setInterval(poll, 3000)
    return () => { alive.current = false; controller.abort(); clearInterval(timer) }
  }, [refresh])
  const invitation = state?.invitation
  const validInvitation = invitation && invitation.expiresAt > Date.now()
  useEffect(() => {
    let active = true; setQr('')
    if (validInvitation) void QRCode.toDataURL(invitation.uri, { width: 928, margin: 4, color: { dark: '#182230', light: '#ffffff' } }).then(value => { if (active) setQr(value) }).catch(() => { if (active) setError('二维码生成失败，请重新生成。') })
    return () => { active = false }
  }, [invitation?.uri, validInvitation])
  async function run(method: string, params: unknown = {}) {
    setBusy(true); setError(''); setNotice('')
    try {
      await call(method, params)
      if (!alive.current) return
      await refresh()
      setNotice(method === 'testNotification' ? '测试通知已发送至队列，送达状态见通知记录。' : method === 'importNotifications' ? '配置已保存。手机将自动注册并收到测试通知。' : method === 'startPairing' ? '' : '已更新')
      return true
    } catch { if (alive.current) setError('操作未完成，请检查配置和连接后重试。'); return false }
    finally { if (alive.current) setBusy(false) }
  }
  const connected = state?.connections.length ?? 0
  return <div className="dsh-mobile-access">
    <style>{mobileStyles}</style>
    <nav className="dm-tabs" aria-label="移动访问页面">
      <button type="button" aria-pressed={view === 'connection'} onClick={() => setView('connection')}>连接设备</button>
      <button type="button" aria-pressed={view === 'notifications'} onClick={() => setView('notifications')}>通知设置</button>
      <span className={`dm-status ${connected ? 'dm-online' : ''}`}><i/>{connected ? `${connected} 台设备在线` : '等待设备连接'}</span>
    </nav>
    {error && <div className="dm-feedback dm-error" role="alert">{error}</div>}
    {notice && <div className="dm-feedback" role="status">{notice}</div>}
    {!state ? <div className="dm-loading" role="status">正在读取电脑状态…</div> : view === 'connection' ? <>
      <section className="dm-pairing" aria-label="手机配对">
        <div className="dm-pairing-copy">
          <div className="dm-brand"><HLBrandMark size={32}/><span className="dm-eyebrow">HARNESS LINK</span></div>
          <h2>从手机，继续你的工作</h2>
          <p className="dm-muted">同一份会话与工作区。一次配对，随时接上电脑。</p>
          <ol className="dm-steps"><li><span>1</span><div><strong>打开手机 App</strong><p>进入设备页，选择扫码连接</p></div></li><li><span>2</span><div><strong>扫描配对二维码</strong><p>连接到这台电脑</p></div></li><li><span>3</span><div><strong>在电脑上确认</strong><p>确认后，手机即可继续对话</p></div></li></ol>
          <div className="dm-host"><HLGlyph name="laptop"/><span>{state.hostName}</span><span className="dm-badge">当前电脑</span></div>
        </div>
        <div className="dm-qr-panel">
          <div className="dm-qr-square">{validInvitation && qr ? <img src={qr} alt="手机配对二维码" width="232" height="232"/> : <div className="dm-qr-placeholder"><HLGlyph name="scan" size={52}/><span>{invitation ? '配对码已过期' : '准备连接你的手机'}</span></div>}</div>
          <button className={`dm-button ${validInvitation ? 'dm-secondary' : 'dm-primary'}`} aria-label="生成配对二维码" type="button" disabled={busy} onClick={() => void run('startPairing')}><HLGlyph name={validInvitation ? 'refresh' : 'scan'} size={18}/>{validInvitation ? '刷新二维码' : '生成配对二维码'}</button>
          {validInvitation ? <><span className="dm-caption">有效期至 {new Date(invitation.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><button className="dm-link" type="button" onClick={() => void navigator.clipboard.writeText(invitation.uri).then(() => setNotice('配对链接已复制')).catch(() => setError('复制失败，请使用二维码。'))}><HLGlyph name="copy" size={15}/>复制配对链接</button></> : <span className="dm-caption">配对码仅可使用一次，5 分钟内有效</span>}
        </div>
      </section>
      {state.pending.length > 0 && <section className="dm-panel dm-pending" aria-label="待确认设备"><div className="dm-section-heading"><h3>确认新设备</h3><span className="dm-badge">{state.pending.length} 个请求</span></div>{state.pending.map(device => <div className="dm-pending-row" key={device.requestId}><div className="dm-icon-tile"><HLGlyph name="phone"/></div><div className="dm-grow"><strong>{device.name}</strong><p className="dm-muted">确认后可读取会话、发送任务并审批操作。</p></div><div className="dm-actions"><button className="dm-button dm-secondary" disabled={busy} onClick={() => void run('confirmDevice', { requestId: device.requestId, approved: false })}>拒绝</button><button className="dm-button dm-primary" disabled={busy} onClick={() => void run('confirmDevice', { requestId: device.requestId, approved: true })}>允许连接</button></div></div>)}</section>}
      <section className="dm-devices" aria-label="已配对设备"><div className="dm-section-heading"><h3>已配对设备</h3><span className="dm-caption">{state.devices.length} 台</span></div>
        {state.devices.length === 0 ? <div className="dm-empty"><HLGlyph name="phone" size={28}/><div><strong>还没有配对的设备</strong><p>完成扫码后，设备会显示在这里。</p></div></div> : state.devices.map(device => {
          const connection = state.connections.find(item => item.deviceId === device.deviceId)
          return <div key={device.deviceId} className="dm-device"><div className="dm-icon-tile"><HLGlyph name="phone"/></div><div className="dm-grow"><strong>{device.name}</strong><p className="dm-muted">{device.platform === 'ios' ? 'iPhone / iPad' : 'Android'}<span className="dm-dot-separator">·</span>{connection ? connection.path === 'direct' ? '已连接 · 直连' : connection.path === 'relay' ? '已连接 · 加密中继' : '正在连接' : '离线'}</p><details className="dm-identity"><summary>设备详情</summary><code>{device.deviceId}</code></details></div><span className={`dm-status ${connection ? 'dm-online' : ''}`}><i/>{connection ? '在线' : '离线'}</span><details className="dm-device-actions"><summary aria-label={`${device.name}的操作`}><HLGlyph name="more" size={18}/></summary><div><button onClick={() => { setView('notifications'); void run('testNotification', { deviceId: device.deviceId }) }} disabled={busy}>测试通知</button><button className="dm-danger" onClick={() => void run('revokeDevice', { deviceId: device.deviceId })} disabled={busy}>撤销设备</button></div></details></div>
        })}
      </section>
      <p className="dm-footnote"><HLGlyph name="check" size={14}/>端到端加密连接，会话与工作区保持同步。</p>
    </> : <>
      <div className="dm-notification-intro"><div className="dm-icon-tile"><HLGlyph name="phone"/></div><div><h2>重要进展，及时知道</h2><p className="dm-muted">接收任务完成与待审批提醒。打开通知后，自动同步最新状态。</p></div></div>
      <div className="dm-provider-status"><span>iOS <strong>{state.notifications.configured.apns ? '已配置' : '待配置'}</strong></span><span>Android <strong>{state.notifications.configured.fcm ? '已配置' : '待配置'}</strong></span></div>
      <HLNotificationImport busy={busy} configured={state.notifications.configured} apps={state.notifications.apps ?? []} submit={params => run('importNotifications', params)}/>
      {state.notifications.setup?.filter(item => item.expiresAt > Date.now() && item.waitingForDevice).map(item => <p className="dm-feedback" key={item.provider} role="status">配置已保存，等待手机注册后会自动发送测试通知。</p>)}
      <details className="dm-history"><summary>最近通知记录 <span>{state.notifications.outbox.length}</span></summary>{state.notifications.outbox.length === 0 ? <p className="dm-muted">还没有通知记录。配置完成后会自动发送测试通知。</p> : state.notifications.outbox.map(item => <div className="dm-history-row" key={item.id}><span>{({ test: '测试通知', approval: '待审批', completed: '任务完成', failed: '任务失败' } as Record<string,string>)[item.kind] || item.kind}</span><strong>{({ queued: '等待发送', sending: '发送中', accepted: '服务已接收', received: '手机已确认', failed: '发送失败', expired: '已过期', cancelled: '已取消' } as Record<string,string>)[item.state] || item.state}</strong><span className="dm-caption">{time(item.updatedAt)}</span>{item.error && <span className="dm-danger">{item.error}</span>}</div>)}</details>
    </>}
  </div>
}

function HLNotificationImport({ busy, configured, apps, submit }: { busy: boolean; configured: { apns: boolean; fcm: boolean }; apps: NonNullable<HLNotificationStatus['apps']>; submit: (params: unknown) => Promise<boolean | undefined> }) {
  const [provider, setProvider] = useState('apns')
  const [error, setError] = useState('')
  const [keyId, setKeyId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [bundleId, setBundleId] = useState('')
  const [environment, setEnvironment] = useState('sandbox')
  const [androidPackage, setAndroidPackage] = useState('')
  const ios = apps.find(app => app.platform === 'ios')
  const android = apps.find(app => app.platform === 'android')
  useEffect(() => {
    if (ios) {
      setTeamId(previous => previous || ios.teamId || '')
      setBundleId(previous => previous || ios.applicationId)
      if (ios.environment === 'sandbox' || ios.environment === 'production') setEnvironment(ios.environment)
    }
    if (android) setAndroidPackage(previous => previous || android.applicationId)
  }, [ios?.applicationId, ios?.teamId, ios?.environment, android?.applicationId])
  async function importFiles(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    const form = event.currentTarget
    const data = new FormData(form)
    try {
      const file = async (name: string) => {
        const value = data.get(name)
        if (!(value instanceof File) || value.size === 0 || value.size > 128 * 1024) throw new Error('file')
        return value.text()
      }
      const saved = provider === 'apns'
        ? await submit({ provider, p8: await file('p8'), keyId, teamId, bundleId, environment })
        : await submit({ provider, googleServicesJson: await file('googleServices'), serviceAccountJson: await file('serviceAccount'), applicationId: androidPackage || undefined })
      if (saved) form.reset()
    } catch { setError('请选择有效的本地配置文件（每份小于 128 KiB）。') }
  }
  return <section className="dm-panel dm-push-form" aria-label="推送配置"><h3>配置通知服务</h3><p className="dm-muted">在电脑导入一次，已配对手机会自动完成注册。凭据仅保存在本机。</p>
    <label style={field}>平台<select value={provider} onChange={event => setProvider(event.target.value)}><option value="apns">iOS · APNs</option><option value="fcm">Android · FCM</option></select></label>
    <form key={provider} onSubmit={event => void importFiles(event)} className="dm-form">
      {provider === 'apns' ? <>
        <p style={muted}>{ios ? '已从配对的 iPhone 读取应用信息。密钥名称可自动填入 Key ID；缺失的字段只需补充一次。' : '先连接 iPhone，即可自动识别应用签名信息。也可手动填写。'}</p>
        <label style={field}>APNs .p8 签名文件<input required type="file" name="p8" accept=".p8" onChange={event => { const match = event.target.files?.[0]?.name.match(/^AuthKey_([A-Za-z0-9]{10})\.p8$/); if (match) setKeyId(match[1]!) }} /></label>
        <label style={field}>Key ID<input required name="keyId" value={keyId} onChange={e => setKeyId(e.target.value)} autoComplete="off" pattern="[A-Za-z0-9]{10}" /></label>
        <label style={field}>Team ID<input required name="teamId" value={teamId} onChange={e => setTeamId(e.target.value)} autoComplete="off" pattern="[A-Za-z0-9]{10}" /></label>
        <label style={field}>App Bundle ID<input required name="bundleId" value={bundleId} onChange={e => setBundleId(e.target.value)} placeholder="io.github.gongshichen.dshmobile" /></label>
        <label style={field}>推送环境<select name="environment" value={environment} onChange={e => setEnvironment(e.target.value)}><option value="production">生产 / TestFlight</option><option value="sandbox">开发</option></select></label>
        <a href="https://developer.apple.com/account/resources/authkeys/list" target="_blank" rel="noreferrer">首次使用：前往 Apple 创建 APNs 密钥</a>
      </> : <><label style={field}>google-services.json<input required type="file" name="googleServices" accept=".json" /></label><label style={field}>Firebase service-account.json<input required type="file" name="serviceAccount" accept=".json" /></label><label style={field}>Android 包名<input name="applicationId" value={androidPackage} onChange={e => setAndroidPackage(e.target.value)} placeholder="自动匹配配置中的唯一应用" /></label><a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">首次使用：打开 Firebase 项目设置</a></>}
      {error && <p role="alert">{error}</p>}<button className="dm-button dm-primary" type="submit" disabled={busy}>校验并启用手机通知</button>
    </form>
  </section>
}
