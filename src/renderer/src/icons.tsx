import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Base({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      /* 1.9 与执行过程那一列（components/process-icons.tsx 的 Glyph）同宽：
         14–16px 上 1.5px 的线只剩半个像素，缩成一片糊，两侧图标粗细也不一致。 */
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

export const PlusIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 5v14M5 12h14" />
  </Base>
)

/**
 * 会话 / 对话：两个错位的气泡。
 *
 * 单个气泡是「说明」（MessageIcon）和「反馈」（FeedbackIcon）的形状，三者并排时
 * 轮廓相同；两个气泡一个压一个，是「一来一回」，缩到 14px 也只剩这一种剪影。
 */
export const ChatIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M14.4 3.6a6.6 6.6 0 0 1 6.4 6.6 6.4 6.4 0 0 1-.9 3.3l.8 4.1-4.3-.9" />
    <path d="M9.2 8.6a5.6 5.6 0 0 0-5.6 8.4L2.8 21l4-1.1a5.6 5.6 0 0 0 8.2-4.6 5.6 5.6 0 0 0-5.8-6.7Z" />
  </Base>
)

/**
 * 反馈：一个信封，封口是一道向下折的 V。
 *
 * 侧栏「反馈」以前是气泡里一个感叹号，在 13–15px 上和「说明」（气泡 + 两行）、
 * 「会话」（两个错位气泡）属于同一族，三个气泡并排只能靠内部小字分辨。信封是整张
 * 表里唯一的矩形 + 对角折线剪影，语义也直接：给维护者写一封信。
 */
export const FeedbackIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2.4" />
    <path d="m4.4 6.6 7.6 6 7.6-6" />
  </Base>
)

/** 顶栏通知中心的小铃铛：有未读提醒或待审批调用时亮。 */
export const BellIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
    <path d="M13.7 19a2 2 0 0 1-3.4 0" />
  </Base>
)

export const FolderIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </Base>
)

/**
 * 插件：插头。
 *
 * 插件入口以前借用 LayersIcon（三层菱形），那是「上下文的层」与「创建副本」也在
 * 用的形状，扫一眼分不出；拼图块在 15px 上只剩一个带缺口的小方块，又和九宫格
 * （QrIcon）、表格（TableIcon）撞。插头「两根针 + 上宽下窄的身子 + 一根线」是整张
 * 表里唯一的这种剪影，也正是 plug-in 的本义。
 */
export const PlugIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M9.2 3.2v4.6M14.8 3.2v4.6" />
    <path d="M6.4 7.8h11.2v3.4a5.6 5.6 0 0 1-11.2 0V7.8Z" />
    <path d="M12 16.8V20.6" />
  </Base>
)

/**
 * 模型 / 智能：芯片，不是大脑。
 *
 * 脑轮廓由七八段弧组成，14px 上是一坨墨点，和「记忆」的书签、「自省」的闪光都
 * 分不开。芯片是方框加八根引脚，外轮廓在通用图标里独一无二（没有任何折角与弧线）。
 * 用于记忆库、进化、模型设置这些「跟模型本身有关」的入口。
 */
export const BrainIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="7" y="7" width="10" height="10" rx="2.2" />
    <path d="M10 3.4V7M14 3.4V7M10 17v3.6M14 17v3.6M3.4 10H7M3.4 14H7M17 10h3.6M17 14h3.6" />
  </Base>
)

export const SparkIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18.2l-1.8-5.6L4.7 10.8 10.2 9 12 3.5Z" />
    <path d="M19 16.5l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z" />
  </Base>
)

export const WrenchIcon = (props: IconProps) => (
  <Base {...props}>
    {/* 开口扳手：头部一个 C 形开口 + 长柄斜向左下。上一版是「头部一个尖 + 柄」
        的简化路径，22px 上读成一把刀；开口是扳手唯一的识别点。 */}
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z" />
  </Base>
)

/**
 * 设置：三根滑杆，把手错开。
 *
 * 上一版是齿轮（双环 + 八根齿）。它和太阳（圆 + 八根射线）在 20px 上几乎同形，
 * 而主题切换的太阳就在它旁边；再往下是一组向内放射的刻度，那又和时钟撞。所有
 * 「带放射线的圆」都绕不开这三者，所以改成语义完全不同的滑杆：三根横线 + 三个
 * 错位的把手，整个图标表里这是唯一的「多条平行横线 + 实心点」剪影。
 */
