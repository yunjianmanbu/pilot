/**
 * 把界面语言钉成中文，供断言中文文案的测试文件在**第一个** import 里引入。
 *
 * 为什么要钉：这些用例断言的文案是中文（中文原文本身就是 i18n 字典的 key），
 * 而 renderer 的 i18n 在模块加载时按运行环境语言选 locale——开发机是 zh-CN，
 * GitHub Actions 的 runner 是 en-US，于是同一份测试本地全绿、CI 里成片变红
 * （期望 /更早的 8 项执行过程/，实际 "8 earlier steps"）。
 *
 * 为什么不做成全局 --import：`tests/i18n.test.ts` 自己要断言运行时 locale 的
 * 解析与切换，全局钉死会把它一起弄红。所以按文件引入，只影响真的依赖中文
 * 文案的用例。
 *
 * 为什么用 `resolveLocale` 而不是 `setLocale`：有本地缓存
 * (`localStorage['pilot.locale.v1']`) 时 `setLocale` 可能提前判断“没变化”，而
 * 这里要的是无条件生效。
 */
import { applyLocaleSetting, getLocale } from '../src/renderer/src/i18n'

applyLocaleSetting('zh-CN', [])

if (getLocale() !== 'zh-CN') {
  throw new Error(`测试语言没能钉成 zh-CN，当前是 ${getLocale()}`)
}