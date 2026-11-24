/**
 * Protocol constants for the phone companion service.
 *
 * Kept out of `server.ts` so the service file only holds lifecycle, routing and
 * protocol flow. Values here bound the HTTP panel, the WebSocket protocol and
 * the encrypted relay frames, so a phone and the desktop always agree.
 */
import { BRIDGE_MAX_FRAME_BYTES } from '../../shared/bridge'
import { MAX_UPLOAD_CHUNK_BYTES } from '../workspace'

export const PROTOCOL_VERSION = 2
export const STATE_VERSION = 1
export const DEFAULT_PORT = 46_831
export const DEFAULT_APP_URL = 'https://pilot.medpilot.cc/app/'
// 独立安卓 App 的固定下载入口；配对二维码仍然指向网页版，避免把 #p 载荷
// 拼到 APK 链接上。App 内的「扫一扫」直接读取配对二维码。
export const APP_DOWNLOAD_URL = 'https://download.medpilot.cc/pilot/android/Pilot-latest.apk'
export const PAIRING_TTL_MS = 5 * 60_000
/**
 * 换机二维码由已配对的手机经 E2E 通道申请，扫码即视为持有一次性凭证，
 * 不再等待电脑端点击确认；有效期因此缩短，并且只能使用一次。
 */
export const TRANSFER_PAIRING_TTL_MS = 2 * 60_000
export const PAIRING_MAX_ATTEMPTS = 6
/** How long a scanned QR code waits for the desktop user to click 允许. */
export const PAIR_APPROVAL_TTL_MS = 60_000
/** Shown to a phone that scanned while another request is still unanswered. */
export const PAIR_BUSY_REASON = '电脑端正在确认另一个配对请求，请稍后重新扫码'
export const PAIR_EXPIRY_MS = 7 * 24 * 60 * 60_000
export const HEARTBEAT_MS = 25_000
export const SILENCE_MS = 75_000
// Mobile networks drop individual pongs; only a few misses in a row mean the
// socket is really gone. One missed pong used to kill healthy phone links.
export const HEARTBEAT_MISS_LIMIT = 3
export const CHALLENGE_TTL_MS = 15_000
/**
 * 一帧最多多少字节。浏览器里的桌面界面走 `/bridge`，上传附件时整批字节都
 * 在一帧里，所以这个数同时也是浏览器侧的单帧预算（`shared/bridge.ts`）。
 */
export const MAX_PAYLOAD = BRIDGE_MAX_FRAME_BYTES
export const MAX_MESSAGE_CHARS = 32_000
/**
 * A full report can contain 60 modules × 8 rules, and the encrypted relay
 * envelope is much smaller than a local socket frame. Keep the highest-ranked
 * risks and summarize the rest with counts; the desktop still holds the full
 * report for the fix session.
 */
export const PHONE_MODULE_RISK_LIMIT = 160
/**
 * 学习账本会随使用一直增长；手机只需要最近一段用于复盘，完整账本仍留在
 * 工作区。单条记录里的 URL、备注等也截断，避免一帧被长文本撑爆。
 */
export const PHONE_LEARNING_ENTRY_LIMIT = 60
export const PHONE_LEARNING_NOTE_LIMIT = 1_200
export const PHONE_LEARNING_URL_LIMIT = 600
export const PHONE_LEARNING_PATH_LIMIT = 300
export const PHONE_LEARNING_TITLE_LIMIT = 500
// Phone uploads are chunked over the encrypted relay. The phone sends 128 KB
// source chunks (about 175 KB as base64); the server accepts up to 256 KB
// decoded so a future client can grow chunks without a protocol bump.
export const UPLOAD_TTL_MS = 10 * 60_000
export const MAX_PENDING_UPLOADS = 4
export const MAX_UPLOAD_CHUNK_BASE64 = Math.ceil(MAX_UPLOAD_CHUNK_BYTES / 3) * 4 + 4
// 知识库一次最多回传的字符总量（含指令与回复），保证加密后仍远低于中继帧上限。
export const KNOWLEDGE_PAYLOAD_CHARS = 80_000
// 手机端「会话资源」预览同样按条数与字符预算裁剪：链接只回最近若干条，
// 工具描述截断且不回传 inputSchema，避免一帧被长文本撑爆。
export const PHONE_LINK_LIMIT = 60
export const PHONE_LINK_URL_CHARS = 2_000
export const PHONE_TOOL_LIMIT = 120
export const PHONE_TOOL_DESCRIPTION_CHARS = 320
// 手机端新建工作区：只接受单层目录名，由电脑端拼接到授权根目录里。
export const WORKSPACE_NAME_MAX = 64
export const WORKSPACE_NAME_INVALID = /[<>:"/\\|?*\u0000-\u001f\u007f]/
export const RESERVED_WORKSPACE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
export const LOOKUP_RE = /^[A-Za-z0-9_-]{22,128}$/
export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/
export const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{86}$/
