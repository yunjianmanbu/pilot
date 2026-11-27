import { useStreamAnnouncement } from '../a11y/streaming-announce'

/**
 * 流式正文的读屏通道。
 *
 * 正文本身每来一个 token 就整块重渲染，把 `aria-live` 直接挂上去等于让读屏
 * 逐字重播。这里换成一个视觉隐藏、内容按句追加的区域：新增一句读一句，
 * 运行结束时补播最后半句（见 `useStreamAnnouncement`）。
 *
 * 几个属性的作用，改之前先看清楚：
 *
 * - `aria-live="polite"`：等读者手头的朗读停下来再念，不抢焦点；
 * - `aria-atomic="false"`：只念变动的节点，不重读整个区域（`role="status"`
 *   隐含 `atomic="true"`，所以这里刻意不用 role）；
 * - `aria-relevant="additions"`：条目超过上限被裁掉时不要念「已删除」。
 */
export function StreamAnnouncer({
  text,
  active,
  resetKey,
}: {
  /** 当前这一轮正在写出的正文（与屏幕上的流式消息同源）。 */
  text: string
  /** 这一轮还在跑：轮询缓冲、按句播报。 */
  active: boolean
  /** 换轮次（runId 或会话）时清空缓冲，避免把上一轮尾巴念进新的回答。 */
  resetKey?: string | number | undefined
}) {
  const entries = useStreamAnnouncement(text, active, { resetKey })
  return (
    <div
      className="sr-only"
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions"
      data-stream-announcer=""
    >
      {entries.map((entry) => (
        <div key={entry.id}>{entry.text}</div>
      ))}
    </div>
  )
}
