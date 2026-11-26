import type { ReactNode } from 'react'
import {
  BookmarkIcon,
  BookOpenIcon,
  CameraIcon,
  ClockIcon,
  CloudIcon,
  CursorIcon,
  FolderIcon,
  GitBranchIcon,
  LightbulbIcon,
  MessageIcon,
  SparkIcon,
  StepsIcon,
  TodoIcon,
  UsersIcon,
  WrenchIcon,
} from '../icons'

/**
 * 执行过程里每一种步骤前面那个小图标。
 *
 * 以前工具卡只有七种图标，其余一律落到「纸张」上：读文件、写文件、git、网页、
 * 截图、插件工具看起来完全一样，扫一眼看不出这一轮到底在干什么。这里按「这
 * 个工具对什么动手」分类，同一个类别的名字前缀走通配，新工具不用回来改表。
 *
 * 判据是动作，不是实现：改文件用铅笔，只读文件用摊开的书，派活给别人用两个人，
 * 找东西用放大镜，定计划用台阶，截图用相机，操作界面上的控件用鼠标指针；认不
 * 出来的工具兜底成扳手（它确实是个工具），而不是纸张（纸张会让「未知工具」读起
 * 来像「读了文件」）。
 *
 * ## 形状按「剪影族」分工，一类只进一个族
 *
 * 上一版只做到「每类的 path 不同」，结果 15px 并排时仍有三个方框（终端、相机、
 * 文件夹）、三个一个圆（放大镜、时钟、灯泡）。同尺寸下能分辨的不是 path 差
 * 异，而是**外轮廓属于哪一族**，所以这里给每一族限定成员：
 *
 * - 无框粗线：执行（`>` 提示符）、检索（粗柄放大镜）、计划（台阶）、待办（清单）
 * - 实心点缀：写入（实心笔尖）、驱动界面（实心指针）
 * - 方框：截图（相机，顶部凸起 + 镜头圆）、列目录（文件夹，右侧 tab）、说明（气泡尾巴）
 * - 圆：定时（闹钟，顶部双铃）、思考（灯泡，底部灯座横线）
 * - 其它独有：读（摊开的书）、git（三圆分支）、联网（云 + 下箭头）、委派（两个人）、
 *   记忆（书签）、自省（星）、兜底（扳手）
 *
 * 每类还带一个 kind：调用方把它拼成 `glyph-<kind>` 的 class，样式表按动作上色
 * （执行=红、写入=琥珀、读取=蓝、检索=紫…）。形状负责「是哪一类」，颜色负责
 * 「这一行要不要留意」，两者叠在一起才做到一眼区分——只换形状、颜色全是灰的
 * 时候，缩小到 14px 的行高里几张小图标看起来仍然一样。
 */
export type ToolKind =
  | 'exec'
  | 'write'
  | 'read'
  | 'search'
  | 'list'
  | 'git'
  | 'net'
  | 'image'
  | 'drive'
  | 'delegate'
  | 'plan'
  | 'todo'
  | 'memory'
  | 'schedule'
  | 'evolve'
  | 'tool'

/** 全部动作类别，样式表要为每一个提供 `.glyph-<kind>` 配色。 */
export const TOOL_KINDS: readonly ToolKind[] = [
  'exec',
  'write',
  'read',
  'search',
  'list',
  'git',
  'net',
  'image',
  'drive',
  'delegate',
  'plan',
  'todo',
  'memory',
  'schedule',
  'evolve',
  'tool',
]

/**
 * 每一类动作举一个代表工具名：测试用它证明「每类确实归到自己」且「每类的
 * 图标形状互不相同」。加了新类别却没给样本，测试会直接失败。
 */
export const KIND_SAMPLES: Record<ToolKind, string> = {
  exec: 'run_shell',
  write: 'write_file',
  read: 'read_file',
  search: 'search_files',
  list: 'list_directory',
  git: 'git_status',
  net: 'fetch_url',
  image: 'screenshot',
  drive: 'app_control',
  delegate: 'subagent',
  plan: 'update_plan',
  todo: 'add_todo',
  memory: 'remember',
  schedule: 'schedule_task',
  evolve: 'propose_self_update',
  tool: 'mcp__github__create_issue',
}

