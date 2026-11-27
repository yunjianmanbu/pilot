import './locale-zh.mjs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { diagnosticsExportOutcome, type DiagnosticsExportResult } from '../src/shared/diagnostics-bundle'
import { SelfCheckExportReceipt, SelfCheckPanel } from '../src/renderer/src/components/SelfCheckPanel'

/**
 * 「导出诊断包」的两条界面规则：
 *
 * 1. 用户自己点了取消，不能报错——这是这类功能最常见的体验缺陷；
 * 2. 脱敏自检没过时，必须明确告诉用户「没导出」，而不是留下一个看起来正常的包。
 *
 * 判定抽成 `diagnosticsExportOutcome` 后就能在这里直接断言，不必装 jsdom。
 */

function result(over: Partial<DiagnosticsExportResult> = {}): DiagnosticsExportResult {
  return {
    ok: true,
    cancelled: false,
    path: 'C:/Users/alice/Downloads/Pilot-diagnostics-20261126-1504.zip',
    files: 6,
    logLines: 500,
    bytes: 24_576,
    blocked: [],
    ...over,
  }
}

describe('diagnostics export outcome', () => {
  it('取消时完全静默', () => {
    expect(diagnosticsExportOutcome(result({ ok: false, cancelled: true, path: null }))).toEqual({
      kind: 'silent',
    })
  })

  it('成功时回带文件数、日志条数与体积', () => {
    expect(diagnosticsExportOutcome(result())).toEqual({
      kind: 'ok',
      files: 6,
      logLines: 500,
      bytes: 24_576,
    })
  })

  it('脱敏闸门拦下时优先说清命中了什么', () => {
    const outcome = diagnosticsExportOutcome(
      result({ ok: false, files: 0, bytes: 0, blocked: ['api key', 'password'], error: undefined }),
    )
    expect(outcome.kind).toBe('error')
    expect(outcome.kind === 'error' && outcome.message).toContain('api key')
    expect(outcome.kind === 'error' && outcome.message).toContain('password')
  })

  it('主进程给了原因就用它', () => {
    const outcome = diagnosticsExportOutcome(
      result({ ok: false, error: '系统保存对话框不可用' }),
    )
    expect(outcome).toEqual({ kind: 'error', message: '系统保存对话框不可用' })
  })

  it('没有结果也不静默', () => {
    expect(diagnosticsExportOutcome(null).kind).toBe('error')
    expect(diagnosticsExportOutcome(undefined).kind).toBe('error')
  })
})

describe('self check panel export button', () => {
  it('渲染出导出按钮与说明，且不影响原有的复制全文', () => {
    const html = renderToStaticMarkup(<SelfCheckPanel onError={() => {}} />)
    expect(html).toContain('导出诊断包')
    expect(html).toContain('复制全文')
    // 说明里必须写明「路径已打码」，否则用户不敢把这个包发给别人。
    expect(html).toContain('打码')
  })

  it('导出成功后回执真的渲染成可见文本', () => {
    // 回归点：回执文本以前只写进 state、从不渲染，用户点完看不到任何反馈。
    const html = renderToStaticMarkup(
      <SelfCheckExportReceipt text="已导出 6 个文件 · 9 条日志 · 6.1 KB" />,
    )
    expect(html).toContain('已导出 6 个文件')
    expect(html).toContain('role="status"')
    // 没有结果时必须什么都不渲染，而不是留一个空壳占位。
    expect(renderToStaticMarkup(<SelfCheckExportReceipt text={null} />)).toBe('')
  })
})
