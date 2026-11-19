import { describe, expect, it } from 'vitest'
import {
  localizeChanges,
  localizeMain,
  localizeSessionTitle,
  localizeUpdateState,
} from '../src/main/localize'
import type { UpdateState } from '../src/shared/types'

describe('localizeMain', () => {
  it('leaves Chinese untouched for the Chinese UI', () => {
    expect(localizeMain('沙箱未启用。', 'zh-CN')).toBe('沙箱未启用。')
  })

  it('translates exact settings copy', () => {
    expect(localizeMain('沙箱未启用。', 'en')).toBe('Sandbox disabled.')
  })

  it('translates generated shell details', () => {
    expect(localizeMain('使用 Git Bash：C:\\Program Files\\Git\\bin\\bash.exe', 'en')).toBe(
      'Using Git Bash: C:\\Program Files\\Git\\bin\\bash.exe',
    )
    expect(localizeMain('自动选择 Git Bash：C:\\Git\\bash.exe', 'en')).toBe(
      'Using Git Bash automatically: C:\\Git\\bash.exe',
    )
    expect(localizeMain('使用 cmd.exe 执行。支持管道、重定向和 %VAR% 变量，兼容 .bat/.cmd。', 'en')).toBe(
      'Runs with cmd.exe. Pipes, redirects and %VAR% work, and .bat/.cmd files are supported.',
    )
  })

  it('translates feedback validation messages', () => {
    expect(localizeMain('请填写一句话概括', 'en')).toBe('Add a one-line summary.')
    expect(localizeMain('概括请控制在 80 个字符以内', 'en')).toBe(
      'The summary must be 80 characters or fewer.',
    )
    expect(localizeMain('联系方式请控制在 120 个字符以内', 'en')).toBe(
      'The contact must be 120 characters or fewer.',
    )
    expect(localizeMain('请填写一句话概括', 'zh-CN')).toBe('请填写一句话概括')
  })

  it('translates IPC errors and update messages', () => {
    expect(localizeMain('待办内容不能为空', 'en')).toBe('Todo content cannot be empty.')
    expect(localizeMain('发现新版本 v0.1.23（42 MB）。', 'en')).toBe('v0.1.23 is available (42 MB).')
    expect(localizeMain('检查更新失败：更新清单格式不正确。', 'en')).toBe(
      'Update check failed: The update manifest has the wrong format.',
    )
    expect(localizeMain('不允许从 evil.example 下载更新。', 'en')).toBe(
      'Updates cannot be downloaded from evil.example.',
    )
    expect(localizeMain('正在增量下载 v0.1.23… 42%', 'en')).toBe(
      'Downloading v0.1.23 incrementally… 42%',
    )
    expect(localizeMain('v0.1.23 已下载并通过校验（增量 1.3 MB），重启后安装。', 'en')).toBe(
      'v0.1.23 downloaded and verified (incremental, 1.3 MB); it installs after a restart.',
    )
  })

  it('passes unknown and technical text through', () => {
    expect(localizeMain('ENOENT: no such file', 'en')).toBe('ENOENT: no such file')
  })
})

describe('localizeSessionTitle', () => {
  it('translates generated defaults while preserving user titles', () => {
    expect(localizeSessionTitle('新任务', 'en')).toBe('New task')
    expect(localizeSessionTitle('复盘评估', 'en')).toBe('Review')
    expect(localizeSessionTitle('复盘：检查发布流程', 'en')).toBe('Review: 检查发布流程')
    expect(localizeSessionTitle('复盘 · pilot', 'en')).toBe('Review · pilot')
    expect(localizeSessionTitle('修复：登录失败', 'en')).toBe('Fix: 登录失败')
    expect(localizeSessionTitle('新任务 · 副本', 'en')).toBe('New task · Copy')
    expect(localizeSessionTitle('Fix the sidebar', 'en')).toBe('Fix the sidebar')
    expect(localizeSessionTitle('新任务', 'zh-CN')).toBe('新任务')
  })
})

describe('localizeUpdateState', () => {
  it('localizes only the message', () => {
    const state: UpdateState = {
      status: 'idle',
      currentVersion: '0.1.22',
      release: null,
      progress: 0,
      transferred: 0,
      total: 0,
      message: '尚未检查更新。',
      checkedAt: null,
      canInstall: false,
      elevationRequired: false,
      relocatingToUserDir: false,
    }
    expect(localizeUpdateState(state, 'en')).toEqual({ ...state, message: 'Not checked yet.' })
    expect(localizeUpdateState(state, 'zh-CN')).toEqual(state)
  })
})

describe('localizeChanges', () => {
  it('translates notes and leaves entries without notes alone', () => {
    const entries = [
      { path: 'a.ts', note: '二进制文件无法预览差异。' },
      { path: 'b.ts' },
    ]
    expect(localizeChanges(entries, 'en')).toEqual([
      { path: 'a.ts', note: 'This is a binary file, so its diff cannot be shown.' },
      { path: 'b.ts' },
    ])
  })
})
