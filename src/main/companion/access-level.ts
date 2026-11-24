/**
 * 访问级别：这条连接背后是谁。
 *
 * 四档不是按「远近」分，而是按**这道门是被谁打开的**分：
 *
 * - `local`   回环直连（127.0.0.1 / ::1）：正坐在这台电脑前的人。
 * - `paired`  扫二维码配对成功的设备：有人在这台电脑上出示并批准过凭据，
 *             视为本机用户的另一块屏幕（手机 PWA、换机）。功能不降级。
 * - `host`    直接打开网址申请访问、并在本机审批时被指定为「主机用户」的浏览器：
 *             功能与数据都和本机一致，相当于这台电脑的另一个界面。
 * - `client`  同样直连、但被指定为「客户机用户」的浏览器：独立身份、独立数据，
 *             不给任何能改本机软件/凭据/设置/花钱的入口。
 *
 * 判定不看手机自报的名字：中继连接由本机出站建立、`address` 为空，
 * 若按 socket 地址判断会把远端误认成本机，所以必须同时要求 `via === 'lan'`。
 */
import { isLoopbackAddress } from './handlers/access'

export type AccessLevel = 'local' | 'paired' | 'host' | 'client'

/** 能改这台电脑本身的人：本机、扫码配对的本机手机，以及被批准为主机用户的远端。 */
export function canManageHost(access: AccessLevel): boolean {
  return access !== 'client'
}

export function accessLevelOf(origin: {
  via: 'lan' | 'relay' | 'local'
  address: string | null
  /** 这份凭据是怎么来的：扫码配对，或浏览器直连申请。 */
  credential?: 'qr' | 'browser' | undefined
  /** 浏览器直连时，本机审批页给它指定的身份。 */
  role?: 'host' | 'client' | undefined
}): AccessLevel {
  if (origin.via !== 'relay' && isLoopbackAddress(origin.address)) return 'local'
  // 旧记录没有这个字段，按扫码配对处理，避免老用户手机丢了功能。
  if (origin.credential !== 'browser') return 'paired'
  return origin.role === 'host' ? 'host' : 'client'
}

/** 这条请求该用哪一套数据：只有客户机用户独立，其余都与主机一致。 */
export function roleOfAccess(access: AccessLevel): 'host' | 'client' {
  return access === 'client' ? 'client' : 'host'
}

/**
 * 本机专属：这些操作改变的是「这台电脑上的软件、凭据、设置或开销」，
 * 客户机用户既看不到入口，也拿不到协议层的能力——直接调用也会被拒绝。
 *（主机用户等同本机，这些操作对它不设限。）
 *
 * 划分标准只有一条：**动这台电脑本身 → 本机专属；动工作内容 → 可用**。
 * 例如同样在工作区里，`workspaces.list` 让远端看到有哪些项目，
 * 而 `workspaces.browse` 会枚举整块磁盘的目录树，只给本机。
 */
export const LOCAL_ONLY_PREFIXES: readonly string[] = [
  // 让这台电脑下载并安装任意版本，等于把代码执行权交出去。
  'update.',
  // 改写自己的提示词、策略、人格。
  'evolution.',
  // 反思配置里有 SMTP 凭据，`reflect.now` 还会立刻消耗一轮模型调用。
  'reflect.',
  // 模块自检能扫本机源码树，`moduleCheck.accept(selfModify)` 会直接改源码。
  'moduleCheck.',
]

/** 挂载本机目录、写长期记忆、改全局设置：单条功能，不按前缀放行。 */
export const LOCAL_ONLY_METHODS: ReadonlySet<string> = new Set([
  // 生成换机二维码＝再发一份可用的配对凭据。
  'pairing.transfer',
  // 内视：读本机环境、记录与策略。
  'selfCheck.run',
  // 磁盘、内存、进程目录。
  'system.info',
  // 余额与本机用量。
  'billing.get',
  // 枚举本机整块磁盘，以及把任意本机路径挂成工作区。
  'workspaces.browse',
  'workspaces.create',
  'workspaces.open',
  'workspaces.remove',
  // 改本机模型/评审模型：会改变所有会话的成本与行为。
  'models.update',
  // 写进本机提示词的长期记忆。
  'memory.add',
  'memory.remove',
  // 改全局学习白名单（会进入提示词）与全局快捷命令。
  'learning.settings',
  'quickCommands.save',
  // 把本会话剩下的所有操作改成自动批准：等于替本机把安全门槛降到零，
  // 只能由坐在电脑前的人决定。单次批准见 canApproveRisk。
  'approval.allowSession',
  // 同上：改用「全部自动」只是换一条路径降低门槛，效果与 allowSession 相同。
  'sessions.approvalMode',
  // 定时任务会在没人看着的时候，按点让这台电脑自己跑 agent——
  // 这是「未来自动执行」，不是当前这一轮的工作内容。只读列表仍然开放。
  'schedules.add',
  'schedules.update',
  'schedules.remove',
])

export function isLocalOnlyMethod(method: string): boolean {
  if (!method) return false
  if (LOCAL_ONLY_METHODS.has(method)) return true
  return LOCAL_ONLY_PREFIXES.some((prefix) => method.startsWith(prefix))
}

/** 远端访问拿到这个错误，前端据此显示「请在电脑上操作」。 */
export const LOCAL_ONLY_ERROR = '该功能只能在这台电脑上使用'

/**
 * 一条待批的工具调用能不能由这个访问级别的人放行。
 *
 * 只按风险分档，不按工具名：`run`/`exec` 类（shell、命令、起进程）批一次就等于
 * 把这台电脑的命令行交出去，客户机用户只能拒绝或等电脑前的人处理。
 * 读与写留在工作区 jail 内，交给远端批是安全的——否则远端连一个任务都跑不完。
 */
export function canApproveRisk(access: AccessLevel, risk: string | undefined): boolean {
  if (canManageHost(access)) return true
  return risk !== 'exec'
}

/** 远端批准命令类调用时拿到的错误。 */
export const APPROVAL_EXEC_LOCAL_ONLY_ERROR =
  '这条命令需要在这台电脑上批准；你可以拒绝，或等电脑前的人处理'

/** 客户机用户申请到身份、但这台电脑还没给它准备独立数据面时的错误。 */
export const CLIENT_NO_SPACE_ERROR =
  '这台电脑还没有准备好客户机用户的独立空间，请让电脑前的人重新允许一次或升级后重试'