export const SettingsIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3.4 6.6h17.2M3.4 12h17.2M3.4 17.4h17.2" />
    <circle cx="15.4" cy="6.6" r="2.3" fill="currentColor" stroke="none" />
    <circle cx="8.4" cy="12" r="2.3" fill="currentColor" stroke="none" />
    <circle cx="16.4" cy="17.4" r="2.3" fill="currentColor" stroke="none" />
  </Base>
)

export const SendIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M22 2 11 13" />
    <path d="m22 2-7 20-4-9-9-4 20-7Z" />
  </Base>
)

export const StopIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Base>
)

export const PauseIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M9.5 5.5v13M14.5 5.5v13" strokeWidth="2.2" />
  </Base>
)

export const PlayIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M8 5.2v13.6L18.5 12 8 5.2Z" fill="currentColor" stroke="none" />
  </Base>
)

/**
 * 清单 / 自检：方框里一个勾。
 *
 * 以前和 TodoIcon 是同一张「三行勾选」，两者同时出现在侧栏与计划头部时分不出来。
 * 这里改成「一张被核过的表」——方框 + 一个勾，与待办的「三行带圈」不再是同族。
 */
export const ListCheckIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.6" />
    <path d="m7.8 12.2 2.8 2.8 5.6-5.9" />
  </Base>
)

/**
 * 执行计划：一段向右上走的台阶。
 *
 * 以前计划与待办共用「清单打勾」，两者在同一列里完全分不出来；台阶是
 * 「一步一步往前」的形状，和勾选框没有任何共同轮廓。
 */
export const StepsIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 20h5v-5h5v-5h4V5h4" />
  </Base>
)

export const ChevronIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="m9 6 6 6-6 6" />
  </Base>
)

export const ChevronDownIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="m6 9 6 6 6-6" />
  </Base>
)

export const DiffIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3.6v16.8" />
    <path d="M6 7.4v4.2M3.9 9.5h4.2" />
    <path d="M18 7.4v4.2M15.9 9.5h4.2" />
    <path d="M3.9 17.4h4.2M15.9 17.4h4.2" />
  </Base>
)

export const TrashIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6" />
  </Base>
)

export const CopyIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="9.4" y="9.4" width="10.4" height="10.4" rx="2" />
    <path d="M6.2 14.6H5.4a1.6 1.6 0 0 1-1.6-1.6V5.4a1.6 1.6 0 0 1 1.6-1.6h7.6a1.6 1.6 0 0 1 1.6 1.6v.8" />
  </Base>
)

export const CheckIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="m4 12 5 5L20 6" />
  </Base>
)

export const XIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Base>
)

/**
 * 文档（多份）：两张叠在一起的折角纸。
 *
 * 单个附件（FileIcon）只有一张；这里后面透出第二张纸的左边与底边——两张叠纸的
 * 前边比折角纸多一段外轮廓，14px 下也能和「复制」（两个方框）「文件夹」分开。
 */
export const FilesIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M8.6 2.8h5.2l4 4v7.8a1.5 1.5 0 0 1-1.5 1.5H8.6a1.5 1.5 0 0 1-1.5-1.5V4.3a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M13.8 2.8v4h4" />
    <path d="M4.6 6.4v11.3a1.5 1.5 0 0 0 1.5 1.5h8.3" />
  </Base>
)

/**
 * 读文件：摊开的书。
 *
 * 折角纸张（FilesIcon）在 14–15px 上只剩一个信封轮廓，和「文件夹」「图片」
 * 挤在同一列里分不出来；摊开的书有左右两页、一条中缝，扫一眼就知道是「读」。
 */
export const BookOpenIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 6.4C10.5 5.3 8.6 4.8 6.4 4.8H4v13h2.4c2.2 0 4.1.5 5.6 1.6 1.5-1.1 3.4-1.6 5.6-1.6H20v-13h-2.4c-2.2 0-4.1.5-5.6 1.6Z" />
    <path d="M12 6.4v13" />
  </Base>
)

/**
 * 思考过程：灯泡。
 *
 * 大脑轮廓由七八段弧线组成，缩到 15px 就是一坨墨点；灯泡只有一个圆头加两根
 * 底座线，形状在整个执行过程列里独一无二，也不会和「说明」的气泡混淆。
 */
export const LightbulbIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3a6 6 0 0 0-3.6 10.8V16h7.2v-2.2A6 6 0 0 0 12 3Z" />
    <path d="M9.8 18.6h4.4" />
  </Base>
)

