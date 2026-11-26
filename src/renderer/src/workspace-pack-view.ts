/**
 * 导出/导入对话框的纯逻辑。
 *
 * 勾选范围与「含明文密钥」的确认都在这里判定，组件只负责渲染：这样
 * 「关掉设置就必须连密钥一起关」「勾了密钥必须再勾一次确认」这两条
 * 规则能单独跑测试，不必把对话框渲染出来。
 */
import {
  DEFAULT_PACK_SCOPE,
  normalizePackScope,
  type WorkspacePackImportResult,
  type WorkspacePackScope,
} from '../../shared/workspace-pack'

/** 复选框顺序：从影响面最大的一项排到最细的一项。 */
export const PACK_SCOPE_KEYS = [
  'sessions',
  'files',
  'settings',
  'secrets',
  'checkpoints',
] as const

export type PackScopeKey = (typeof PACK_SCOPE_KEYS)[number]

export function initialPackScope(): WorkspacePackScope {
  return { ...DEFAULT_PACK_SCOPE }
}

/**
 * 勾/取消勾一项。
 *
 * 走 `normalizePackScope` 而不是直接改字段：密钥依附于设置，关掉设置时
 * 必须同时把密钥关掉，否则界面会出现「勾了但不会生效」的假状态。
 */
export function togglePackScope(
  scope: WorkspacePackScope,
  key: PackScopeKey,
  value: boolean,
): WorkspacePackScope {
  return normalizePackScope({ ...scope, [key]: value })
}

/** 勾了密钥就必须先确认「这是明文」，否则不许开始导出。 */
export function packScopeNeedsSecretAck(scope: WorkspacePackScope): boolean {
  return scope.secrets && scope.settings
}

/** 「开始导出」按钮是否可点。 */
export function canStartPackExport(
  scope: WorkspacePackScope,
  secretAck: boolean,
  busy: boolean,
): boolean {
  if (busy) return false
  if (!scope.settings && !scope.sessions && !scope.files && !scope.checkpoints) return false
  return !packScopeNeedsSecretAck(scope) || secretAck
}

/** 字节数转成人读的大小，导入结果里显示解包量。 */
export function formatPackBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** 导入结果里一行摘要里的各项计数（0 的项由组件跳过）。 */
export function packImportSegments(result: WorkspacePackImportResult): Array<{
  key: 'sessions' | 'messages' | 'todos' | 'scheduled' | 'files' | 'checkpoints' | 'secrets'
  count: number
}> {
  return [
    { key: 'sessions', count: result.sessions },
    { key: 'messages', count: result.messages },
    { key: 'todos', count: result.todos },
    { key: 'scheduled', count: result.scheduled },
    { key: 'files', count: result.files },
    { key: 'checkpoints', count: result.checkpoints },
    { key: 'secrets', count: result.secretsApplied },
  ]
}
