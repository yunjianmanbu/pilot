// 结束一条命令的进程树时，不能连带关掉用户自己开着的 Office 窗口。
//
// Windows 上 `taskkill /pid X /T /F` 会沿父子关系把整棵树强杀。用户让 Pilot
// 写一份 Word 时，命令里常常是 `start winword.exe ...` 或 PowerShell 的 COM
// 调用；GUI 程序不会自己退出，这条命令必然撞上超时，于是 `/T` 把命令树里的
// `WINWORD.EXE` 一起 `/F` 掉——用户正开着的其它文档被强制关闭，模型重试一次
// 就再关一次，看起来就是「不停关闭重新打开」。
//
// 所以杀掉之前先取一张 `pid → 父 pid / 进程名` 的快照，把用户级 GUI 应用
// （连同它们的子孙）从待杀列表里摘出去。
//
// 两条硬规则（实测得来，别再退回去）：
// 1. **任何路径都不发 `taskkill /T`**。取不到快照时只单杀根进程：宁可留下
//    几个孤儿进程，也不能因为「没有证据」就把用户的 Word 一起关掉。
// 2. 根进程先单杀。取一张快照在本机要 1.7–2.0s（PowerShell 启动 0.7s + WMI
//    全表 1.1s），先杀根可以让管道立刻关闭、工具调用当轮就收敛，子孙交给随后
//    到达的快照清理。
import { execFile, spawn } from 'node:child_process'

export interface ProcessNode {
  pid: number
  parentPid: number
  /** Process name as Task Manager shows it, e.g. `WINWORD.EXE`. */
  name: string
}

/**
 * 交互式应用：它们由用户打开、承载未保存的文档，命令超时不该由它们陪葬。
 * 只列办公室套件——编辑器、终端、浏览器里本来就有用户自己的进程，让用户
 * 决定是否结束；这些条目在任务树里出现通常就意味着「这条命令把文档打开了」。
 */
export const PROTECTED_APP_NAMES: readonly string[] = [
  'winword.exe',
  'excel.exe',
  'powerpnt.exe',
  'outlook.exe',
  'onenote.exe',
  'msaccess.exe',
  'visio.exe',
  'mspub.exe',
  'wps.exe',
  'et.exe',
  'wpp.exe',
  'wpspdf.exe',
  'acrord32.exe',
  'acrobat.exe',
]

/** 快照里能落到 stdout 的最大字节数；一张 500 进程的表约 20KB。 */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

/**
 * 取快照的等待上限。本机实测一张 460 行的全表要 1.7–2.0s，原来的 1.5s 几乎
 * 必然超时——超时又回退到 `taskkill /T /F`，等于这个保护从来没生效过。
 */
const SNAPSHOT_TIMEOUT_MS = 3_500

/** 同一时刻只跑一条快照：几条命令一起超时时不必各起一个 PowerShell（各 2s）。 */
let snapshotInFlight: Promise<ProcessNode[] | null> | null = null

/** 刚落定的快照还能用：1s 内的进程树对「这条命令有哪些子孙」没有区别。 */
let snapshotCache: { at: number; nodes: ProcessNode[] } | null = null

/**
 * 解析 `pid,parentPid,name` 三列（每行一条）。PowerShell 的 CSV 输出带表头，
 * 也有可能是空 stdout；两种都只返回能解析的行。
 */
export function parseProcessList(stdout: string): ProcessNode[] {
  const nodes: ProcessNode[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const cells = line.split(',')
    if (cells.length < 3) continue
    const pid = Number(cells[0])
    const parentPid = Number(cells[1])
    const name = cells.slice(2).join(',').trim()
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!Number.isInteger(parentPid) || parentPid < 0) continue
    if (!name) continue
    nodes.push({ pid, parentPid, name })
  }
  return nodes
}

/**
 * 从 `rootPid` 往下找子孙，剔除受保护应用（及其子孙），返回真正要杀的 pid。
 *
 * 根进程自己永远在待杀列表里：它就是这条命令，即使它本身就是 `winword.exe`
 * （用户明确跑了这条命令）也要能收敛，否则工具调用会一直挂着。
 */
