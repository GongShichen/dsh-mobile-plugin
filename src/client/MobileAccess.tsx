import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import QRCode from 'qrcode'
import type { MobileAccessStatus, NotificationStatus, OwnerCall } from './contract.js'

const column: CSSProperties = { display: 'grid', gap: 16, minWidth: 0, maxWidth: 760 }
const row: CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }
const card: CSSProperties = { border: '1px solid var(--dsw-border, #e4e7ed)', borderRadius: 16, padding: 20, display: 'grid', gap: 10 }
const muted: CSSProperties = { opacity: .7, fontSize: 12, overflowWrap: 'anywhere' }
const field: CSSProperties = { display: 'grid', gap: 5 }
const time = (value: number) => new Date(value).toLocaleString()

export function MobileAccessLauncher({ call, wide }: { call: OwnerCall; wide?: boolean }) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" title="移动访问" aria-label="移动访问" onClick={() => setOpen(true)} style={row}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10 18h4"/></svg>
      {wide && <span>移动访问</span>}
    </button>
    <Modal open={open} onClose={() => setOpen(false)} title="移动访问" closeLabel="关闭移动访问" className="dsh-mobile-modal" contentClassName="dsh-mobile-modal-content">
      {open && <MobileAccessPage call={call} />}
    </Modal>
  </>
}

export function MobileAccessPage({ call }: { call: OwnerCall }) {
  const [state, setState] = useState<MobileAccessStatus>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState('')
  const alive = useRef(true)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await call<MobileAccessStatus>('status', {}, signal)
    if (alive.current) setState(next)
  }, [call])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    const poll = () => { void refresh(controller.signal).catch(() => { if (!controller.signal.aborted) setError('无法读取移动访问状态，请检查桌面插件是否运行。') }) }
    poll()
    const timer = setInterval(poll, 3000)
    return () => { alive.current = false; controller.abort(); clearInterval(timer) }
  }, [refresh])
  const invitation = state?.invitation
  const validInvitation = invitation && invitation.expiresAt > Date.now()
  useEffect(() => {
    let active = true
    setQr('')
    if (validInvitation) void QRCode.toDataURL(invitation.uri, { width: 240, margin: 2 }).then(value => { if (active) setQr(value) }).catch(() => { if (active) setError('配对二维码生成失败，请重新生成。') })
    return () => { active = false }
  }, [invitation?.uri, validInvitation])

  async function run(method: string, params: unknown = {}) {
    setBusy(true); setError(''); setNotice('')
    try {
      await call(method, params)
      if (!alive.current) return
      await refresh()
      setNotice(method === 'testNotification' ? '测试通知已排队；下方分别显示服务商接收和手机回执。' : method === 'importNotifications' ? '配置已保存，正在让在线手机自动注册并发送测试通知。请在手机上点开测试通知完成验证。' : '已更新')
      return true
    } catch { if (alive.current) setError('操作未完成。请检查配置和连接后重试；导入内容不会显示在错误信息中。'); return false }
    finally { if (alive.current) setBusy(false) }
  }

  return <div className="dsh-mobile-access" style={column}>
    <style>{`.dsh-mobile-modal{width:min(800px,calc(100vw - 40px))!important;max-width:calc(100vw - 40px)!important;max-height:calc(100vh - 64px)!important}.dsh-mobile-modal-content{max-height:calc(100vh - 80px);overflow-y:auto}.dsh-mobile-access{font-size:14px;line-height:1.55}.dsh-mobile-access h3,.dsh-mobile-access p{margin:0}.dsh-mobile-access h3{font-size:16px}.dsh-mobile-access button{border:1px solid #dce0e9;border-radius:8px;padding:8px 13px;background:#f4f6fb;color:#263c72;font:inherit;cursor:pointer}.dsh-mobile-access button:disabled{opacity:.45;cursor:default}.dsh-mobile-access button:hover:not(:disabled){background:#e9edfa}.dsh-mobile-access input,.dsh-mobile-access select{font:inherit;border:1px solid #dce0e9;border-radius:8px;min-height:36px;padding:6px 10px;box-sizing:border-box;max-width:100%;background:var(--dsw-bg,#fff);color:inherit}.dsh-mobile-access a{color:#4462ee}.dsh-mobile-access img{max-width:100%;height:auto;border-radius:10px}.dsh-mobile-access [role=alert]{color:#ad3434}.dsh-mobile-access [role=status]{color:#285a42}`}</style>
    <p>在手机 App 中扫码，确认设备后继续电脑上的会话与工作区。</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!state ? <p role="status">正在连接桌面…</p> : <>
      <section style={card} aria-label="手机配对">
        <strong>{state.hostName}</strong><span style={muted}>设备标识：{state.endpointId}</span>
        <button type="button" disabled={busy} onClick={() => void run('startPairing')}>生成配对二维码</button>
        {validInvitation && <><p>用手机 App 扫码。有效期至 {time(invitation.expiresAt)}，随后在此确认新设备。</p>{qr && <img src={qr} alt="手机配对二维码" width="240" height="240" />}<button type="button" onClick={() => void navigator.clipboard.writeText(invitation.uri).then(() => setNotice('配对链接已复制')).catch(() => setError('复制失败，请使用二维码。'))}>复制配对链接</button></>}
        {invitation && !validInvitation && <p>配对码已过期，请重新生成。</p>}
      </section>
      {state.pending.length > 0 && <section style={card} aria-label="待确认设备"><h3>确认新设备</h3>{state.pending.map(device => <div key={device.requestId} style={card}>
        <strong>{device.name} · {device.platform}</strong><span style={muted}>{device.deviceId}</span>
        <p>请确认这是你正在配对的手机。允许后，此手机可以读取会话、发送任务并审批操作。</p><div style={row}><button disabled={busy} onClick={() => void run('confirmDevice', { requestId: device.requestId, approved: true })}>允许此设备</button><button disabled={busy} onClick={() => void run('confirmDevice', { requestId: device.requestId, approved: false })}>拒绝</button></div>
      </div>)}</section>}
      <section style={card} aria-label="已配对设备"><h3>已配对设备</h3>{state.devices.length === 0 && <p>还没有配对的手机。</p>}{state.devices.map(device => {
        const connection = state.connections.find(item => item.deviceId === device.deviceId)
        return <div key={device.deviceId} style={card}><strong>{device.name} · {device.platform}</strong><span style={muted}>{device.deviceId}</span><span>{device.revokedAt ? '已撤销' : connection ? `已连接 · ${connection.path === 'direct' ? '直连' : connection.path === 'relay' ? '加密中继' : '正在确认路径'}` : '离线'}</span>{!device.revokedAt && <div style={row}><button disabled={busy} onClick={() => void run('testNotification', { deviceId: device.deviceId })}>发送测试通知</button><button disabled={busy} onClick={() => void run('revokeDevice', { deviceId: device.deviceId })}>撤销设备</button></div>}</div>
      })}</section>
      <NotificationImport busy={busy} configured={state.notifications.configured} apps={state.notifications.apps ?? []} submit={params => run('importNotifications', params)} />
      <section style={card} aria-label="通知状态"><h3>通知状态</h3><p>电脑直接连接 Apple / Google 推送服务。手机离线时仍可接收系统通知；打开通知后通过设备连接获取内容。</p>
        {state.notifications.setup?.filter(item => item.expiresAt > Date.now() && item.waitingForDevice).map(item => <p key={item.provider} role="status">{item.provider === 'apns' ? 'iPhone' : 'Android'}：配置已保存，等待手机连接并授权通知，随后自动发送测试。</p>)}
        {state.notifications.outbox.length === 0 ? <p>还没有通知记录。</p> : state.notifications.outbox.map(item => <div key={item.id} style={row}><span>{item.kind}</span><span>{({ queued: '等待发送', sending: '发送中', accepted: '服务商已接收', received: '手机已回执', failed: '发送失败', expired: '已过期', cancelled: '已取消' } as Record<string, string>)[item.state] || item.state}</span><span style={muted}>{time(item.updatedAt)} · 尝试 {item.attempts} 次{item.error ? ` · ${item.error}` : ''}</span></div>)}
      </section>
    </>}
  </div>
}

