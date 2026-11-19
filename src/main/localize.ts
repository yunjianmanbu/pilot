import type { AppLocale } from '../shared/i18n'
import type { UpdateState } from '../shared/types'

/**
 * 主进程里少量直接展示在界面上的状态文案。
 *
 * 智能体提示词、工具描述和日志不在这里翻译；这里只覆盖设置页会显示的
 * 解释文本，避免英文界面里混入中文。未收录的文案原样返回。
 */
const en: Record<string, string> = {
  '沙箱未启用。': 'Sandbox disabled.',
  '未检测到可用的 WSL2 + bubblewrap。Windows 原生环境没有 Claude Code 式的 OS 沙箱；命令会以普通权限运行并逐次请求确认。':
    'No usable WSL2 + bubblewrap found. Windows has no OS sandbox like Claude Code, so commands run with normal permissions and ask for confirmation each time.',
  '已检测到 WSL2 + bubblewrap：命令在 WSL 中运行，工作区可写、其余文件系统只读，可按设置关闭网络。Windows 项目依赖在该环境中可能不兼容，请先验证。':
    'WSL2 + bubblewrap detected: commands run in WSL with a writable workspace and a read-only filesystem elsewhere; network can be disabled in settings. Windows project dependencies may not work there — verify first.',
  '未检测到可用的 bubblewrap；命令会以普通权限运行并逐次请求确认。':
    'No usable bubblewrap found; commands run with normal permissions and ask for confirmation each time.',
  '已检测到 bubblewrap：工作区可写、其余文件系统只读，可按设置关闭网络。':
    'bubblewrap detected: the workspace is writable, the rest of the filesystem is read-only, and network can be disabled in settings.',
  '已检测到 macOS Seatbelt：工作区可写、其余文件系统只读，可按设置关闭网络。':
    'macOS Seatbelt detected: the workspace is writable, the rest of the filesystem is read-only, and network can be disabled in settings.',
  '未找到 Git Bash。请安装 Git for Windows，或改为「自动 / cmd」。':
    'Git Bash not found. Install Git for Windows, or switch to “Auto / cmd”.',
  '使用 wsl.exe -e bash -lc 执行；工作区路径由 WSL 自动映射。':
    'Runs through wsl.exe -e bash -lc; WSL maps workspace paths automatically.',
  '未检测到可用的 WSL 发行版（或 wsl.exe 不存在）。请安装 WSL，或改为「自动 / cmd」。':
    'No usable WSL distribution found (or wsl.exe is missing). Install WSL, or switch to “Auto / cmd”.',
  '未找到 Git Bash，自动改用 WSL 中的 bash；需要已安装可用的 Linux 发行版。':
    'Git Bash not found; using bash inside WSL instead. A usable Linux distribution is required.',
  '未找到 Git Bash 或 WSL，自动使用 cmd.exe。命令仍按 cmd 语法执行。':
    'Git Bash and WSL were not found; using cmd.exe. Commands still follow cmd syntax.',
  '当前平台暂不支持应用内更新。': 'In-app updates are not supported on this platform.',
  '在线更新已被禁用。': 'In-app updates are disabled.',
  '尚未检查更新。': 'Not checked yet.',
  '正在检查更新…': 'Checking for updates…',
  '已是最新版本。': 'You are up to date.',
  '正在安装更新，Pilot 将退出并在完成后重新启动…':
    'Installing the update. Pilot will quit and restart when it finishes.',
  '正在安装到当前用户目录并更新，Pilot 将退出并在完成后重新启动…':
    'Installing to your user folder and updating. Pilot will quit and restart when it finishes.',
  '当前环境不支持自动安装更新。': 'This environment does not support automatic updates.',
  '没有已下载的更新。': 'There is no downloaded update.',
  '安装包大小与清单不一致，请重新下载。':
    'The installer size does not match the manifest. Download it again.',
  '安装包校验失败，请重新下载。': 'Installer verification failed. Download it again.',
  '安装已取消：需要在 Windows 授权框里点「是」才能继续。':
    'Install cancelled: click “Yes” in the Windows permission prompt to continue.',
  '安装包 SHA-256 校验失败，请重试。': 'Installer SHA-256 verification failed. Try again.',
  '复盘至少需要一个可读取的目录': 'A review needs at least one readable folder.',
  '复盘需要一个主工作区': 'A review needs a primary workspace.',
  '请先打开主工作区，再创建复盘会话': 'Open the primary workspace before starting a review.',
  '手机连接尚未初始化': 'Phone connection is not initialized yet.',
  '图片太大，请压缩后再添加': 'This image is too large. Compress it and try again.',
  '请先等待当前任务结束（或暂停）再创建副本':
    'Wait for the current task to finish (or pause it) before duplicating.',
  '请先等待当前任务结束或暂停后再撤销':
    'Wait for the current task to finish or pause it before undoing.',
  '请先等待当前任务结束或暂停后再创建回退点':
    'Wait for the current task to finish or pause it before creating a checkpoint.',
  '请先等待当前任务结束或暂停后再回退':    'Wait for the current task to finish or pause it before rolling back.',
  '请选择反馈类型': 'Choose what kind of feedback this is.',
  '请填写一句话概括': 'Add a one-line summary.',
  '请填写具体内容': 'Describe the details.',
  '无法打开反馈文件夹': 'Could not open the feedback folder.',
  '待办不存在': 'That todo no longer exists.',
  '该待办已发送': 'That todo has already been sent.',
  '待办内容不能为空': 'Todo content cannot be empty.',
  '已发送的待办不能编辑': 'A sent todo cannot be edited.',
  '已发送的待办不能再转为定时任务': 'A sent todo cannot become a scheduled task.',
  '定时任务不存在': 'That scheduled task no longer exists.',
  '定时任务内容不能为空': 'Scheduled task content cannot be empty.',
  '请选择每天执行的时间': 'Pick a time for the daily run.',
  '中继地址必须是 wss:// 或 ws:// 地址，且不能包含用户名或密码。':
    'The relay address must be a wss:// or ws:// URL without a username or password.',
  '选择的路径不是文件夹': 'The selected path is not a folder.',
  '新建的目录不在授权范围内': 'The new folder is outside the authorized range.',
  '快照': 'Snapshot',
  '二进制文件无法预览差异。': 'This is a binary file, so its diff cannot be shown.',
  '这个会话没有可用的基线回退点，无法安全撤销。':
    'This session has no usable baseline checkpoint, so it cannot be reverted safely.',
  '基线快照读取失败，无法比较或撤销。':
    'The baseline snapshot could not be read, so it cannot be compared or reverted.',
  '基线中的这个文件是二进制内容，无法预览差异，但仍可撤销。':
    'This file is binary in the baseline, so its diff cannot be shown, but it can still be reverted.',
  '基线回退点不完整，无法确认这个文件是否为新建，已禁用撤销。':
    'The baseline checkpoint is incomplete, so it is unclear whether this file is new; revert is disabled.',
  '回退点服务未初始化': 'The checkpoint service is not initialized.',
  '这个文件不是本次会话修改的产物': 'This file was not changed by this session.',
  '这个会话没有可用的基线回退点': 'This session has no usable baseline checkpoint.',
  '更新下载地址无效。': 'The update download URL is invalid.',
  '更新下载地址不能包含凭据。': 'The update download URL cannot contain credentials.',
  '更新下载地址必须使用 HTTPS。': 'The update download URL must use HTTPS.',
  '更新清单格式不正确。': 'The update manifest has the wrong format.',
  '更新清单不属于 Pilot。': 'This update manifest does not belong to Pilot.',
  '更新清单的版本号无效。': 'The update manifest has an invalid version.',
  '当前仅支持 stable 更新通道。': 'Only the stable update channel is supported.',
  '更新清单缺少安装包大小。': 'The update manifest is missing the installer size.',
  '更新清单的安装包大小超出允许范围。':
    'The installer size in the update manifest is out of range.',
  '更新清单的 SHA-256 校验值无效。':
    'The update manifest has an invalid SHA-256 checksum.',
}