/**
 * 这一列图标的画布。
 *
 * 尺寸 16 而不是 15：底块是 20–22px，留白从 3.5px 收到 3px 后 1.9px 的笔画才立
 * 得住。描边宽度不写死在这里——样式表的 `.tool-glyph svg` 统一给 1.9；个别笔画
 * 要更粗时用内联 style 覆盖，因为 CSS 规则会盖掉同名的 presentation 属性。
 */
function Glyph({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      /* 1.9 与样式表的 `.tool-glyph svg` 一致：直接渲染到容器外（测试、
         悬浮预览）时线宽不会退回默认的 1，形状一样立得住。 */
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/**
 * 执行：终端提示符 `>` 加一条光标线，**不画外框**。
 *
 * 上一版是「圆角矩形 + 里面的 > 和横线」。外框在 15px 下占满整个字形，里面的
 * 细节糊成一团，而且和相机、文件夹三个方框并排时轮廓完全一样。去掉框以后这一
 * 列只剩它、台阶、清单是纯折线，缩到 12px 也认得出是命令行。
 */
const PromptGlyph = (size: number) => (
  <Glyph size={size}>
    <path d="M4.4 7.4 9.3 12l-4.9 4.6" style={{ strokeWidth: 2.3 }} />
    <path d="M12.4 16.6h7.2" style={{ strokeWidth: 2.3 }} />
  </Glyph>
)

/**
 * 写入：铅笔，笔尖填成实心三角。
 *
 * 描边铅笔在 15px 下和「指针」「台阶」都是几根斜线；把最靠近纸面的笔尖涂实，
 * 一眼是「落笔」而不是「指向」。
 */
const PenGlyph = (size: number) => (
  <Glyph size={size}>
    <path d="M4.2 19.9l.9-4.2L16.1 4.6a2.2 2.2 0 0 1 3.1 3.1L8.1 18.9l-3.9 1Z" />
    <path d="M4.2 19.9 5.1 15.7 8.1 18.9Z" fill="currentColor" stroke="none" />
    <path d="M14.3 6.4l3.2 3.2" />
  </Glyph>
)

/**
 * 检索：放大镜，柄加粗。
 *
 * 圆 + 斜柄是这个动作的通用形状，风险不在自己身上，而在「这一列还有两个圆」：
 * 时钟和灯泡头。把柄做到 2.6px 后，它成了唯一带一根粗斜线的圆。
 */
const LensGlyph = (size: number) => (
  <Glyph size={size}>
    <circle cx="10.6" cy="10.6" r="6.3" />
    <path d="M15.4 15.4 20.3 20.3" style={{ strokeWidth: 2.6 }} />
  </Glyph>
)

/**
 * 联网：一朵云，里面一条向下的箭头。
 *
 * 上一版只有一朵云，表意停在「这是网络」；这一类工具真正在干的是**把外面的
 * 东西抓回来**（fetch_url / web_ / download / learning_research）。箭头让轮廓
 * 内部有结构，也不会像地球那样退化成一个圆。
 *
 * 形状直接用通用图标表里的 `CloudIcon`：侧栏与其他面板的「联网」与这一列必须
 * 是同一个图，否则同一件事在两处长得不一样。
 */

/**
 * 驱动界面：涂实的鼠标指针（与通用表 `CursorIcon` 同一个形状）。
 *
 * 这一类点的是屏幕上的控件，不是文件也不是命令。涂实是全表唯一的实心斜向箭头，
 * 不会和铅笔尖、台阶的描边斜线混为一族。
 */

/**
 * 定时：闹钟，顶部两只铃。
 *
 * 上一版是「圆 + 两根指针」，在 15px 下就是多画了两笔的放大镜。真正的时钟轮廓
 * 特色在铃和脚：顶上加两个短斜线之后，这一列里带缺口的圆只有它一个。
 * 形状直接用通用图标表里的 `ClockIcon`：侧栏「定时」、会话定时面板与这一列必须
 * 是同一个图，否则同一件事在两个位置长得不一样。
 */

const GLYPHS: Array<{ match: RegExp; kind: ToolKind; glyph: (size: number) => ReactNode }> = [
  {
    // 进程类工具也算“跑东西”：起进程、读进程输出、停进程都是终端里的动作。
    match:
      /^(run_command|run_shell|run_e2e|bash|powershell|shell|terminal|start_process|read_process_output|stop_process|list_processes)/,
    kind: 'exec',
    glyph: PromptGlyph,
  },
  {
    match:
      /^(write_file|apply_patch|edit_file|edit|str_replace|create_file|delete_file|rename|create_skill)/,
    kind: 'write',
    glyph: PenGlyph,
  },
  {
    // use_skill 是把一份技能文档读进上下文，本质仍是“读”。
    match: /^(read_file|read_many|get_file_info|use_skill|files?$)/,
    kind: 'read',
    glyph: (s) => <BookOpenIcon width={s} height={s} />,
  },
  {
    // code_intel 查的是定义与引用：还在“找东西”。
    match: /^(search_files|grep|find|glob|search|code_intel)/,
    kind: 'search',
    glyph: LensGlyph,
  },
  {
    match: /^(list_directory|list_files|tree|ls$|project_map)/,
    kind: 'list',
    glyph: (s) => <FolderIcon width={s} height={s} />,
  },
  { match: /^git_/, kind: 'git', glyph: (s) => <GitBranchIcon width={s} height={s} /> },
  {
    // learning_research 抓的是公开网页，和 fetch/web_ 同类。
    match: /^(web_|fetch|http|visit|browse|curl|download|upload|learning_research)/,
    kind: 'net',
    glyph: (s) => <CloudIcon width={s} height={s} />,
  },
  {
    match: /^(screenshot|capture|view_image|image|ocr)/,
    kind: 'image',
    // 相机而不是“带山的方框”：方框和终端撞轮廓。
    glyph: (s) => <CameraIcon width={s} height={s} />,
  },
  {
    // 操作界面上的控件：点、输、等界面状态。跟“读文件”“跑命令”都不同一类。
    match: /^(app_control|app_targets|list_windows|drive_)/,
    kind: 'drive',
    glyph: (s) => <CursorIcon width={s} height={s} />,
  },
  {
    match: /^(explore|subagent|delegate|agent)/,
    kind: 'delegate',
    glyph: (s) => <UsersIcon width={s} height={s} />,
  },
  {
    match: /^(update_plan|plan)/,
    kind: 'plan',
    glyph: (s) => <StepsIcon width={s} height={s} />,
  },
  { match: /^(add_todo|todo)/, kind: 'todo', glyph: (s) => <TodoIcon width={s} height={s} /> },
  {
    // learning_log 记的是“下次还记得”的结论，和 remember 同类。
    match: /^(remember|memory|learning_log)/,
    kind: 'memory',
    glyph: (s) => <BookmarkIcon width={s} height={s} />,
  },
  {
    match: /^(schedule_task|schedule|cron)/,
    kind: 'schedule',
    glyph: (s) => <ClockIcon width={s} height={s} />,
  },
  {
    match: /^(propose_self_update|evolve|skill|toolsmith)/,
    kind: 'evolve',
    glyph: (s) => <SparkIcon width={s} height={s} />,
  },
  {
    match: /^(mcp__|plugin|use_skill|run_tool)/,
    kind: 'tool',
    glyph: (s) => <WrenchIcon width={s} height={s} />,
  },
]

function entryFor(name: string) {
  const key = name.toLowerCase()
  return GLYPHS.find((entry) => entry.match.test(key))
}

/** 一个工具名 → 它属于哪一类动作。未知工具归 'tool'。 */
export function toolKind(name: string): ToolKind {
  return entryFor(name)?.kind ?? 'tool'
}

/** 一个工具名 → 它的图标。未知工具兜底为扳手。 */
export function toolGlyph(name: string, size = 16): ReactNode {
  const entry = entryFor(name)
  return entry ? entry.glyph(size) : <WrenchIcon width={size} height={size} />
}

/**
 * 非工具步骤的图标：思考是灯泡，过程中的说明文字是对话气泡。
 *
 * 这两类以前在折叠行上没有任何图标，只有一串「思考过程 / 说明」文字，
 * 和工具卡混在一起时看不出哪一行是模型在想、哪一行是它在解释。
 */
export function partGlyph(kind: 'reasoning' | 'note', size = 16): ReactNode {
  return kind === 'reasoning' ? (
    <LightbulbIcon width={size} height={size} />
  ) : (
    <MessageIcon width={size} height={size} />
  )
}

/** 非工具步骤的 kind，和工具的 kind 共用同一套 `glyph-<kind>` 上色规则。 */
export function partKind(kind: 'reasoning' | 'note'): 'think' | 'note' {
  return kind === 'reasoning' ? 'think' : 'note'
}