/**
 * git 操作：分支曲线。
 *
 * 原来复用 diff 的「+ / −」，那是「看差异」不是「跑 git」；三个提交点加一条
 * 分叉线是 git 的通用形状，和终端、铅笔都不同。
 */
export const GitBranchIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="7" cy="6" r="2.2" />
    <circle cx="7" cy="18" r="2.2" />
    <circle cx="17" cy="8.4" r="2.2" />
    <path d="M7 8.2v7.6M17 10.6c0 3.4-2.7 4.7-5.6 5.6" />
  </Base>
)

/** 写改文件：铅笔，笔尖涂实。与执行过程里的写入图标同形（落笔，而不是指向）。 */
export const PencilIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4.2 19.9l.9-4.2L16.1 4.6a2.2 2.2 0 0 1 3.1 3.1L8.1 18.9l-3.9 1Z" />
    <path d="M4.2 19.9 5.1 15.7 8.1 18.9Z" fill="currentColor" stroke="none" />
    <path d="M14.3 6.4l3.2 3.2" />
  </Base>
)

/** 记住一条事实：书签。 */
export const BookmarkIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M6 3h12v18l-6-4.5L6 21V3Z" />
  </Base>
)

/** 派给子代理 / 委派给另一个执行者：两个人。 */
export const UsersIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M17.5 14.6A5.5 5.5 0 0 1 20.5 20" />
  </Base>
)

/** 执行过程中的一段说明文字：对话气泡。 */
export const MessageIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4 5h16v11H9l-5 4V5Z" />
    <path d="M8 9h8M8 12.5h5" />
  </Base>
)

export const ThumbUpIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3Z" />
    <path d="M7 10l4-7a2 2 0 0 1 3 2l-1 5h5a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 16.7 21H7" />
  </Base>
)

export const ThumbDownIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M7 14V3H4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h3Z" />
    <path d="M7 14l4 7a2 2 0 0 0 3-2l-1-5h5a2 2 0 0 0 2-2.3l-1.3-7A2 2 0 0 0 16.7 3H7" />
  </Base>
)

/**
 * 终端 / 命令行：窗口栏 + 提示符。
 *
 * 执行过程那一列的命令图标是「无框的 >」（去掉框才能在 12px 上立住）；这里是
 * 按钮和面板标题的图标，保留一个窗口外框反而能说清「这是一整块终端」，
 * 但顶部加一条窗栏横线，与相机（顶部凸起）、图片（山与太阳）两个方框分开。
 */
export const TerminalIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2.4" />
    <path d="M3 8.2h18" />
    <path d="m7.4 12 2.6 2.6-2.6 2.6M13 17.2h3.8" />
  </Base>
)

/**
 * 搜索 / 查找：放大镜，柄加粗到 2.6。
 * 这是整张图标表里唯一带粗斜线的圆；和时钟（圆 + 刻度）、地球（圆 + 经线）并排
 * 时靠那根粗柄分开。与执行过程的检索图标同形。
 */
export const SearchIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="10.6" cy="10.6" r="6.3" />
    <path d="M15.4 15.4 20.3 20.3" strokeWidth="2.6" />
  </Base>
)

/**
 * 图片：画框 + 山峰 + 太阳。
 * 与相机（顶部凸起 + 圆镜头）不是一个轮廓；放在输入框旁边时表示「插入一张图」。
 */
export const ImageIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="4.4" width="18" height="15.2" rx="2.4" />
    <circle cx="8.6" cy="9.6" r="1.6" />
    <path d="m3.6 17.4 4.9-4.9 3.4 3.4 3.4-3.4 5.1 5.1" />
  </Base>
)

export const FileIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M13.8 3.2H6.4A1.8 1.8 0 0 0 4.6 5v14a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8V8.4Z" />
    <path d="M13.8 3.2v5.2h5.6" />
  </Base>
)

/**
 * 表格：方框 + 表头线与一竖一横的网格。
 *
 * 以前电子表格借用 LayersIcon（三层菱形），那是「堆叠」不是「一张表」；文档预览
 * 里 PDF 是纸、Excel 是表、PPT 是演示屏，三种形状一眼分得开。
 */
export const TableIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="2.2" />
    <path d="M3.2 9.4h17.6M9.4 9.4v10M15.2 9.4v10M3.2 14.4h17.6" />
  </Base>
)

