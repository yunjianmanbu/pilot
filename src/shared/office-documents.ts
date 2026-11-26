import type { OfficeDocumentKind } from './types'

/**
 * 「全局文档」只收常用办公文档：能在 Word / Excel / PowerPoint / WPS / PDF
 * 阅读器里双击打开的那几类，外加 Markdown（.md）——它是会话里最常产出的
 * 报告格式，Pilot 自己能排版预览。代码与脚本（.ts/.js/.py/.sh/.json/.yml…）
 * 不在白名单里，所以这里不需要一份排除表——名单之外的一律不收录。
 *
 * 同一套判定同时给主进程（汇总会话产出）和渲染进程（分类图标与文案）用，
 * 避免两边对「什么算文档」给出不同答案。
 */
const KIND_BY_EXTENSION: Record<string, OfficeDocumentKind> = {
  // Word 及其同类
  doc: 'word',
  docx: 'word',
  docm: 'word',
  dot: 'word',
  dotx: 'word',
  dotm: 'word',
  rtf: 'word',
  odt: 'word',
  ott: 'word',
  wps: 'word',
  pages: 'word',
  // 表格
  xls: 'excel',
  xlsx: 'excel',
  xlsm: 'excel',
  xlsb: 'excel',
  xlt: 'excel',
  xltx: 'excel',
  csv: 'excel',
  ods: 'excel',
  ots: 'excel',
  et: 'excel',
  numbers: 'excel',
  // 幻灯片
  ppt: 'powerpoint',
  pptx: 'powerpoint',
  pptm: 'powerpoint',
  pot: 'powerpoint',
  potx: 'powerpoint',
  pps: 'powerpoint',
  ppsx: 'powerpoint',
  odp: 'powerpoint',
  otp: 'powerpoint',
  dps: 'powerpoint',
  key: 'powerpoint',
  // 便携文档
  pdf: 'pdf',
  // 纯文本 Markdown 报告（不是脚本，也不含代码文件的常见扩展名）
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  mkd: 'markdown',
  mkdn: 'markdown',
}

/** 扩展名（小写、不含点）；路径里的目录名带点也不会被误判。 */
export function extensionOf(path: string): string {
  const clean = path.trim().replace(/[?#].*$/, '')
  const base = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * 办公文档的分类；不是办公文档时返回 null。
 *
 * 判断只看扩展名，不猜内容：`.md` 按扩展名收作 Markdown 文档，其余纯文本
 * （`.txt`、日志、源码）仍不进「全局文档」——用户在这个入口要的是能继续
 * 编辑或排版的成稿，不是宽泛的文本文件。
 */
export function officeDocumentKind(path: string): OfficeDocumentKind | null {
  return KIND_BY_EXTENSION[extensionOf(path)] ?? null
}

export function isOfficeDocument(path: string): boolean {
  return officeDocumentKind(path) !== null
}
