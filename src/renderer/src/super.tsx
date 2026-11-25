import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
// 浏览器里没有 preload；这个页面在桌面端窗口里打开，但共用同一份桥定义。
import './browser-bridge'
import { t } from './i18n'
import type {
  SuperPilotMessage,
  SuperPilotRescueResult,
  SuperPilotStatus,
} from '../../shared/super'
import type { RunEvent } from '../../shared/types'

/**
 * 超级 Pilot 的应急界面（`super.html`），只在 `super-window.ts` 打开的独立窗口里
 * 运行。
 *
 * 三条设计约束，都是为了让它在「主界面已经坏了」的时候仍然可用：
 *   1. 不引任何主界面组件与 `styles.css`：样式内联在 `super.html`，主样式表损坏
 *      也不影响这里。
 *   2. 只依赖 `window.pilot.super.*`：不用 bootstrap、不读会话列表、不订阅
 *      `pilot:event`（那是主引擎的广播），因此主 store 读不出来时这里照样有画面。
 *   3. 每个异步动作都有兜底文案：状态拿不到就显示「未就绪 + 原因」，绝不白屏。
 */

interface TrailEntry {
  at: string
  label: string
  detail?: string
}

const POLL_MS = 4_000

function clock(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString()
}

function statusLabel(status: SuperPilotStatus | null, error: string): string {
  if (error) return t('不可用')
  if (!status) return t('正在连接…')
  if (status.state === 'failed') return t('未能启动')
  if (status.state === 'running') return t('运行中')
  if (status.state === 'booting') return t('启动中')
  return t('就绪')
}

function statusClass(status: SuperPilotStatus | null, error: string): string {
  if (error || status?.state === 'failed') return 'badge bad'
  if (status?.state === 'running') return 'badge busy'
  if (status) return 'badge ok'
  return 'badge'
}

function describeEvent(event: RunEvent): string | null {
  switch (event.type) {
    case 'run.started':
      return `${t('开始运行')} ${event.runId.slice(0, 8)}`
    case 'step.started':
      return `${t('第')} ${event.step} ${t('步')}`
    case 'tool.call':
      return `${t('调用工具')} ${event.call.name}`
    case 'tool.result':
      return `${t('工具结果')} ${event.name}${event.result.ok ? '' : ` · ${t('失败')}`}`
    case 'context.compacted':
      return `${t('上下文压缩')} · ${event.droppedMessages} ${t('条')}`
    case 'run.completed':
      return `${t('运行结束')} · ${event.status} · ${event.steps} ${t('步')}`
    case 'run.failed':
      return `${t('运行失败')} · ${event.message}`
    default:
      return null
  }
}

