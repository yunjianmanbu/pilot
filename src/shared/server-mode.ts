/**
 * 服务器模式的共享常量与清洗规则。
 *
 * 桌面端「设置 → 网页服务」与 `pilot serve` 用的是同一个 `CompanionServer`，
 * 因此端口范围也必须是同一套：1024–65535，缺省用 companion 的默认端口。
 * 主进程、渲染进程与测试都从这里取，避免三处各写一份数字。
 */

/** 服务器模式的默认端口；`companion/constants.ts` 的 `DEFAULT_PORT` 同值。 */
export const DEFAULT_SERVER_PORT = 46_831

/** 端口下限：特权端口不让普通进程占用，也不该由设置页写进状态文件。 */
export const MIN_SERVER_PORT = 1_024
export const MAX_SERVER_PORT = 65_535

/**
 * 把任意输入收成一个可用的端口；超出范围或不是数字时回落到 `fallback`。
 *
 * 这里不抛错：设置页的输入框会边打字边提交候选值，宿主只负责把它收敛到
 * 一个合法端口，把「为什么不是我输入的 80」留在 UI 的提示里。
 */
export function normalizeServerPort(
  value: unknown,
  fallback: number = DEFAULT_SERVER_PORT,
): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  const rounded = Math.round(numeric)
  if (rounded < MIN_SERVER_PORT || rounded > MAX_SERVER_PORT) return fallback
  return rounded
}
