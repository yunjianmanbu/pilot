/**
 * 会话报告的结构。
 *
 * 放在 shared 里是因为两边都要用：主进程按这个形状产出，渲染层按它渲染；
 * 生成逻辑（buildSessionReport）留在主进程，避免把消息处理带进渲染进程。
 */

export interface SessionReport {
  /** 报告标题，界面弹窗的标题与文件名都用它。 */
  title: string
  /** 完整 Markdown 正文；复制与保存都直接用它。 */
  markdown: string
  /** 本轮写过（或改过）的文件，按首次出现顺序去重。 */
  changedFiles: string[]
  /** 本轮有验证类命令且最后一次成功。 */
  verified: boolean
  /** 失败的工具调用，一行一条。 */
  failures: string[]
}
