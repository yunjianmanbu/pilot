// 记忆、计划、待办、定时任务与自我改进提案。
// 工具定义与执行放在一起：改一个工具只动这一个文件。
import type { AgentToolDefinition, PlanItem, ScheduledTaskInput, ToolResult } from '../../../shared/types'
import { join } from 'node:path'
import { REMEMBER, UPDATE_PLAN, ADD_TODO, SCHEDULE_TASK, PROPOSE_SELF_UPDATE } from './spec'
import { PLAN_ITEM_LIMIT } from '../../../shared/plan-limits'
import type { ToolHost } from './spec'
import { formatScheduleLine, formatScheduleList, scheduleKindArg, minutesArg } from './host'

export const planTools: AgentToolDefinition[] = [
{
    name: REMEMBER,
    description:
      'Save one durable fact about this project that will be available in future sessions (a located code fact, the command that proves a change, a path that does not work, an invariant that must stay in sync, a platform constraint, an abandoned approach). Only save facts that will still be true next week. Write one sentence under 200 characters: state what is true, not what happened. If the same insight is already in project memory, saving it again counts as a re-derivation and raises its rank. Do not save secrets, credentials or transient task details.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'One concise, durable fact under 200 characters.' },
        reason: { type: 'string', description: 'Why this is worth remembering.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    risk: 'control',
    source: 'control',
  },
{
    name: UPDATE_PLAN,
    description:
      'Create or update the visible task plan. Use this at the start of any multi-step task and after each milestone. Keep 2-8 items, one in_progress at a time, and mark items done only when verified. Order items by dependency instead of by the order they were asked: work that another item must wait for goes first, independent work keeps the order the user wrote, and when your order differs from theirs, explain why in goal.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'One sentence describing the outcome.' },
        items: {
          type: 'array',
          description: 'Ordered task items with status.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['text', 'status'],
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    risk: 'control',
    source: 'control',
  },
{
    name: ADD_TODO,
    description:
      "Append items to this session's todo list (the 待办 panel the user can send later as new messages). Use it when the user asks to record follow-ups or TODOs in the session, including 写待办. Do not write them into a scratch Markdown file. Items already pending with the same text are skipped; update_plan is for the steps of the current turn, this list is a backlog for later.",
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Todo texts in the order the user should see them. Max 20.',
          items: { type: 'string' },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    risk: 'control',
    source: 'control',
  },
{
    name: SCHEDULE_TASK,
    description:
      "Create, list, pause/resume, edit or delete this session's scheduled tasks (定时任务). A scheduled task fires later (or repeatedly) and sends its content as a normal user message to this session, so the run inherits this workspace, model and approval policy. Use it whenever the user says in conversation that something should happen at a later time or on a repeat (「20 分钟后…」「每天 9 点…」「每隔两小时…」) instead of telling them to open the schedule dialog. All times are the user's local time. kind=once uses delayMinutes (1-10080), kind=interval uses intervalMinutes (1-10080), kind=daily uses timeOfDay \"HH:mm\" plus an optional startDate \"YYYY-MM-DD\": pass startDate whenever the user says 「从明天开始」「从下周一起」（or gives a date), otherwise a daily task whose time already passed today would fire today. Run action=list first to find the short id of a task you want to update or remove.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'add', 'update', 'remove'],
          description: 'What to do with the schedule.',
        },
        taskId: {
          type: 'string',
          description:
            'Required for update and remove: the full id, or the short id prefix that action=list printed.',
        },
        content: {
          type: 'string',
          description:
            'Required for add: the message to run later, written as the user would type it.',
        },
        kind: {
          type: 'string',
          enum: ['once', 'interval', 'daily'],
          description: 'once = one future run, interval = every N minutes, daily = every day at HH:mm.',
        },
        delayMinutes: {
          type: 'number',
          description: 'kind=once: minutes from now before the single run (1-10080).',
        },
        intervalMinutes: {
          type: 'number',
          description: 'kind=interval: minutes between runs (1-10080).',
        },
        timeOfDay: {
          type: 'string',
          description: 'kind=daily: local wall-clock time as "HH:mm".',
        },
        startDate: {
          type: 'string',
          description:
            'kind=daily: local "YYYY-MM-DD" of the first day; the task never fires before it. Omit to start today. Use it for 「从明天开始每天 20:00」.',
        },
        enabled: {
          type: 'boolean',
          description: 'update: false pauses the task, true resumes it.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    risk: 'control',
    source: 'control',
  },
{
    name: PROPOSE_SELF_UPDATE,
    description:
      'Propose an update to your own operating profile (prompt addendum and strategy limits). Use ONLY when the user explicitly asks you to improve, optimize or update yourself. scope=workspace targets this project; scope=global targets every workspace using Pilot. It creates a draft for review; it does not activate anything. Never include credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        promptAddendum: {
          type: 'string',
          description:
            'Concrete operating rules to add (max 4000 chars). Refine behaviour; never weaken safety, evidence or approval rules.',
        },
        rationale: { type: 'string', description: 'Evidence from recent runs that justifies the change.' },
        scope: {
          type: 'string',
          enum: ['workspace', 'global'],
          description:
            'workspace (default) improves this project; global proposes a system-wide profile after the user approves reading system strategy.',
        },
        maxSteps: { type: 'number', description: 'Optional step cap, 20-500.' },
        temperature: { type: 'number', description: 'Optional temperature, 0-1.' },
      },
      required: ['promptAddendum', 'rationale'],
      additionalProperties: false,
    },
    risk: 'control',
    source: 'control',
  },
]

