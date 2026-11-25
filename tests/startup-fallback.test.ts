import { describe, expect, it, vi } from 'vitest'
import { createStartupFallback } from '../src/main/startup-fallback'

/**
 * 启动失败兜底：主引擎起不来时，应急入口必须还在。
 *
 * 这里断言的是「失败之后还能留下什么」——真实启动链在 `index.ts` 的
 * `whenReady().catch(reportStartupFailure)`，而这一步只有在别处抛错时才跑得到，
 * 所以把动作抽成可注入依赖后在这里覆盖。
 */
function deps(overrides: Partial<Parameters<typeof createStartupFallback>[0]> = {}) {
  return {
    log: vi.fn(),
    noteHostFailure: vi.fn(),
    registerSuperIpc: vi.fn(),
    createTray: vi.fn(),
    openSuperWindow: vi.fn(),
    theme: () => 'dark' as const,
    ...overrides,
  }
}

describe('startup fallback', () => {
  it('记录失败原因、补注册通道、建托盘并打开应急窗口', () => {
    const d = deps()
    createStartupFallback(d)(new Error('core.json 损坏'))

    expect(d.log).toHaveBeenCalledWith(
      expect.objectContaining({ area: 'startup', event: 'startup.failed', level: 'error' }),
    )
    expect(d.noteHostFailure).toHaveBeenCalledWith('启动失败：core.json 损坏')
    expect(d.registerSuperIpc).toHaveBeenCalledTimes(1)
    expect(d.createTray).toHaveBeenCalledTimes(1)
    expect(d.openSuperWindow).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('通道已注册（重复注册抛错）时仍然会打开应急窗口', () => {
    const d = deps({
      registerSuperIpc: vi.fn(() => {
        throw new Error("Attempted to register a second handler for 'pilot:super-status'")
      }),
    })
    expect(() => createStartupFallback(d)(new Error('boom'))).not.toThrow()
    expect(d.createTray).toHaveBeenCalledTimes(1)
    expect(d.openSuperWindow).toHaveBeenCalledTimes(1)
    // 失败本身要被记下来，不能被兜底逻辑吞掉。
    expect(d.log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'startup.ipc_failed', level: 'error' }),
    )
  })

  it('每一条依赖都抛错时不向上抛，并把各条失败分别记下来', () => {
    const boom = () => {
      throw new Error('dep failed')
    }
    const log = vi.fn<(entry: { event: string }) => void>()
    const d = deps({
      log,
      noteHostFailure: boom,
      registerSuperIpc: boom,
      createTray: boom,
      openSuperWindow: boom,
      theme: boom,
    })
    expect(() => createStartupFallback(d)(new Error('startup broke'))).not.toThrow()
    const events = log.mock.calls.map(([entry]) => entry.event)
    expect(events).toContain('startup.failed')
    expect(events).toContain('startup.note_failed')
    expect(events).toContain('startup.tray_failed')
    expect(events).toContain('startup.emergency_window_failed')
  })

  it('日志自身写不出去时也不抛错', () => {
    const d = deps({
      log: vi.fn(() => {
        throw new Error('log 目录不可写')
      }),
      createTray: vi.fn(() => {
        throw new Error('no icon')
      }),
    })
    expect(() => createStartupFallback(d)(new Error('startup broke'))).not.toThrow()
    expect(d.openSuperWindow).toHaveBeenCalledTimes(1)
  })

  it('读主题失败时用深色打开窗口', () => {
    const d = deps({
      theme: () => {
        throw new Error('store 不可读')
      },
    })
    createStartupFallback(d)(new Error('boom'))
    expect(d.openSuperWindow).toHaveBeenCalledWith({ theme: 'dark' })
  })
})