const bashInUse = /^使用 Git Bash：(.+)$/
const updateAvailable = /^发现新版本 v(.+)（(.+)）。$/
const updateCheckFailed = /^检查更新失败：(.+)$/
const updateDownloading = /^正在下载 v(.+)… (\d+)%$/
const updateDownloadingStart = /^正在下载 v(.+)…$/
const updateIncrementalDownloading = /^正在增量下载 v(.+)… (\d+)%$/
const updateIncrementalDownloadingStart = /^正在增量下载 v(.+)…$/
const updateIncrementalReady = /^v(.+) 已下载并通过校验（增量 (.+)），重启后安装。$/
const updateIncrementalReadyDev = /^v(.+) 已下载并通过校验（增量 (.+)）；开发模式下不会执行安装。$/
const updateReady = /^v(.+) 已下载并通过校验，重启后安装。$/
const updateReadyDev = /^v(.+) 已下载并通过校验；开发模式下不会执行安装。$/
const updateDownloadFailed = /^下载更新失败：(.+)$/
const installerSizeMismatch = /^安装包大小不一致（期望 (.+) 字节，实际 (.+) 字节）。$/
const reviewSessionMissing = /^复盘范围内的会话不存在：(.+)$/
const manualSnapshot = /^手动快照 (.+)$/
const maxPhoneRoots = /^最多授权 (\d+) 个目录$/
const workspaceLimit = /^工作区数量已达上限（(\d+)）$/
const untrustedUpdateHost = /^不允许从 (.+) 下载更新。$/
const manifestMissing = /^更新清单缺少(.+)。$/
const manifestBadFormat = /^更新清单的(.+)格式不正确。$/
const manifestTooLong = /^更新清单的(.+)过长。$/

