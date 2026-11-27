/**
 * 会话空态的三条只读示例：点一下就能跑，且保证不动工作区。
 *
 * 为什么需要「示例」而不是一句提示：空态是最容易劝退人的地方——用户看到一个
 * 空输入框，不知道这套东西在当前项目里能干什么，只能自己去猜第一句话。
 * 三个示例各自覆盖一种典型用法（看清项目 / 走读代码 / 只读点评），
 * 点下去立刻有结果，比任何说明文字都直接。
 *
 * 「只读」是两层保证，缺一不可：
 *
 * 1. 任务文本自己把边界写在里面（`不要修改任何文件，也不要执行命令`）。
 *    即使将来档位被放宽、或用户把档位改回全部自动，模型仍然只读。
 * 2. 这一个 run 跑在 `manual`（只读自动）档位上：读文件自动放行，写入与命令
 *    一律先要审批，权限层还会再兜一次拒绝。所以点示例不会在工作区留下改动。
 *
 * 档位只能写正式值：`plan` / `dontAsk` 会被 store-schema 的 normalizeApprovalMode
 * 折叠成 `manual`、`acceptEdits` 折叠成 `auto`，写旧值会得到「调用里一个值、
 * 落盘后另一个值」。tests/onboarding-state.test.ts 已经盯住这一条。
 *
 * 只放「发给模型的那句话」：标题与说明留在渲染层，否则 i18n 覆盖率测试
 * 查不到它们有没有英文。做法与 `ONBOARDING_SAMPLE_TASK` 一致。
 */

import type { ApprovalMode } from './types'

export type ReadonlySampleId = 'overview' | 'walkthrough' | 'improve'

export interface ReadonlySample {
  id: ReadonlySampleId
  /** 发给模型的整句任务。边界写在句子里，不依赖档位。 */
  prompt: string
}

/** 示例跑在只读档位：读文件自动放行，写入与命令先问。 */
export const READONLY_SAMPLE_APPROVAL_MODE: ApprovalMode = 'manual'

/** 每条示例的任务都以这个词开头，运行日志里一眼能认出是空态示例。 */
export const READONLY_SAMPLE_PREFIX = '只读示例：'

export const READONLY_SAMPLES: ReadonlySample[] = [
  {
    id: 'overview',
    prompt:
      '只读示例：列出这个工作区根目录下的文件（只读，不要修改任何文件，也不要执行命令），然后用三句话说明这是什么项目、用什么技术栈、怎么启动。',
  },
  {
    id: 'walkthrough',
    prompt:
      '只读示例：挑一个最能代表这个项目的核心源码文件读一遍（只读，不要修改任何文件，也不要执行命令），讲清它做什么、被谁调用、改动它时要注意什么。',
  },
  {
    id: 'improve',
    prompt:
      '只读示例：只读分析这个项目的代码与文档（不要修改任何文件，也不要执行命令），列出三处最值得改进的地方，并按影响从大到小排序。',
  },
]
