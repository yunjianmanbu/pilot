import { useEffect, useRef, useState } from 'react'
import { freshApprovals } from '../../a11y/approval-announce'
import type { ApprovalRequest } from '../../../../shared/types'
import { CheckIcon } from '../../icons'
import { formatDuration, riskLabel, summarizeTool } from '../../ui'
import { t } from '../../i18n'
import { APPROVAL_LABELS } from './composer-state'

function ApprovalCountdown({ expiresAt }: { expiresAt?: string }) {
  const [remaining, setRemaining] = useState(() =>
    expiresAt ? Math.max(0, Date.parse(expiresAt) - Date.now()) : 0,
  )
  useEffect(() => {
    if (!expiresAt) return
    const tick = () =>
      setRemaining(Math.max(0, Date.parse(expiresAt) - Date.now()))
    tick()
    const timer = window.setInterval(tick, 1_000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  if (!expiresAt) return null
  return (
    <span className={`approval-countdown${remaining <= 30_000 ? ' urgent' : ''}`}>
      {remaining > 0 ? t("剩余 {v1}", { v1: formatDuration(remaining) }) : t("即将自动拒绝")}
    </span>
  )
}

export function ApprovalDock({
  approvals,
  approvalMode,
  onDecide,
  onSwitchToAuto,
}: {
  approvals: ApprovalRequest[]
  approvalMode: string
  onDecide: (callId: string, approved: boolean, remember: boolean) => void
  onSwitchToAuto?: () => void
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [remember, setRemember] = useState<Record<string, boolean>>({})
  const [announcement, setAnnouncement] = useState<{ key: number; text: string } | null>(null)
  const seenRef = useRef<string[]>([])
  const alertKeyRef = useRef(0)

  // 新审批是「必须打断」的事件：读屏用户如果正停在输入框里，不播这一句就只能
  // 靠卡片自己出现才发现。role="alert" 只负责这一次打断，所以播报节点是独立的
  // 一句话：卡片里的倒计时每秒变一次，把 live region 放在卡片上会变成每秒打断一次。
  useEffect(() => {
    const next = freshApprovals(seenRef.current, approvals)
    seenRef.current = next.seen
    if (next.fresh.length === 0) return
    alertKeyRef.current += 1
    setAnnouncement({
      key: alertKeyRef.current,
      text: next.fresh
        .map((request) =>
          t("需要确认：{v1}（{v2}）", { v1: request.tool, v2: riskLabel(request.risk) }),
        )
        .join(' '),
    })
  }, [approvals])

  if (approvals.length === 0) return null

  const decide = (callId: string, approved: boolean) => {
    setBusy((value) => ({ ...value, [callId]: true }))
    onDecide(callId, approved, remember[callId] === true)
  }
  const switchAndAllow = (callId: string) => {
    setBusy((value) => ({ ...value, [callId]: true }))
    // Switching the session changes the policy for every later call; approving
    // this pending one matches what 全部自动 would have done with it anyway.
    onSwitchToAuto?.()
    onDecide(callId, true, false)
  }

  return (
    <>
      {announcement ? (
        // key 变化 = 节点重建 = 内容插入，同一条工具再次请求确认时仍会播报。
        <div className="sr-only" role="alert" key={announcement.key}>
          {announcement.text}
        </div>
      ) : null}
      <div className="approval-stack">
        {approvals.map((request) => (
          <div className="approval-card" key={request.callId}>
            <div className="approval-head">
              <span className="approval-pulse" />
              <span className="approval-title">{t("需要你的确认")}</span>
              <span className={`risk-pill risk-${request.risk}`}>{riskLabel(request.risk)}</span>
              <span className="approval-mode">{APPROVAL_LABELS[approvalMode] ?? approvalMode}</span>
              <ApprovalCountdown expiresAt={request.expiresAt} />
            </div>
            <div className="approval-tool">
              <code>{request.tool}</code>
              <span>{summarizeTool({ id: '', name: request.tool, args: request.arguments, risk: request.risk, status: 'waiting' })}</span>
            </div>
            {request.reason ? (
              <div className="approval-reason">
                {request.reason}
                {request.rule ? <code>{request.rule}</code> : null}
              </div>
            ) : null}
            {request.tool === 'request_system_access' ? (
              <div className="approval-shell-warning">
                {t("这是 Agent 读取 Pilot 自身运行记录与执行策略的系统级授权：只读、绑定本次运行、到期自动失效。批准后它只能通过 read_execution_records / read_system_strategy 读取所选范围，不能修改设置或提升权限；优化建议会先成为草稿，仍需你审核后启用。")}
              </div>
            ) : null}
            {request.tool === 'run_shell' && approvalMode !== 'auto' ? (
              <div className="approval-shell-warning">
                {approvalMode === 'plan'
                  ? t("计划模式只允许只读命令；需要执行时请先退出计划模式。")
                  : t("完整 shell 不受工作区路径限制，当前会话不是「全部自动」，所以需要你确认。经常无人值守时，可把本会话改为全部自动。")}
              </div>
            ) : null}
            {Object.keys(request.arguments).length > 0 ? (
              <pre className="approval-args">{JSON.stringify(request.arguments, null, 2)}</pre>
            ) : null}
            {request.tool === 'run_shell' ? (
              <label className="approval-remember">
                <input
                  type="checkbox"
                  checked={remember[request.callId] === true}
                  onChange={(event) =>
                    setRemember((value) => ({ ...value, [request.callId]: event.target.checked }))
                  }
                />
                {t("始终允许这条命令（仅完全匹配时）")}
              </label>
            ) : null}
            <div className="approval-actions">
              <button
                type="button"
                className="button danger ghost"
                disabled={busy[request.callId]}
                onClick={() => decide(request.callId, false)}
              >
                {t("拒绝")}</button>
              {approvalMode !== 'auto' && approvalMode !== 'plan' && onSwitchToAuto ? (
                <button
                  type="button"
                  className="button ghost"
                  disabled={busy[request.callId]}
                  onClick={() => switchAndAllow(request.callId)}
                  title={t("本会话之后的所有工具调用都不再逐次确认；工作区路径限制、受保护路径和拒绝规则仍然生效。")}
                >
                  {t("改为全部自动并允许")}</button>
              ) : null}
              <button
                type="button"
                className="button primary"
                disabled={busy[request.callId]}
                onClick={() => decide(request.callId, true)}
              >
                {busy[request.callId] ? <i className="spinner" /> : <CheckIcon width={15} height={15} />}
                {t("允许一次")}</button>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
