/**
 * 「减少动效」偏好的唯一入口。
 *
 * 系统里的这个开关同时管两件事，但 CSS 只能管到其中一件：
 *
 * - `transition` / `animation` 由 `styles.css` 里的媒体查询负责；
 * - `scroll-behavior: smooth` 与 JS 里的 `scrollIntoView({ behavior })`
 *   完全在样式之外，必须由调用方自己降级。
 *
 * 所以判断逻辑收在这一层，别处不要再手写 `matchMedia` —— 上一处手写的是
 * `CompanionDialog` 的配对二维码滚动，只要再有第二个地方自己判断，两边就
 * 会漂。
 */

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * 只声明用得到的那一点 `window`，不引用 DOM lib。
 *
 * 这些模块被 `tsconfig.node.json`（`lib: ["ES2022"]`，无 DOM）也一并类型检查，
 * 直接写 `window` 会在那边报 `Cannot find name 'window'`。
 */
interface ReducedMotionHost {
  matchMedia?: (query: string) => { matches: boolean }
}

function motionHost(): ReducedMotionHost | null {
  return (globalThis as { window?: ReducedMotionHost }).window ?? null
}

/**
 * 当前是否要求减少动效。
 *
 * 服务端渲染（`renderToStaticMarkup`）和测试环境里没有 `window`，此时按
 * 「不需要降级」处理：CSS 那边仍然生效，而 JS 也不会因为读不到偏好而崩。
 */
export function prefersReducedMotion(query: string = REDUCED_MOTION_QUERY): boolean {
  const host = motionHost()
  if (!host || typeof host.matchMedia !== 'function') return false
  try {
    return host.matchMedia(query).matches === true
  } catch {
    // 某些嵌入式 webview 的 matchMedia 会抛：降级为「不降级」，不能因此崩界面。
    return false
  }
}

/** 滚动动画的取值：降级时不滑，直接到位。 */
export function motionScrollBehavior(reduced: boolean): 'auto' | 'smooth' {
  return reduced ? 'auto' : 'smooth'
}

/** 一次滚动要用的 behavior，省得每个调用点都自己读偏好。 */
export function scrollBehaviorNow(): 'auto' | 'smooth' {
  return motionScrollBehavior(prefersReducedMotion())
}