function NotificationImport({ busy, configured, apps, submit }: { busy: boolean; configured: { apns: boolean; fcm: boolean }; apps: NonNullable<NotificationStatus['apps']>; submit: (params: unknown) => Promise<boolean | undefined> }) {
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
  return <section style={card} aria-label="推送配置"><h3>推送配置</h3><p>iOS：{configured.apns ? '已配置' : '未配置'} · Android：{configured.fcm ? '已配置' : '未配置'}</p><p style={muted}>从本机导入签名文件。私钥保存在 Mac 钥匙串，只向手机提供 Firebase 公共配置。</p>
    <label style={field}>平台<select value={provider} onChange={event => setProvider(event.target.value)}><option value="apns">iOS · APNs</option><option value="fcm">Android · FCM</option></select></label>
    <form key={provider} onSubmit={event => void importFiles(event)} style={column}>
      {provider === 'apns' ? <>
        <p style={muted}>{ios ? '已从配对的 iPhone 读取应用信息。密钥名称可自动填入 Key ID；缺失的字段只需补充一次。' : '先连接 iPhone，即可自动识别应用签名信息。也可手动填写。'}</p>
        <label style={field}>APNs .p8 签名文件<input required type="file" name="p8" accept=".p8" onChange={event => { const match = event.target.files?.[0]?.name.match(/^AuthKey_([A-Za-z0-9]{10})\.p8$/); if (match) setKeyId(match[1]!) }} /></label>
        <label style={field}>Key ID<input required name="keyId" value={keyId} onChange={e => setKeyId(e.target.value)} autoComplete="off" pattern="[A-Za-z0-9]{10}" /></label>
        <label style={field}>Team ID<input required name="teamId" value={teamId} onChange={e => setTeamId(e.target.value)} autoComplete="off" pattern="[A-Za-z0-9]{10}" /></label>
        <label style={field}>App Bundle ID<input required name="bundleId" value={bundleId} onChange={e => setBundleId(e.target.value)} placeholder="io.github.gongshichen.dshmobile" /></label>
        <label style={field}>推送环境<select name="environment" value={environment} onChange={e => setEnvironment(e.target.value)}><option value="production">生产 / TestFlight</option><option value="sandbox">开发</option></select></label>
        <a href="https://developer.apple.com/account/resources/authkeys/list" target="_blank" rel="noreferrer">首次使用：前往 Apple 创建 APNs 密钥</a>
      </> : <><label style={field}>google-services.json<input required type="file" name="googleServices" accept=".json" /></label><label style={field}>Firebase service-account.json<input required type="file" name="serviceAccount" accept=".json" /></label><label style={field}>Android 包名<input name="applicationId" value={androidPackage} onChange={e => setAndroidPackage(e.target.value)} placeholder="自动匹配配置中的唯一应用" /></label><a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer">首次使用：打开 Firebase 项目设置</a></>}
      {error && <p role="alert">{error}</p>}<button type="submit" disabled={busy}>校验并启用手机通知</button>
    </form>
  </section>
}