function App(): React.JSX.Element {
  const [status, setStatus] = useState<SuperPilotStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [messages, setMessages] = useState<SuperPilotMessage[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [noteBad, setNoteBad] = useState(false)
  const [trail, setTrail] = useState<TrailEntry[]>([])
  const [rescue, setRescue] = useState<SuperPilotRescueResult | null>(null)
  const messageEnd = useRef<HTMLDivElement | null>(null)

  const say = useCallback((text: string, bad = false) => {
    setNote(text)
    setNoteBad(bad)
  }, [])

  const refresh = useCallback(
    async (alsoMessages = false) => {
      const bridge = window.pilot?.super
      if (!bridge) {
        setStatusError(t('桥不可用：请从主界面的设置里重新打开这个窗口。'))
        return
      }
      try {
        const reply = await bridge.status()
        if (reply && typeof reply === 'object' && 'error' in reply) {
          setStatusError(String(reply.error))
        } else {
          setStatus(reply as SuperPilotStatus)
          setStatusError('')
        }
      } catch (error) {
        setStatusError(error instanceof Error ? error.message : String(error))
      }
      if (alsoMessages) {
        try {
          setMessages(await bridge.messages())
        } catch {
          // 历史读不出来不影响发指令：这里不覆盖主状态。
        }
      }
    },
    [],
  )

  useEffect(() => {
    void refresh(true)
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    const off = window.pilot?.super?.onEvent((event) => {
      const label = describeEvent(event)
      if (label) {
        setTrail((previous) =>
          [{ at: new Date().toISOString(), label }, ...previous].slice(0, 40),
        )
      }
      if (event.type === 'message.delta' || event.type === 'reasoning.delta') {
        setStatus((previous) => (previous ? { ...previous, state: 'running' } : previous))
      }
      if (event.type === 'run.completed' || event.type === 'run.failed') {
        void refresh(true)
      }
    })
    return () => off?.()
  }, [refresh])

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setBusy(true)
    say(t('已发出，等待超级 Pilot 接管…'))
    try {
      const result = await window.pilot.super.send(text)
      if (result.ok) {
        setDraft('')
        say(t('指令已进入运行。'))
      } else {
        say(result.error || t('发送失败'), true)
      }
      await refresh(true)
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true)
    } finally {
      setBusy(false)
    }
  }, [draft, refresh, say])

  const cancel = useCallback(async () => {
    try {
      await window.pilot.super.cancel()
      say(t('已请求取消。'))
      await refresh(true)
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true)
    }
  }, [refresh, say])

  const reset = useCallback(async () => {
    try {
      const result = await window.pilot.super.reset()
      say(result.ok ? t('已换新会话。') : t('换会话失败'), !result.ok)
      await refresh(true)
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true)
    }
  }, [refresh, say])

  const runRescue = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.pilot.super.rescue()
      if (result && typeof result === 'object' && 'error' in result) {
        say(String(result.error), true)
      } else {
        setRescue(result as SuperPilotRescueResult)
        const failed = (result as SuperPilotRescueResult).actions.filter((item) => !item.ok)
        say(
          failed.length === 0
            ? t('抢救完成：所有动作都成功。')
            : t('抢救完成，但有动作失败，见左侧明细。'),
          failed.length > 0,
        )
      }
      await refresh(true)
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true)
    } finally {
      setBusy(false)
    }
  }, [refresh, say])

  const openDir = useCallback(() => {
    const dir = status?.dataDir
    if (dir) void window.pilot.openLink(dir, false).catch(() => undefined)
  }, [status?.dataDir])

  const autonomous = status?.autonomy
  const blockerText = useMemo(() => {
    if (!autonomous) return ''
    if (autonomous.active) return t('完全自主档已生效：读写、联网、改自身源码都不再逐次确认。')
    return `${t('完全自主档未生效')}：${autonomous.blockers.join('、') || t('原因未知')}`
  }, [autonomous])

  return (
    <>
      <header>
        <h1>{t('超级 Pilot')}</h1>
        <span className="hint">{t('应急通道 · 独立数据面 · 全权限')}</span>
        <span className={statusClass(status, statusError)}>
          {statusLabel(status, statusError)}
        </span>
      </header>
      <main>
        <aside>
          <div className="card">
            <h2>{t('状态')}</h2>
            <div className="k">{t('数据面目录')}</div>
            <div className="v">{status?.dataDir || '—'}</div>
            <div className="k">{t('工作区')}</div>
            <div className="v">{status?.workspace || '—'}</div>
            <div className="k">{t('模型')}</div>
            <div className="v">
              {status?.model || t('未配置')}
              {status?.baseUrl ? `\n${status.baseUrl}` : ''}
            </div>
            <div className="k">{t('通道来源')}</div>
            <div className="v">
              {status?.inheritedFromHost
                ? t('已从主客户端继承模型通道')
                : t('独立配置（主客户端不可用时仍可用）')}
            </div>
            <div className="k">{t('会话')}</div>
            <div className="v">{status?.sessionId || '—'}</div>
            {status?.lastError ? (
              <>
                <div className="k">{t('最近错误')}</div>
                <div className="v" style={{ color: 'var(--sp-danger)' }}>
                  {status.lastError}
                </div>
              </>
            ) : null}
            {statusError ? <div className="note bad">{statusError}</div> : null}
            <div className={autonomous?.active ? 'note' : 'note bad'}>{blockerText}</div>
          </div>

          <div className="card">
            <h2>{t('动作')}</h2>
            <div className="actions">
              <button type="button" onClick={() => void refresh(true)}>
                {t('刷新')}</button>
              <button type="button" onClick={() => void reset()}>
                {t('换新会话')}</button>
              <button type="button" className="danger" onClick={() => void runRescue()} disabled={busy}>
                {t('一键抢救')}</button>
              <button type="button" onClick={openDir}>
                {t('打开数据目录')}</button>
            </div>
            {rescue ? (
              <div className="rescue" style={{ marginTop: 8 }}>
                {rescue.actions.map((action, index) => (
                  <div key={`${action.label}-${index}`}>
                    {action.ok ? '✓' : '✕'} {action.label}：{action.detail}
                  </div>
                ))}
              </div>
            ) : (
              <div className="note" style={{ marginTop: 8 }}>
                {t('「一键抢救」只做放开卡住的东西：取消主引擎所有运行、放掉待批审批、停止这里的运行。它不改任何业务数据。')}
              </div>
            )}
          </div>

          <div className="card">
            <h2>{t('运行轨迹')}</h2>
            {trail.length === 0 ? (
              <div className="note">{t('还没有事件。发一条指令就能看到步骤。')}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {trail.map((entry) => (
                  <div key={`${entry.at}-${entry.label}`} className="v" style={{ marginBottom: 0 }}>
                    <span style={{ color: 'var(--sp-soft)' }}>{clock(entry.at)} </span>
                    {entry.label}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="chat">
          <div className="messages">
            {messages.length === 0 ? (
              <div className="note">
                {t('这个窗口用于修 Pilot 自己。示例：')}
                <br />
                {t('「读一下运行日志，找出最近一次对话卡住的原因并修掉」')}
                <br />
                {t('「检查回退点维护是否还在占住主线程，必要时调低上限」')}
              </div>
            ) : (
              messages.map((message) => (
                <div
                  key={message.id}
                  className={message.isError ? 'msg err' : 'msg'}
                >
                  <div className="meta">
                    <span>{message.role}</span>
                    {message.name ? <span>{message.name}</span> : null}
                    <span style={{ marginLeft: 'auto' }}>{clock(message.createdAt)}</span>
                  </div>
                  <pre>{message.content}</pre>
                </div>
              ))
            )}
            <div ref={messageEnd} />
          </div>
          <div className="composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void send()
                }
              }}
              placeholder={t('告诉超级 Pilot 要修什么（Ctrl+Enter 发送）')}
            />
            <div className="row">
              <button type="button" className="primary" onClick={() => void send()} disabled={busy || !draft.trim()}>
                {t('发送')}</button>
              <button type="button" onClick={() => void cancel()}>
                {t('取消运行')}</button>
              {note ? <span className={noteBad ? 'note bad' : 'note'}>{note}</span> : null}
            </div>
            <div className="note">
              {t('它不看主界面的设置：审批固定「全部自动 + 完全自主」，改自身源码后能直接构建验证。')}
            </div>
          </div>
        </section>
      </main>
    </>
  )
}

document.documentElement.dataset['super'] = '1'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
