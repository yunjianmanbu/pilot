import type { AppLogView } from './types'

/**
 * 把一条应用日志压成一行可粘贴的文本：`时间 级别 [领域] 事件 {细节}`。
 *
 * 为什么单独放这里：设置面板的「复制日志」按钮和以后可能出现的导出/CLI 出口
 * 必须格式一致，而组件里的内联拼串没法单测。记录进到这里时已经过
 * `redactSecrets` 与截断，这里只负责排版，不再改内容。
 */
export function formatLogRecord(record: AppLogView): string {
  const detail =
    record.detail && Object.keys(record.detail).length > 0 ? ` ${JSON.stringify(record.detail)}` : ''
  return `${record.at} ${record.level} [${record.area}] ${record.event}${detail}`
}

/** 多条记录按行拼接，供剪贴板或诊断包使用。 */
export function formatLogRecords(records: AppLogView[]): string {
  return records.map(formatLogRecord).join('\n')
}