/** 演示文稿：演示屏 + 中央播放三角。和播放按钮（只有三角）靠外框分开。 */
export const SlidesIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3.2" y="4.4" width="17.6" height="12.4" rx="2.2" />
    <path d="m10.4 8.6 4.4 2.2-4.4 2.2V8.6Z" />
    <path d="M12 16.8v3M9 20h6" />
  </Base>
)

/**
 * 截图 / 看图：相机。
 *
 * 以前这里用的是「带山和太阳的方框」，和终端一样是个矩形，14px 并排时分不出
 * 哪一行是跑命令、哪一行是截了屏。相机顶部有凸起的取景器、中间一个圆镜头，
 * 轮廓与任何方框类图标都不同。
 */
export const CameraIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M2.6 8.4a1.6 1.6 0 0 1 1.6-1.6h2.3l1.4-2.3h8.2l1.4 2.3h2.3a1.6 1.6 0 0 1 1.6 1.6v9.6a1.6 1.6 0 0 1-1.6 1.6H4.2a1.6 1.6 0 0 1-1.6-1.6Z" />
    <circle cx="12" cy="13.2" r="3.3" />
  </Base>
)

/**
 * 驱动界面：鼠标指针。
 *
 * app_control / drive_run 这类工具既不跑命令也不读文件，它们点的是屏幕上的
 * 控件。指针是整个图标集里唯一的斜向三角轮廓，扫一眼就能认出「这一步在操作
 * 应用」，不会跟终端、文件夹、图片混在一起。三角涂实 + 左下那半圈波纹，与执行
 * 过程里 drive 那一类（`process-icons.tsx` 的 PointerGlyph）同形：描边三角在
 * 14px 下和铅笔尖、台阶是同一族斜线。
 */
export const CursorIcon = (props: IconProps) => (
  <Base {...props}>
    <path
      d="M6 3.4 18.4 11l-5.5 1.2 2.6 5.9-2.4 1.1-2.6-5.9-3.5 3.4Z"
      fill="currentColor"
      stroke="none"
    />
    <path d="M3.4 18.9a7 7 0 0 1-.9-3.4" />
  </Base>
)

export const RefreshIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </Base>
)

export const InfoIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Base>
)

export const ArrowUpRightIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M7 17 17 7M7 7h10v10" />
  </Base>
)

/** 待办：三行清单，前两行打勾、第三行仍是圈，一眼看出"还有没做＂。 */
export const TodoIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M10 6h10M10 12h10M10 18h10" />
    <path d="M4 6l1.5 1.5L8 5" />
    <path d="M4 12l1.5 1.5L8 11" />
    <circle cx="5.6" cy="18" r="1.6" />
  </Base>
)

/** 弹窗：外框 + 从框内指向右上的箭头，用来表示「在独立窗口打开」。 */
export const PopoutIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M11 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6" />
    <path d="M14 3h7v7M21 3l-9 9" />
  </Base>
)

/**
 * 顶栏「全屏」：两条对角箭头朝外（右上 / 左下）。
 *
 * 上一版是四角回折的 L 形，而旁边那个「退出全屏」也是四角回折的 L 形，只差拐点
 * 在内侧还是外侧，13px 下两个图标几乎一样。改成斜向双箭头后，一个「向外张」、
 * 一个「四角内收」，两种剪影完全不同族。
 */
export const ExpandIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M14.4 9.6 20.4 3.6" />
    <path d="M15.2 3.6h5.2v5.2" />
    <path d="M9.6 14.4 3.6 20.4" />
    <path d="M8.8 20.4H3.6v-5.2" />
  </Base>
)

/** 全屏中的反向状态：四个角朝内，表示「退出全屏」。 */
export const CollapseIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5" />
  </Base>
)

/**
 * 定时 / 等待 / 耗时：闹钟，顶部两只铃、底部两条腿。
 *
 * 上一版是「圆 + 两根指针 + 四向刻度」，在 14–16px 上和太阳（圆 + 八根射线）、
 * 放大镜（圆 + 斜柄）、历史（圆 + 箭头）挤在同一族里，靠数笔画分不出来。铃和腿
 * 是这一族里唯一的斜线缺口，扫一眼就知道是「定时」。形状与执行过程里 schedule
 * 那一类同源：`components/process-icons.tsx` 直接复用这个组件，不再各画一份。
 */
