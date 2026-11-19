import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Base({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
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

export const ChatIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 8.6 8.6 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
  </Base>
)

export const FeedbackIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M21 12a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7Z" />
    <path d="M12 7v4M12 14h.01" />
  </Base>
)

/** 质量闸门的小铃铛：只有存在待裁决的更优版本时才亮。 */
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

export const BrainIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M9.5 4.5A2.5 2.5 0 0 0 7 7v.2A3 3 0 0 0 5.5 13a3 3 0 0 0 1.8 4.8A2.7 2.7 0 0 0 10 21a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2.5-2Z" />
    <path d="M14.5 4.5A2.5 2.5 0 0 1 17 7v.2a3 3 0 0 1 1.5 5.8 3 3 0 0 1-1.8 4.8A2.7 2.7 0 0 1 14 21a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2.5-2Z" />
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
    <path d="M14.7 6.3a4 4 0 0 0-5.2 5.2L4 17v3h3l5.5-5.5a4 4 0 0 0 5.2-5.2l-2.4 2.4-2.8-2.8 2.2-2.6Z" />
  </Base>
)

export const SettingsIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
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

export const ListCheckIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4 6.5 5.5 8 8 5" />
    <path d="M4 12.5 5.5 14 8 11" />
    <path d="M4 18.5 5.5 20 8 17" />
    <path d="M11 7h9M11 13h9M11 19h9" />
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
    <path d="M6 4v12M3 7h6M3 13h6" />
    <path d="M18 20V8M15 11h6M15 17h6" />
  </Base>
)

export const TrashIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6" />
  </Base>
)

export const CopyIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
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

export const FilesIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6M9 13h6M9 17h6" />
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

export const TerminalIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </Base>
)

export const SearchIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Base>
)

export const ImageIcon = (props: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    width={props.width ?? 16}
    height={props.height ?? 16}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={props.className}
  >
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="m21 15-4.5-4.5L7 20" />
  </svg>
)

export const FileIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
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

export const ClockIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Base>
)

export const HistoryIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </Base>
)

export const LayersIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="m12 2 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
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
