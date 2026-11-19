import { useEffect, useState } from 'react'
import {
  PRICE_UPDATED_AT,
  USD_CNY_RATE,
  costCurrencyFor,
  formatCostAmount,
  priceForModel,
} from '../../../shared/billing'
import type { ModelBalanceState, ModelBillingReport, ModelBalanceError } from '../../../shared/types'
import { RefreshIcon } from '../icons'
import { getLocale, t } from '../i18n'

export function balanceErrorText(balance: ModelBalanceState): string {
  const codes: Record<ModelBalanceError, string> = {
    'missing-key': t("未配置 API Key，无法读取余额。"),
    unauthorized: t("服务商拒绝了该 Key（401），余额无法读取。"),
    unsupported: t("该服务商或端点不支持余额查询。"),
    network: t("网络错误：{v1}", { v1: balance.errorDetail ?? '' }),
    'invalid-response': t("余额返回的格式无法识别。"),
    error: t("余额查询失败：{v1}", { v1: balance.errorDetail ?? '' }),
  }
  return balance.error ? codes[balance.error] : codes.error
}

function formatTokens(value: number): string {
  return value.toLocaleString()
}

function formatWhen(iso: string): string {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const CURRENCY_SYMBOL: Record<string, string> = { CNY: '¥', USD: '$' }

export function balanceAmount(value: string, currency: string): string {
  const symbol = CURRENCY_SYMBOL[currency.toUpperCase()] ?? `${currency} `
  const numeric = Number(value)
  if (!value) return '—'
  if (!Number.isFinite(numeric)) return `${symbol}${value}`
  return `${symbol}${numeric.toFixed(2)}`
}

/** One-line balance for a compact row; falls back to the translated error. */
export function balanceSummary(balance: ModelBalanceState): string {
  if (!balance.ok || balance.entries.length === 0) {
    const base = balanceErrorText(balance)
    // An unsupported provider carries the actionable explanation (for example
    // the DashScope console / BSS route). Keep it visible instead of hiding it
    // in a tooltip only.
    if (balance.error === 'unsupported' && balance.errorDetail) {
      return `${base} ${balance.errorDetail}`.slice(0, 240)
    }
    return base
  }
  return balance.entries
    .map((entry) => balanceAmount(entry.totalBalance, entry.currency))
    .join(' · ')
}

/**
 * Provider balance for the saved key plus a local cost estimate.
 *
 * The balance is authoritative (the provider answers it); the cost is an
 * estimate over the token counts Pilot recorded in `RunRecord`s, because the
 * provider exposes no per-key spend endpoint. The label says so explicitly.
 */
export function BillingPanel({ hasKey, model }: { hasKey: boolean; model: string }) {
  const [report, setReport] = useState<ModelBillingReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // Pricing is quoted in USD; Chinese shows it in RMB, English in USD.
  const currency = costCurrencyFor(getLocale())

  const load = async (refresh: boolean) => {
    setLoading(true)
    setError('')
    try {
      setReport(await window.pilot.modelBilling(refresh))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // The key and endpoint this report describes are fixed while the dialog is
    // open; a changed key is applied on save, which reopens the dialog.
    void load(false)
  }, [])

  const usage = report?.usage
  const balance = report?.balance

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3>{t("余额与费用")}</h3>
          <p>
            {t("余额来自当前 API Key 所属账户；费用按本机记录的 token 用量估算，仅供参考。")}
          </p>
        </div>
        <button
          type="button"
          className="button ghost small"
          onClick={() => void load(true)}
          disabled={loading}
        >
          {loading ? <i className="spinner" /> : <RefreshIcon width={14} height={14} />}
          {loading ? t("读取中…") : t("刷新")}
        </button>
      </div>

      <div className="billing-grid">
        <div className="billing-card">
          <span className="billing-label">{t("可用余额")}</span>
          {!report ? (
            <strong className="billing-value">—</strong>
          ) : balance && balance.ok && balance.entries.length > 0 ? (
            <>
              <strong className="billing-value">
                {balanceAmount(balance.entries[0]!.totalBalance, balance.entries[0]!.currency)}
              </strong>
              <span className="billing-note">
                {t("赠送 {v1} · 充值 {v2}", {
                  v1: balanceAmount(balance.entries[0]!.grantedBalance, balance.entries[0]!.currency),
                  v2: balanceAmount(
                    balance.entries[0]!.toppedUpBalance,
                    balance.entries[0]!.currency,
                  ),
                })}
              </span>
              {balance.entries.length > 1 ? (
                <span className="billing-note">
                  {balance.entries
                    .slice(1)
                    .map((entry) => balanceAmount(entry.totalBalance, entry.currency))
                    .join(' · ')}
                </span>
              ) : null}
              {balance.available ? null : (
                <span className="billing-warn">{t("余额不足，服务商会拒绝新的请求。")}</span>
              )}
            </>
          ) : (
            <span className="billing-warn">
              {error
                ? t("读取失败：{v1}", { v1: error })
                : balance
                  ? balanceErrorText(balance)
                  : t("尚未读取。")}
            </span>
          )}
          {balance?.ok ? (
            <span className="billing-note">
              {t("更新于 {v1} · {v2}", {
                v1: formatWhen(balance.fetchedAt),
                v2: balance.source,
              })}
            </span>
          ) : null}
        </div>

        <div className="billing-card">
          <span className="billing-label">{t("本机估算费用")}</span>
          <strong className="billing-value">
            {formatCostAmount(usage?.estimatedCostUsd ?? null, currency)}
          </strong>
          {usage && usage.runs > 0 ? (
            <>
              <span className="billing-note">
                {t("{v1} 次运行 · 输入 {v2} · 输出 {v3} tokens", {
                  v1: usage.runs,
                  v2: formatTokens(usage.promptTokens),
                  v3: formatTokens(usage.completionTokens),
                })}
              </span>
              {usage.cacheHitTokens > 0 ? (
                <span className="billing-note">
                  {t("其中缓存命中 {v1} tokens，按更低价计算。", {
                    v1: formatTokens(usage.cacheHitTokens),
                  })}
                </span>
              ) : null}
              {usage.unpricedModels.length > 0 ? (
                <span className="billing-warn">
                  {t("{v1} 没有价格表，未计入估算。", {
                    v1: usage.unpricedModels.map((name) => name || t("未记录模型")).join('、'),
                  })}
                </span>
              ) : null}
            </>
          ) : (
            <span className="billing-note">{t("本机还没有运行记录。")}</span>
          )}
        </div>
      </div>

      {usage && usage.rows.length > 1 ? (
        <div className="billing-table">
          {usage.rows.map((row) => (
            <div className="billing-row" key={row.model || '__unknown__'}>
              <span className="billing-row-model">{row.model || t("未记录模型")}</span>
              <span className="billing-row-tokens">
                {formatTokens(row.promptTokens + row.completionTokens)} tokens
              </span>
              <span className="billing-row-cost">{formatCostAmount(row.estimatedCostUsd, currency)}</span>
            </div>
          ))}
        </div>
      ) : null}

      <p className="billing-foot">
        {priceForModel(model)
          ? t("单价取自 DeepSeek 定价页（高峰价，非高峰按半价折算，更新于 {v1}）。当前模型", {
              v1: PRICE_UPDATED_AT,
            })
          : t("这个模型还没有收录单价，只统计 token 用量。当前模型")}{' '}
        <code>{model || t("未知")}</code>
      </p>
      {currency === 'CNY' ? (
        <p className="billing-foot">
          {t("费用按 1 美元 ≈ {v1} 元折算成人民币显示。", { v1: USD_CNY_RATE })}
        </p>
      ) : null}
      {hasKey ? null : <p className="billing-foot">{t("配置 API Key 后才能读取余额。")}</p>}
    </section>
  )
}
