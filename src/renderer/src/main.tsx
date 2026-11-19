import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

/**
 * 渲染进程的崩溃现场：白屏时最有用的一条信息。转发给主进程写进应用日志，
 * 因为渲染进程一旦崩溃就没有任何界面能把错误显示出来。
 *
 * 只发摘要与前三层栈帧，并且经过 IPC 后才落盘 —— 主进程会再走一遍
 * `redactSecrets` 与截断，避免渲染期文本（可能含用户输入）整段进日志。
 */
function reportRendererError(summary: string, stack?: string, source?: string): void {
  void window.pilot
    ?.reportRendererError({
      summary: summary.slice(0, 240),
      stack: stack?.split('\n').slice(0, 4).join('\n').slice(0, 400),
      source,
    })
    .catch(() => undefined)
}

window.addEventListener('error', (event) => {
  const error = event.error instanceof Error ? event.error : undefined
  reportRendererError(
    error ? `${error.name}: ${error.message}` : String(event.message || '渲染进程错误'),
    error?.stack,
    event.filename,
  )
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  reportRendererError(
    reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
    reason instanceof Error ? reason.stack : undefined,
  )
})

/**
 * 拖到会话框以外的地方时，Electron 默认会导航到那个 file:// 地址，整个界面就
 * 跟着白屏了。窗口级只做一件事：吃掉这个默认行为（会话框自己的 drop 先消化
 * 文件，它的 handler 在冒泡前已经 preventDefault）。
 */
for (const type of ['dragover', 'drop'] as const) {
  window.addEventListener(type, (event) => event.preventDefault())
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