export function selectKillTargets(
  rootPid: number,
  nodes: readonly ProcessNode[],
  protectedNames: ReadonlySet<string> = new Set(
    PROTECTED_APP_NAMES.map((name) => name.toLowerCase()),
  ),
): { kill: number[]; spared: ProcessNode[] } {
  const childrenOf = new Map<number, ProcessNode[]>()
  for (const node of nodes) {
    const list = childrenOf.get(node.parentPid)
    if (list) list.push(node)
    else childrenOf.set(node.parentPid, [node])
  }

  const byPid = new Map<number, ProcessNode>()
  for (const node of nodes) byPid.set(node.pid, node)

  const kill: number[] = []
  const spared: ProcessNode[] = []
  const seen = new Set<number>()

  const walk = (pid: number, isRoot: boolean): void => {
    if (seen.has(pid)) return
    seen.add(pid)
    if (!isRoot) {
      const node = byPid.get(pid)
      if (node && protectedNames.has(node.name.toLowerCase())) {
        spared.push(node)
        return
      }
    }
    // 叶子先杀：父进程先没了，管道会提前关闭，子进程可能来不及响应。
    for (const child of childrenOf.get(pid) ?? []) walk(child.pid, false)
    kill.push(pid)
  }

  walk(rootPid, true)
  return { kill, spared }
}

/**
 * 读一张系统进程快照。拿不到时返回 `null`（没有 PowerShell、WMI 不可用、
 * 机器太忙），调用方据此只杀根进程。
 */
export function snapshotProcesses(): Promise<ProcessNode[] | null> {
  if (snapshotInFlight) return snapshotInFlight
  if (snapshotCache && Date.now() - snapshotCache.at < 1_000) {
    return Promise.resolve(snapshotCache.nodes)
  }
  const pending = readSnapshot()
  snapshotInFlight = pending
  return pending.then((nodes) => {
    snapshotInFlight = null
    if (nodes) snapshotCache = { at: Date.now(), nodes }
    return nodes
  })
}

function readSnapshot(): Promise<ProcessNode[] | null> {
  return new Promise((resolve) => {
    const script =
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }'
    let finished = false
    const finish = (value: ProcessNode[] | null): void => {
      if (finished) return
      finished = true
      resolve(value)
    }
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: MAX_SNAPSHOT_BYTES },
        (error, stdout) => {
          if (error) {
            finish(null)
            return
          }
          const nodes = parseProcessList(String(stdout ?? ''))
          finish(nodes.length > 0 ? nodes : null)
        },
      )
    } catch {
      finish(null)
      return
    }
    child.on('error', () => finish(null))
  })
}

/**
 * 一条命令的结束计划：第一批永远是「只杀根」（不带 `/T`），后面几批是按快照
 * 算出来的子孙（已摘掉受保护应用）。快照为 `null` 时只返回第一批——没有任何
 * 路径会生成 `/T`，用户的 Office 窗口不因为取证失败而拿命。
 */
export function windowsKillArgs(
  rootPid: number,
  nodes: readonly ProcessNode[] | null,
): { batches: string[][]; spared: ProcessNode[] } {
  const batches: string[][] = [['/pid', String(rootPid), '/F']]
  if (!nodes) return { batches, spared: [] }
  const { kill, spared } = selectKillTargets(rootPid, nodes)
  // 根已经在第一批里处理过：pid 可能在快照之后被复用，别再杀一次。
  const others = kill.filter((pid) => pid !== rootPid)
  if (others.length > 0) {
    batches.push([...others.flatMap((pid) => ['/pid', String(pid)]), '/F'])
  }
  return { batches, spared }
}

/**
 * Windows 上结束一条命令的进程树：先单杀根，再从快照里摘出受保护的 GUI
 * 应用、把剩下的子孙按 pid 强杀（不带 `/T`，要杀的 pid 就是算出来的树）。
 *
 * 返回的 Promise 在子孙的 taskkill 发出后 resolve；不需要等待清理结果的调用方
 * 可以忽略它，但「停止」这类要回真的工具最好 await，否则会把还没退出的进程
 * 报成 stop 失败。
 */
export function killWindowsTree(rootPid: number): Promise<void> {
  // 根进程一定属于这条命令，且不带 `/T` 不会波及用户开着的 Office 窗口。
  // 先杀它：快照要 2s，让它等着会让工具调用一直挂在这儿。
  spawnTaskkill(['/pid', String(rootPid), '/F'])
  return snapshotProcesses().then((nodes) => {
    if (!nodes) return
    const { batches, spared } = windowsKillArgs(rootPid, nodes)
    if (spared.length > 0) {
      // 用户正开着的 Office 窗口：留着，它不属于这条命令的生命周期。
      console.warn(
        `[command] 保留用户应用 ${spared.map((node) => `${node.name}(${node.pid})`).join(' ')}`,
      )
    }
    for (const args of batches.slice(1)) spawnTaskkill(args)
  })
}

function spawnTaskkill(args: string[]): void {
  try {
    const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => undefined)
  } catch {
    // taskkill 不存在或无法启动：调用方还有 3s 的强制收敛定时器。
  }
}
