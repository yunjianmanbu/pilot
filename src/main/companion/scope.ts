/**
 * 请求作用域：一条远端请求背后用哪一套数据。
 *
 * 同一个进程里可以同时存在两套「数据面」（store + runner + 计费/快照/改动）：
 *
 * - `host`   主机作用域：本机用户、扫码配对的本机手机、被批准为「主机用户」的
 *            远端浏览器。它们看到的是同一份会话、工作区与设置。
 * - `client` 客户机作用域：远端浏览器以「客户机用户」身份接入时的独立数据。
 *
 * 为什么用 AsyncLocalStorage 而不是给每个 handler 加一个 scope 参数：手机协议层
 * 有 70 多处直接读 `host.options.store`，逐个改签名只会把「用哪份数据」这件事
 * 撒到每个函数里。绑定在请求链上，读的地方仍然写 `options.store`，但解析到的
 * 是这条请求自己的那一份；离开请求链（定时任务、runner 回调）自然回到主机作用域。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { CompanionOptions, CompanionRole, CompanionScope } from './types'

export type { CompanionRole, CompanionScope }

/** 会被作用域改写的选项键：其余选项（端口、静态资源、能力表）与身份无关。 */
export const SCOPED_OPTION_KEYS = ['store', 'runner', 'billing', 'checkpoints', 'changes'] as const

const storage = new AsyncLocalStorage<CompanionScope>()

/** 当前请求绑定的作用域；不在请求链上时为 null。 */
export function currentCompanionScope(): CompanionScope | null {
  return storage.getStore() ?? null
}

export function withCompanionScope<T>(scope: CompanionScope, run: () => T): T {
  return storage.run(scope, run)
}

/**
 * 把选项里的数据面换成「跟随当前请求」的取值器。
 *
 * 其它字段原样保留，所以调用方仍然拿到同一个 `CompanionOptions` 形状；
 * 只有 store/runner/billing/checkpoints/changes 会在客户机请求里指向另一套数据。
 */
export function bindScopedOptions(
  options: CompanionOptions,
  primary: CompanionScope,
): CompanionOptions {
  const resolve = (): CompanionScope => currentCompanionScope() ?? primary
  const bound: CompanionOptions = { ...options }
  for (const key of SCOPED_OPTION_KEYS) {
    Object.defineProperty(bound, key, {
      enumerable: true,
      configurable: true,
      get: () => (resolve() as unknown as Record<string, unknown>)[key],
    })
  }
  return bound
}

/** 两套作用域是否指向同一份数据（主机角色下无需切换）。 */
export function sameScope(a: CompanionScope | null, b: CompanionScope | null): boolean {
  return Boolean(a && b && a.store === b.store && a.runner === b.runner)
}

/**
 * 把宿主提供的 `guest` 选项补全成一套完整数据面。
 *
 * 只给了 store 或只给了 runner 的都算没装配：半套数据面会让客户机读到 A 的
 * 会话、写进 B 的库，比直接拒绝更危险。缺的部分不回退到主机，因为没有另一份
 * 可回的——这也是返回 null 而不是合并的原因。
 */
export function guestScopeOf(options: CompanionOptions): CompanionScope | null {
  const guest = options.guest
  if (!guest?.store || !guest?.runner) return null
  const checkpoints = guest.checkpoints ?? undefined
  const changes = guest.changes ?? undefined
  return {
    role: 'client',
    store: guest.store,
    runner: guest.runner,
    billing: guest.billing ?? options.billing,
    ...(checkpoints ? { checkpoints } : {}),
    ...(changes ? { changes } : {}),
  }
}