const manifestLabels: Record<string, string> = {
  应用名称: 'app name',
  版本号: 'version',
  更新通道: 'update channel',
  下载地址: 'download URL',
  校验值: 'checksum',
  平台: 'platform',
  发布日期: 'release date',
  更新说明: 'release notes',
}

function manifestLabel(value: string): string {
  return manifestLabels[value] ?? value
}
const bashAuto = /^自动选择 Git Bash：(.+)$/
const posixShell = /^非 Windows 系统使用 \$SHELL（(.+)），此选项不影响执行。$/
const cmdInUse = /^使用 (.+) 执行。支持管道、重定向和 %VAR% 变量，兼容 \.bat\/\.cmd。$/
const feedbackTooLong = /^(概括|内容|联系方式)请控制在 (\d+) 个字符以内$/
const feedbackFieldLabels: Record<string, string> = {
  概括: 'The summary',
  内容: 'The description',
  联系方式: 'The contact',
}

export function localizeMain(source: string, locale: AppLocale): string {
  if (locale !== 'en') return source
  const exact = en[source]
  if (exact) return exact
  let match = source.match(bashInUse)
  if (match) return `Using Git Bash: ${match[1]}`
  match = source.match(bashAuto)
  if (match) return `Using Git Bash automatically: ${match[1]}`
  match = source.match(posixShell)
  if (match) return `Non-Windows systems use $SHELL (${match[1]}); this option does not affect execution.`
  match = source.match(cmdInUse)
  if (match)
    return `Runs with ${match[1]}. Pipes, redirects and %VAR% work, and .bat/.cmd files are supported.`
  match = source.match(feedbackTooLong)
  if (match) return `${feedbackFieldLabels[match[1] ?? ''] ?? 'The text'} must be ${match[2]} characters or fewer.`
  match = source.match(updateAvailable)
  if (match) return `v${match[1]} is available (${match[2]}).`
  match = source.match(updateCheckFailed)
  if (match) return `Update check failed: ${localizeMain(match[1] ?? '', locale)}`
  match = source.match(updateDownloading)
  if (match) return `Downloading v${match[1]}… ${match[2]}%`
  match = source.match(updateDownloadingStart)
  if (match) return `Downloading v${match[1]}…`
  match = source.match(updateIncrementalDownloadingStart)
  if (match) return `Downloading v${match[1]} incrementally…`
  match = source.match(updateIncrementalDownloading)
  if (match) return `Downloading v${match[1]} incrementally… ${match[2]}%`
  match = source.match(updateIncrementalReady)
  if (match)
    return `v${match[1]} downloaded and verified (incremental, ${match[2]}); it installs after a restart.`
  match = source.match(updateIncrementalReadyDev)
  if (match)
    return `v${match[1]} downloaded and verified (incremental, ${match[2]}); installation is skipped in development mode.`
  match = source.match(updateReady)
  if (match) return `v${match[1]} downloaded and verified; it installs after a restart.`
  match = source.match(updateReadyDev)
  if (match) return `v${match[1]} downloaded and verified; installation is skipped in development mode.`
  match = source.match(updateDownloadFailed)
  if (match) return `Update download failed: ${localizeMain(match[1] ?? '', locale)}`
  match = source.match(installerSizeMismatch)
  if (match)
    return `Installer size mismatch (expected ${match[1]} bytes, received ${match[2]} bytes).`
  match = source.match(reviewSessionMissing)
  if (match) return `Session not found in the review scope: ${match[1]}`
  match = source.match(manualSnapshot)
  if (match) return `Manual snapshot ${match[1]}`
  match = source.match(maxPhoneRoots)
  if (match) return `At most ${match[1]} folders can be authorized`
  match = source.match(workspaceLimit)
  if (match) return `Workspace limit reached (${match[1]})`
  match = source.match(untrustedUpdateHost)
  if (match) return `Updates cannot be downloaded from ${match[1]}.`
  match = source.match(manifestMissing)
  if (match) return `The update manifest is missing ${manifestLabel(match[1] ?? '')}.`
  match = source.match(manifestBadFormat)
  if (match) return `The update manifest's ${manifestLabel(match[1] ?? '')} has the wrong format.`
  match = source.match(manifestTooLong)
  if (match) return `The update manifest's ${manifestLabel(match[1] ?? '')} is too long.`
  return source
}