export const ClockIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="13.2" r="6.6" />
    <path d="M12 9.7v3.8l2.6 1.5" />
    <path d="M5.3 4.7 3.5 6.7M18.7 4.7l1.8 2" />
    <path d="M8.8 19.2 7.4 21M15.2 19.2l1.4 1.8" />
  </Base>
)

export const HistoryIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3.6 12a8.4 8.4 0 1 0 2.7-6.2L3.6 8.3" />
    <path d="M3.4 3.6v4.9h4.9" />
    <path d="M12 7.6V12l3.1 1.9" />
  </Base>
)

export const LayersIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="m12 2 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
  </Base>
)

/** 顶栏「更多操作」：三个点，表示还有一层菜单。 */
export const MoreIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
  </Base>
)

export const MenuIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Base>
)

export const SunIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Base>
)

export const MoonIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Base>
)

export const PhoneIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.6" />
    <path d="M10.5 5.5h3" />
    <circle cx="12" cy="18" r="0.9" fill="currentColor" stroke="none" />
  </Base>
)

export const GlobeIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.6 2.4 4 5.6 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.6-4-9s1.4-6.6 4-9Z" />
  </Base>
)

/**
 * 联网取回内容：一朵云，里面一条向下的箭头。
 *
 * 这一格以前是地球（圆 + 经线），和放大镜（圆 + 柄）、时钟（圆 + 指针）在
 * 14px 行高里都是「一个圆」，并排出现时靠轮廓分不开。云的上缘是两个圆弧，
 * 与那三个圆形一眼能区分，箭头又直接说明「把远端的东西取回来」。
 *
 * 云的轮廓取闭合块（不是两侧开口的弧）：开口版在 14px 下会散成两段，并与
 * 「自省」的星、「记忆」的书签一起显得稀。这个形状同时是执行过程里 net 那一类
 * 的唯一来源（`components/process-icons.tsx` 直接渲染它，不再各画一份）。
 */
export const CloudIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M6.9 16.5h10.3a3.5 3.5 0 0 0 .2-7 5.3 5.3 0 0 0-10.1-1A3.5 3.5 0 0 0 6.9 16.5Z" />
    <path d="M12 9.4v6.2" />
    <path d="M9.7 13.4 12 15.7l2.3-2.3" />
  </Base>
)

export const QrIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
    <path d="M14 14h2v2h-2zM18 14h2v6h-2zM14 18h2v2h-2z" />
  </Base>
)

export const LinkIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M10 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.4 6.4" />
    <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.2-1.2" />
  </Base>
)

export const DownloadIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3v11" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 18v2.5h16V18" />
  </Base>
)

export const UpdateIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3a9 9 0 1 1-8.5 6" />
    <path d="M3 3v6h6" />
    <path d="m9 12 2 2 4-4" />
  </Base>
)

/**
 * 正体圆角 P：圆角矩形竖笔、平顶/平底横笔与右半圆外轮廓，竖笔和半圆
 * 之间留出完整内孔。与 scripts/brand-icon.mjs 的 SQUARE_P_PATH 同源。
 */
const PILOT_P_PATH =
  'M22.5 15H23.5A3.5 3.5 0 0 1 27 18.5V45.5A3.5 3.5 0 0 1 23.5 49H22.5A3.5 3.5 0 0 1 19 45.5V18.5A3.5 3.5 0 0 1 22.5 15Z' +
  'M22.5 15H33V23H22.5A3.5 3.5 0 0 1 19 19.5V18.5A3.5 3.5 0 0 1 22.5 15Z' +
  'M22.5 31H33V39H22.5A3.5 3.5 0 0 1 19 35.5V34.5A3.5 3.5 0 0 1 22.5 31Z' +
  'M33 15A12 12 0 0 1 33 39L33 31A4 4 0 0 0 33 23Z'

export const PilotMark = (props: IconProps) => (
  <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
    <path d={PILOT_P_PATH} fill="currentColor" />
  </svg>
)

/** Color version of the Pilot mark, matching the application icon. */
export const PilotLogo = (props: IconProps) => (
  <svg viewBox="0 0 64 64" aria-hidden="true" {...props}>
    <rect x="2" y="2" width="60" height="60" rx="14.5" fill="#101c2d" />
    <path d={PILOT_P_PATH} fill="#ffffff" />
    <circle cx="47.5" cy="47.5" r="5.5" fill="#4ade80" />
  </svg>
)
