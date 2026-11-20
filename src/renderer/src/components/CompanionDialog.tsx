import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CompanionPairing, CompanionStatus } from '../../../shared/types'
import { RELAY_DOWNLOADS } from '../../../shared/relay'
import { copyText } from '../clipboard'
import {
  CopyIcon,
  DownloadIcon,
  LinkIcon,
  PhoneIcon,
  QrIcon,
  RefreshIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from '../icons'
import { t } from '../i18n'

interface CompanionDialogProps {
  open: boolean
  onClose: () => void
  onError: (message: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function relativeTime(value: string | null): string {
  if (!value) return t("尚未连接")
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return t("未知")
  const diff = Date.now() - time
  if (diff < 60_000) return t("刚刚")
  if (diff < 3_600_000) return t("{v1} 分钟前", { v1: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t("{v1} 小时前", { v1: Math.floor(diff / 3_600_000) })
  return t("{v1} 天前", { v1: Math.floor(diff / 86_400_000) })
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || 'P'
}

export function CompanionDialog({ open, onClose, onError }: CompanionDialogProps) {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [pairing, setPairing] = useState<CompanionPairing | null>(null)
  const [appQr, setAppQr] = useState<{ url: string; qrDataUrl: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [pairingLoading, setPairingLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [relayInput, setRelayInput] = useState('')
  const [relaySaving, setRelaySaving] = useState(false)
  const [relaySaved, setRelaySaved] = useState(false)
  const [relayError, setRelayError] = useState('')
  const [cloudDomain, setCloudDomain] = useState('')
  const [cloudEmail, setCloudEmail] = useState('')
  const [copiedCommand, setCopiedCommand] = useState(false)
  const [roots, setRoots] = useState<string[]>([])
  const [rootBusy, setRootBusy] = useState(false)
  const pairingRef = useRef<HTMLElement | null>(null)
  const relayInitialized = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const next = await window.pilot.companionStatus()
      setStatus(next)
      if (!relayInitialized.current) {
        relayInitialized.current = true
        setRelayInput(next.relayUrl ?? '')
      }
      return next
    } catch (error) {
      onError(errorMessage(error))
      return null
    }
  }, [onError])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void refresh().finally(() => setLoading(false))
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.pilot
      .companionAppQr()
      .then((value) => {
        if (!cancelled) setAppQr(value)
      })
      .catch(() => {
        // The pairing QR still works when the public app URL is unavailable.
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void window.pilot
      .companionRoots()
      .then((value) => {
        if (!cancelled) setRoots(Array.isArray(value) ? value : [])
      })
      .catch(() => {
        // 手机连接未初始化时，授权列表保持为空即可。
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setPairing(null)
      setCopied(false)
      relayInitialized.current = false
      setRelaySaved(false)
      setRelayError('')
      setCopiedCommand(false)
    }
  }, [open])

  useEffect(() => {
    if (!pairing || !pairingRef.current) return
    const frame = window.requestAnimationFrame(() => {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      pairingRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: reduced ? 'auto' : 'smooth',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [pairing])

  const toggle = useCallback(
    async (enabled: boolean) => {
      setLoading(true)
      try {
        const next = await window.pilot.setCompanionEnabled(enabled)
        setStatus(next)
        if (!enabled) setPairing(null)
      } catch (error) {
        onError(errorMessage(error))
      } finally {
        setLoading(false)
      }
    },
    [onError],
  )

  const createPairing = useCallback(async () => {
    setPairingLoading(true)
    setCopied(false)
    try {
      const next = await window.pilot.createCompanionPairing()
      setPairing(next)
      await refresh()
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setPairingLoading(false)
    }
  }, [onError, refresh])

  const revoke = useCallback(
    async (phoneId: string) => {
      try {
        const next = await window.pilot.revokeCompanion(phoneId)
        setStatus(next)
      } catch (error) {
        onError(errorMessage(error))
      }
    },
    [onError],
  )

  const copy = useCallback(async () => {
    if (!pairing) return
    try {
      if (!(await copyText(pairing.url))) throw new Error(t("剪贴板不可用"))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch (error) {
      onError(t("复制失败：{v1}", { v1: errorMessage(error) }))
    }
  }, [onError, pairing])

  const openLocal = useCallback(async () => {
    try {
      const url = await window.pilot.companionLocalUrl()
      if (url) window.open(url, '_blank')
    } catch (error) {
      onError(errorMessage(error))
    }
  }, [onError])

  const applyRelay = useCallback(
    async (value: string) => {
      if (relaySaving) return
      setRelaySaving(true)
      setRelayError('')
      setRelaySaved(false)
      try {
        const next = await window.pilot.setCompanionRelay(value)
        setStatus(next)
        setRelayInput(next.relayUrl ?? '')
        // The old pairing offer points at the previous endpoint.
        setPairing(null)
        setRelaySaved(true)
        window.setTimeout(() => setRelaySaved(false), 2400)
      } catch (error) {
        const message = errorMessage(error)
        setRelayError(message)
        onError(message)
      } finally {
        setRelaySaving(false)
      }
    },
    [onError, relaySaving],
  )

  const saveRelay = useCallback(() => applyRelay(relayInput), [applyRelay, relayInput])

  const addRoot = useCallback(async () => {
    if (rootBusy) return
    try {
      const path = await window.pilot.pickFolder(t("选择手机可创建的工作区目录"))
      if (!path) return
      setRootBusy(true)
      setRoots(await window.pilot.addCompanionRoot(path))
    } catch (error) {
      onError(errorMessage(error))
    } finally {
      setRootBusy(false)
    }
  }, [onError, rootBusy])

  const removeRoot = useCallback(
    async (path: string) => {
      try {
        setRoots(await window.pilot.removeCompanionRoot(path))
      } catch (error) {
        onError(errorMessage(error))
      }
    },
    [onError],
  )

  const installCommand = useMemo(() => {
    const parts = [`curl -fsSL ${RELAY_DOWNLOADS.installScript} | sudo bash -s --`]
    const domain = cloudDomain.trim()
    const email = cloudEmail.trim()
    if (domain) parts.push(`--domain '${domain.replace(/'/g, '')}'`)
    if (email) parts.push(`--email '${email.replace(/'/g, '')}'`)
    return parts.join(' ')
  }, [cloudDomain, cloudEmail])

  const copyInstallCommand = useCallback(async () => {
    try {
      if (!(await copyText(installCommand))) throw new Error(t("剪贴板不可用"))
      setCopiedCommand(true)
      window.setTimeout(() => setCopiedCommand(false), 1800)
    } catch (error) {
      onError(t("复制失败：{v1}", { v1: errorMessage(error) }))
    }
  }, [installCommand, onError])

  const expiresIn = useMemo(() => {
    if (!pairing) return ''
    const remaining = Math.max(0, new Date(pairing.expiresAt).getTime() - now)
    if (remaining <= 0) return t("二维码已过期")
    const minutes = Math.floor(remaining / 60_000)
    const seconds = Math.floor((remaining % 60_000) / 1000)
    return t("{v1}:{v2} 后过期", { v1: minutes, v2: String(seconds).padStart(2, '0') })
  }, [now, pairing])

  const cloudPhones = status?.cloudPhones ?? 0
  // Paired over the cloud but the desktop currently has no relay address: the
  // phones spin on "正在连接" until one is filled in again.
  const relayMissing = cloudPhones > 0 && !status?.relayUrl
  // The field is about to be cleared while cloud-paired phones still rely on it.
  const relayAboutToClear =
    cloudPhones > 0 && Boolean(status?.relayUrl) && !relayInput.trim()

  if (!open) return null

  const running = status?.running ?? false
  const enabled = status?.enabled ?? false
  const phones = status?.phones ?? []

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal companion-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="companion-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <div className="companion-heading">
            <span className="companion-heading-icon">
              <PhoneIcon width={19} height={19} />
            </span>
            <div>
              <h2 id="companion-title">{t("Pilot 手机连接")}</h2>
              <p>{t("在手机上继续会话、查看执行过程并审批工具调用。消息端到端加密。")}</p>
            </div>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("关闭")}>
            <XIcon width={15} height={15} />
          </button>
        </div>

        <div className="modal-body companion-body">
          <div className="companion-hero">
            <div>
              <span className={`companion-status-dot${running ? ' is-on' : ''}`} />
              <strong>{running ? t("手机连接已开启") : t("手机连接已关闭")}</strong>
              <p>
                {running
                  ? status?.relayUrl
                    ? t("手机与电脑可以不在同一网络。自建中继器只转发端到端加密的密文；关闭电脑或退出 Pilot 后会断开。")
                    : t("手机与电脑需要连接同一个局域网。关闭电脑或退出 Pilot 后会自动断开。")
                  : t("开启后 Pilot 会在本机启动配对服务。同一局域网可直接连接，跨网络需先配置自建中继器。")}
              </p>
            </div>
            <button
              type="button"
              className={`companion-switch${enabled ? ' is-on' : ''}`}
              role="switch"
              aria-checked={enabled}
              aria-label={t("开启手机连接")}
              disabled={loading}
              onClick={() => void toggle(!enabled)}
            >
              <span />
            </button>
          </div>

          {status?.error ? <div className="companion-error">{status.error}</div> : null}

          {appQr ? (
            <div className="companion-app-card">
              <img src={appQr.qrDataUrl} alt={t("Pilot 手机 App 下载二维码")} width={96} height={96} />
              <div>
                <div className="companion-app-head">
                  <strong>{t("Pilot 手机 App")}</strong>
                  <span
                    className={`companion-relay-pill${status?.relayConnected ? ' is-on' : ''}`}
                  >
                    {status?.relayUrl
                      ? !status.running
                        ? t("自建中继器待命")
                        : status.relayConnected
                          ? t("自建中继器已连接")
                          : t("中继器连接中")
                      : t("局域网直连")}
                  </span>
                </div>
                <p>{t("扫码下载安卓 App。安装后打开 App，用里面的「扫一扫」扫描下方配对二维码；也可以直接用浏览器打开网页版。")}</p>
                <code>{appQr.url}</code>
              </div>
            </div>
          ) : null}

          <section className="companion-section relay-section">
            <div className="companion-section-head">
              <div>
                <h3>
                  <LinkIcon width={15} height={15} />
                  {t("自建中继器")}</h3>
                <p>
                  {t("Pilot 官方不提供公共中继服务。手机与电脑不在同一网络时，需要部署你自己的 Pilot Link 中继器；它只按房间转发端到端加密的密文，不保存会话。")}</p>
              </div>
              <span className={`companion-relay-pill${status?.relayUrl ? ' is-on' : ''}`}>
                {status?.relayUrl ? t("已配置") : t("仅局域网")}
              </span>
            </div>

            <div className="relay-downloads">
              <a
                className="button ghost small"
                href={RELAY_DOWNLOADS.windows}
                target="_blank"
                rel="noreferrer"
              >
                <DownloadIcon width={14} height={14} />
                {t("Windows 版")}</a>
              <a
                className="button ghost small"
                href={RELAY_DOWNLOADS.linux}
                target="_blank"
                rel="noreferrer"
              >
                <DownloadIcon width={14} height={14} />
                {t("Linux 版")}</a>
              <span className="relay-download-note">
                v{RELAY_DOWNLOADS.version} {t("· 需要 Node.js 22+ · 含部署示例")}</span>
            </div>

            <label className="relay-field">
              <span>{t("中继地址")}</span>
              <div className="relay-input-row">
                <input
                  className="text-input mono"
                  value={relayInput}
                  onChange={(event) => setRelayInput(event.target.value)}
                  placeholder="wss://relay.example.com/c/9f3a2c7e…#k=home:7d1c9e04…"
                  disabled={relaySaving || status?.relaySource === 'env'}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="button primary small"
                  onClick={() => void saveRelay()}
                  disabled={relaySaving || status?.relaySource === 'env'}
                >
                  {relaySaving ? <i className="spinner small" /> : null}
                  {t("保存")}</button>
              </div>
            </label>

            <div className="relay-status">
              {status?.relaySource === 'env' ? (
                <span>{t("地址由 PILOT_RELAY_URL 环境变量指定，界面中的修改不会生效。")}</span>
              ) : status?.relayUrl ? (
                <span>
                  {t("当前使用")}<code>{status.relayUrl}</code>
                  {status.relayAccess ? (
                    <span className="relay-access-note">
                      {t("· 已带准入码（#k=，不会显示在界面上）")}</span>
                  ) : null}
                </span>
              ) : (
                <span>
                  {t("未配置中继地址；手机与电脑只能在同一局域网内连接。手机端要求 wss://。")}</span>
              )}
              {relaySaved ? <span className="relay-saved">{t("已保存，下次配对生效。")}</span> : null}
            </div>
            {relayMissing ? (
              <div className="relay-warning" role="alert">
                <p>
                  {t("有")}{cloudPhones} {t("台手机是通过自建中继器配对的，但电脑当前没有填写中继地址， 这些手机会一直停在“正在连接”。填写地址后手机会自动恢复。")}</p>
                {status?.lastRelayUrl ? (
                  <button
                    type="button"
                    className="button ghost small"
                    onClick={() => void applyRelay(status.lastRelayUrl ?? '')}
                    disabled={relaySaving}
                  >
                    {t("恢复")}{status.lastRelayUrl}
                  </button>
                ) : null}
              </div>
            ) : relayAboutToClear ? (
              <div className="relay-warning" role="alert">
                <p>
                  {t("有")}{cloudPhones} {t("台手机通过自建中继器配对；清空地址后它们将无法跨网络连接。")}</p>
              </div>
            ) : null}
            {relayError ? <p className="relay-error">{relayError}</p> : null}
            {status?.relayError ? <p className="relay-error">{status.relayError}</p> : null}

            <details className="relay-cloud">
              <summary>
                <TerminalIcon width={14} height={14} />
                {t("云服务器一键安装")}</summary>
              <p>
                {t("适用于 Ubuntu / Debian 云服务器。填写域名与邮箱后复制命令，在服务器上以 root 执行；脚本会安装 Node.js、中继器、systemd 与 nginx，并申请 HTTPS 证书。")}</p>
              <div className="relay-cloud-fields">
                <label>
                  {t("域名")}<input
                    className="text-input mono"
                    value={cloudDomain}
                    onChange={(event) => setCloudDomain(event.target.value)}
                    placeholder="relay.example.com"
                    spellCheck={false}
                  />
                </label>
                <label>
                  {t("邮箱")}<input
                    className="text-input mono"
                    value={cloudEmail}
                    onChange={(event) => setCloudEmail(event.target.value)}
                    placeholder="you@example.com"
                    spellCheck={false}
                  />
                </label>
              </div>
              <div className="relay-command">
                <code>{installCommand}</code>
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => void copyInstallCommand()}
                >
                  <CopyIcon width={14} height={14} />
                  {copiedCommand ? t("已复制") : t("复制命令")}
                </button>
              </div>
              <p className="relay-cloud-note">
                {t("域名需已解析到这台服务器，并开放 80/443 端口。安装完成后把脚本输出的整条 wss:// 连接串（含 #k= 准入码）填到上方；准入码未强制时脚本会提示何时切换成强制。只想手动部署时，可下载 Linux 包按包内 README 操作。")}</p>
            </details>
          </section>

          <section className="companion-section">
            <div className="companion-section-head">
              <div>
                <h3>{t("手机可创建的工作区")}</h3>
                <p>
                  {t("手机端默认只能在电脑已打开的工作区里新建会话。把目录授权在这里后， 手机可以在这些目录下新建子文件夹作为工作区；访问范围仍然限制在新工作区内。")}</p>
              </div>
              <button
                type="button"
                className="button ghost small"
                disabled={rootBusy}
                onClick={() => void addRoot()}
              >
                {rootBusy ? <i className="spinner small" /> : null}
                {t("添加目录")}</button>
            </div>
            {roots.length === 0 ? (
              <div className="companion-empty compact">
                <span>{t("未授权任何目录。手机端只能在电脑已打开的工作区里新建会话。")}</span>
              </div>
            ) : (
              <div className="companion-devices">
                {roots.map((root) => (
                  <div className="companion-device" key={root}>
                    <div className="companion-device-body">
                      <strong>{root.split(/[\\/]/).filter(Boolean).pop() || root}</strong>
                      <span className="companion-root-path">{root}</span>
                    </div>
                    <button
                      type="button"
                      className="companion-revoke"
                      title={t("移除授权")}
                      aria-label={t("移除 {v1} 的授权", { v1: root })}
                      onClick={() => void removeRoot(root)}
                    >
                      <TrashIcon width={15} height={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {running ? (
            <>
              <div className="companion-address">
                <span className="companion-address-icon">
                  <LinkIcon width={15} height={15} />
                </span>
                <div>
                  <small>{t("手机页面")}</small>
                  <code>{status?.address ?? ''}</code>
                </div>
                <button type="button" className="button ghost small" onClick={() => void openLocal()}>
                  {t("本机预览")}</button>
              </div>

              <section className="companion-section" ref={pairingRef}>
                <div className="companion-section-head">
                  <div>
                    <h3>
                      <QrIcon width={15} height={15} />
                      {t("扫描二维码配对")}</h3>
                    <p>
                      {t("用手机相机或浏览器扫描，会打开 Pilot Link 并确认配对。")}{pairing?.mode === 'cloud' ? t("当前通过自建中继器跨网络配对。") : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="button primary small"
                    disabled={pairingLoading}
                    onClick={() => void createPairing()}
                  >
                    {pairingLoading ? (
                      <i className="spinner small" />
                    ) : (
                      <RefreshIcon width={14} height={14} />
                    )}
                    {pairing ? t("重新生成") : t("生成二维码")}
                  </button>
                </div>

                {pairing ? (
                  <div className="companion-pair-grid">
                    <div className="companion-qr">
                      <img src={pairing.qrDataUrl} alt={t("Pilot 手机连接配对二维码")} />
                    </div>
                    <div className="companion-pair-meta">
                      <span className="companion-expiry">{expiresIn}</span>
                      <p>
                        {t("在手机上打开链接并确认配对。二维码包含一次性密钥，过期后需要重新生成。")}</p>
                      <div className="companion-pair-actions">
                        <button type="button" className="button ghost small" onClick={() => void copy()}>
                          <CopyIcon width={14} height={14} />
                          {copied ? t("已复制") : t("复制链接")}
                        </button>
                      </div>
                      <code className="companion-url">{pairing.url}</code>
                    </div>
                  </div>
                ) : (
                  <div className="companion-empty">
                    <QrIcon width={24} height={24} />
                    <span>{t("生成二维码后，用手机扫描即可打开 Pilot Link。")}</span>
                  </div>
                )}
              </section>

              <section className="companion-section">
                <div className="companion-section-head">
                  <div>
                    <h3>{t("已配对设备")}</h3>
                    <p>
                      {t("共")}{phones.length} {t("台")}{phones.length > 0 ? t("，{v1} 台在线", { v1: phones.filter((phone) => phone.online).length }) : ''}
                      {t("。连续 7 天未使用会自动失效。")}</p>
                  </div>
                </div>
                {phones.length === 0 ? (
                  <div className="companion-empty compact">
                    <PhoneIcon width={20} height={20} />
                    <span>{t("还没有手机完成配对。")}</span>
                  </div>
                ) : (
                  <div className="companion-devices">
                    {phones.map((phone) => (
                      <div className="companion-device" key={phone.phoneId}>
                        <span className="companion-device-avatar">{initial(phone.name)}</span>
                        <div className="companion-device-body">
                          <strong>{phone.name}</strong>
                          <span>
                            <i className={`companion-status-dot small${phone.online ? ' is-on' : ''}`} />
                            {phone.online ? t("在线") : t("最后活动 {v1}", { v1: relativeTime(phone.lastSeen) })}
                            {' · '}
                            {phone.platform || 'mobile'}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="companion-revoke"
                          title={t("解除配对")}
                          aria-label={t("解除 {v1} 的配对", { v1: phone.name })}
                          onClick={() => void revoke(phone.phoneId)}
                        >
                          <TrashIcon width={15} height={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : (
            <div className="companion-offline-card">
              <PhoneIcon width={26} height={26} />
              <div>
                <strong>{t("开启后即可配对")}</strong>
                <p>{t("Pilot 不会上传会话或 API Key；连接器只负责转发端到端加密后的密文。")}</p>
              </div>
            </div>
          )}

          <div className="companion-note">
            <strong>{t("安全说明")}</strong>
            <p>
              {t("手机与电脑之间使用 ECDH P-256 + HKDF + AES-256-GCM 端到端加密。中继器只转发密文， 无法读取会话、命令或 API Key；配对凭证保存在电脑用户数据目录，可随时在这里解除。")}</p>
          </div>
        </div>

        <div className="modal-footer companion-footer">
          <span className="companion-device-id">
            {t("电脑标识")}{status?.deviceName ?? ''} · {status?.deviceId.slice(0, 8) ?? ''}
          </span>
          <button type="button" className="button" onClick={onClose}>
            {t("完成")}</button>
        </div>
      </div>
    </div>
  )
}