/**
 * Session titles are stored data, but the defaults and generated prefixes are
 * UI chrome. Translate only those known shapes; user-written titles pass through.
 */
export function localizeSessionTitle(title: string, locale: AppLocale): string {
  if (locale !== 'en' || !title) return title
  const copy = title.match(/^(.*?)(?:\s*·\s*)副本$/)
  const base = copy?.[1] ?? title
  let result = base
  if (base === '新任务') result = 'New task'
  else if (base === '复盘评估') result = 'Review'
  else if (base.startsWith('复盘：')) result = `Review: ${base.slice('复盘：'.length)}`
  else if (base.startsWith('复盘 · ')) result = `Review · ${base.slice('复盘 · '.length)}`
  else if (base.startsWith('修复：')) result = `Fix: ${base.slice('修复：'.length)}`
  return copy ? `${result} · Copy` : result
}

/** Localize the messages the update dialog renders; statuses stay as-is. */
export function localizeUpdateState(state: UpdateState, locale: AppLocale): UpdateState {
  return { ...state, message: localizeMain(state.message, locale) }
}

/** Localize the optional notes attached to file changes in the Changes view. */
export function localizeChanges<T extends { note?: string }>(changes: T[], locale: AppLocale): T[] {
  return changes.map((change) =>
    change.note ? { ...change, note: localizeMain(change.note, locale) } : change,
  )
}