/** 记忆、计划、待办、定时任务与自我改进提案。 返回 null 表示本域没有这个工具。 */
export async function runPlanTool(
  name: string,
  args: Record<string, unknown>,
  host: ToolHost,
  signal: AbortSignal,
): Promise<ToolResult | null> {
  if (name === REMEMBER) {
  {
        const content = typeof args['content'] === 'string' ? args['content'].trim() : ''
        if (!content) throw new Error('content must be a non-empty string')
        if (content.length > 500) throw new Error('Memory entry is too long (max 500 characters)')
        const entry = await host.remember(
          content,
          typeof args['reason'] === 'string' ? args['reason'] : undefined,
        )
        return { ok: true, output: `Remembered (${entry.id.slice(0, 8)}): ${content}` }
      }
  }
  if (name === UPDATE_PLAN) {
  {
        const rawItems = Array.isArray(args['items']) ? args['items'] : []
        const items: PlanItem[] = []
        for (const [index, item] of rawItems.slice(0, PLAN_ITEM_LIMIT).entries()) {
          if (!item || typeof item !== 'object') continue
          const record = item as Record<string, unknown>
          const text = typeof record['text'] === 'string' ? record['text'].trim() : ''
          if (!text) continue
          const status =
            record['status'] === 'done' || record['status'] === 'in_progress'
              ? record['status']
              : 'pending'
          items.push({ id: `plan-${index + 1}`, text, status })
        }
        if (items.length === 0) throw new Error('At least one plan item is required')
        host.updatePlan({
          goal: typeof args['goal'] === 'string' ? args['goal'].trim() : '',
          items,
        })
        return {
          ok: true,
          output: `Plan updated: ${items.filter((item) => item.status === 'done').length}/${items.length} done.`,
        }
      }
  }
  if (name === ADD_TODO) {
  {
        const rawItems = Array.isArray(args['items']) ? args['items'] : []
        const items = rawItems
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.replace(/\s+/g, ' ').trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 20)
        if (items.length === 0) throw new Error('items must contain at least one non-empty string')
        if (!host.addTodos) throw new Error('The todo list is not available in this session')
        const created = await host.addTodos(items)
        return {
          ok: true,
          output:
            created.length === 0
              ? `No new todos: all ${items.length} item(s) are already pending in the todo list.`
              : `Added ${created.length} todo(s): ${created.map((todo) => todo.text).join(' | ')}`,
        }
      }
  }
  if (name === SCHEDULE_TASK) {
  {
        if (!host.scheduleTasks) throw new Error('Scheduled tasks are not available in this session')
        const action = typeof args['action'] === 'string' ? args['action'].trim() : ''
        if (action === 'list') {
          const result = await host.scheduleTasks({ action: 'list' })
          return {
            ok: true,
            output: formatScheduleList(result.tasks),
            metadata: { scheduledTasks: result.tasks.length },
          }
        }
        if (action === 'add') {
          const content =
            typeof args['content'] === 'string'
              ? args['content'].replace(/\s+/g, ' ').trim().slice(0, 4_000)
              : ''
          if (!content) throw new Error('content is required to add a scheduled task')
          const kind = scheduleKindArg(args['kind'])
          const input: ScheduledTaskInput = { content, kind }
          if (kind === 'once') input.delayMinutes = minutesArg(args['delayMinutes'], 10)
          if (kind === 'interval') input.intervalMinutes = minutesArg(args['intervalMinutes'], 60)
          if (kind === 'daily') {
            const timeOfDay = typeof args['timeOfDay'] === 'string' ? args['timeOfDay'].trim() : ''
            if (!timeOfDay) throw new Error('timeOfDay ("HH:mm") is required for a daily schedule')
            input.timeOfDay = timeOfDay
            const startDate = typeof args['startDate'] === 'string' ? args['startDate'].trim() : ''
            if (startDate) input.startDate = startDate
          }
          const result = await host.scheduleTasks({ action: 'add', input })
          return {
            ok: true,
            output: [
              '已创建定时任务（绑定当前会话，到点后自动在这里执行）：',
              result.task ? formatScheduleLine(result.task) : '',
              '',
              '本会话的定时任务：',
              formatScheduleList(result.tasks),
            ]
              .filter((line) => line !== '')
              .join('\n'),
            metadata: { scheduledTasks: result.tasks.length },
          }
        }
        if (action !== 'update' && action !== 'remove') {
          throw new Error(`Unknown action "${action}"; use list, add, update or remove`)
        }
        const taskId = typeof args['taskId'] === 'string' ? args['taskId'].trim() : ''
        if (!taskId) throw new Error(`taskId is required to ${action} a scheduled task`)
        if (action === 'remove') {
          const result = await host.scheduleTasks({ action: 'remove', taskId })
          return {
            ok: true,
            output: [
              `已删除定时任务 ${taskId}。`,
              '',
              '本会话剩下的定时任务：',
              formatScheduleList(result.tasks),
            ].join('\n'),
            metadata: { removed: result.removed ?? taskId, scheduledTasks: result.tasks.length },
          }
        }
        const patch: Partial<ScheduledTaskInput> & { enabled?: boolean } = {}
        if (args['content'] !== undefined) {
          const content =
            typeof args['content'] === 'string'
              ? args['content'].replace(/\s+/g, ' ').trim().slice(0, 4_000)
              : ''
          if (!content) throw new Error('content cannot be empty when updating a scheduled task')
          patch.content = content
        }
        if (args['kind'] !== undefined) patch.kind = scheduleKindArg(args['kind'])
        if (typeof args['delayMinutes'] === 'number') {
          patch.delayMinutes = minutesArg(args['delayMinutes'], 10)
        }
        if (typeof args['intervalMinutes'] === 'number') {
          patch.intervalMinutes = minutesArg(args['intervalMinutes'], 60)
        }
        if (typeof args['timeOfDay'] === 'string' && args['timeOfDay'].trim()) {
          patch.timeOfDay = args['timeOfDay'].trim()
        }
        if (typeof args['startDate'] === 'string') {
          // 空串是明确「从今天起」，不能当成「没传」而被忽略。
          patch.startDate = args['startDate'].trim()
        }
        if (typeof args['enabled'] === 'boolean') patch.enabled = args['enabled']
        if (Object.keys(patch).length === 0) {
          throw new Error('Nothing to update: pass content, kind, a time field or enabled')
        }
        const result = await host.scheduleTasks({ action: 'update', taskId, input: patch })
        return {
          ok: true,
          output: [
            '已更新定时任务：',
            result.task ? formatScheduleLine(result.task) : '',
            '',
            '本会话的定时任务：',
            formatScheduleList(result.tasks),
          ]
            .filter((line) => line !== '')
            .join('\n'),
          metadata: { scheduledTasks: result.tasks.length },
        }
      }
  }
  if (name === PROPOSE_SELF_UPDATE) {
  {
        const promptAddendum =
          typeof args['promptAddendum'] === 'string' ? args['promptAddendum'].trim() : ''
        const rationale = typeof args['rationale'] === 'string' ? args['rationale'].trim() : ''
        if (!promptAddendum || !rationale) {
          throw new Error('promptAddendum and rationale are required')
        }
        const scope = args['scope'] === 'global' ? 'global' : 'workspace'
        const draft = await host.proposeSelfUpdate({
          promptAddendum,
          rationale,
          scope,
          ...(typeof args['maxSteps'] === 'number' ? { maxSteps: args['maxSteps'] } : {}),
          ...(typeof args['temperature'] === 'number' ? { temperature: args['temperature'] } : {}),
        })
        return {
          ok: true,
          output: [
            `Draft ${scope} profile v${draft.version} created. It is NOT active; the user can review, evaluate and enable it in the Evolution panel.`,
            draft.explanation
              ? [
                  '',
                  'Plain-language summary of this draft (use it to answer the user; do not paste the rules):',
                  `- change: ${draft.explanation.headline}`,
                  ...draft.explanation.changes.map((item) => `- behaviour: ${item}`),
                  `- impact: ${draft.explanation.impact}`,
                  ...draft.explanation.risks.map((item) => `- risk: ${item}`),
                  `- recommendation: ${draft.explanation.recommend === 'enable' ? 'enable now' : 'keep the current version for now'}`,
                  draft.explanation.reason ? `- why: ${draft.explanation.reason}` : '',
                ]
                  .filter(Boolean)
                  .join('\n')
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        }
      }
  }
  return null
}
