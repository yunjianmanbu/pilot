import { describe, expect, it } from 'vitest'
import {
  buildDiagnosticsBundle,
  diagnosticsFileName,
  redactDiagnosticText,
  scanForSecrets,
  type DiagnosticsBundleInput,
} from '../src/shared/diagnostics-bundle'
import type { SelfCheckReport } from '../src/shared/self-check'

const HOME = 'C:\\Users\\alice'
const USER_DATA = 'C:\\Users\\alice\\AppData\\Roaming\\pilot-agent'
const WORKSPACE = 'C:\\Users\\alice\\code\\demo'
// 实机发现：应用自身目录既不是 home 也不是 userData，曾整段泄进包里。
const APP_DIR = 'D:\\apps\\Pilot\\resources\\app.asar'

const scope = { home: HOME, userData: USER_DATA, paths: [WORKSPACE], appDir: APP_DIR }

const selfCheck: SelfCheckReport = {
  at: Date.parse('2026-11-26T07:00:00.000Z'),
  version: '1.3.1',
  durationMs: 42,
  counts: { ok: 1, warn: 1, off: 1, broken: 0 },
  items: [
    {
      id: 'model.provider',
      group: 'model',
      title: '模型接入',
      status: 'warn',
      detail: '主渠道可用，备用渠道没配 Key',
      facts: ['apiKey=sk-live-abcdefghijklmnop', `userData=${USER_DATA}`],
      durationMs: 3,
    },
    {
      id: 'exec.sandbox',
      group: 'exec',
      title: '沙箱',
      status: 'off',
      detail: '未启用',
      facts: ['backend=none'],
      durationMs: 1,
    },
    {
      id: 'data.store',
      group: 'data',
      title: '数据存储',
      status: 'ok',
      detail: '可读写',
      facts: [`workspace=${WORKSPACE}`],
      durationMs: 2,
    },
  ],
}

function baseInput(): DiagnosticsBundleInput {
  return {
    generatedAt: new Date('2026-11-26T07:04:00.000Z'),
    environment: {
      version: '1.3.1',
      platform: 'win32 10.0.22631',
      arch: 'x64',
      packaged: true,
      locale: 'zh-CN',
      electron: '33.0.0',
      node: '20.18.0',
      chrome: '130.0.6723.58',
      cpuCount: 8,
      cpuModel: 'Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz',
      memoryFreeBytes: 2 * 1024 * 1024 * 1024,
      memoryTotalBytes: 16 * 1024 * 1024 * 1024,
    },
    sandbox: {
      mode: 'off',
      available: false,
      backend: 'none',
      detail: '沙箱未启用。',
      networkIsolation: false,
    },
    selfCheck,
    logs: [
      {
        at: '2026-11-26T06:58:00.000Z',
        area: 'model',
        event: 'provider.ready',
        level: 'info',
        detail: { apiKey: 'sk-live-abcdefghijklmnop', baseUrl: 'https://api.example.com' },
      },
      {
        at: '2026-11-26T06:59:00.000Z',
        area: 'settings',
        event: 'smtp.configured',
        level: 'warn',
        detail: { note: `password=hunter2 写到 ${USER_DATA}\\settings.json` },
      },
      {
        at: '2026-11-26T07:00:00.000Z',
        area: 'workspace',
        event: 'workspace.opened',
        level: 'error',
        detail: { path: WORKSPACE.replace(/\\/g, '/'), reason: 'ENOENT' },
      },
    ],
    logDir: `${USER_DATA}\\logs`,
    workspaces: [WORKSPACE],
    scope,
  }
}

function allText(input: DiagnosticsBundleInput): { files: ReturnType<typeof buildDiagnosticsBundle>['files']; text: string } {
  const { files } = buildDiagnosticsBundle(input)
  return { files, text: files.map((file) => file.text).join('\n') }
}

describe('诊断包脱敏', () => {
  it('凭据形状的串与敏感键值都被替换', () => {
    const text = [
      'apiKey: sk-live-abcdefghijklmnop',
      'api_key="sk-ant-api03-zzzzzzzz"',
      'password=hunter2',
      'PASSWORD "hunter2"',
      'authorization: Bearer abcdefghijklmnopqrst',
      'token=ghp_abcdefghijklmnopqrst',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      'secret://url/abcdef',
    ].join('\n')
    const out = redactDiagnosticText(text)

    expect(out).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(out).not.toMatch(/api[\s_-]?key/i)
    expect(out).not.toMatch(/pass(?:word|wd|phrase)/i)
    expect(out).not.toMatch(/ghp_/)
    expect(out).not.toMatch(/PRIVATE KEY/)
    expect(out).not.toMatch(/secret:\/\//)
    expect(out).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{12,}/)
    expect(out).toContain('<redacted>')
  })

  it('用户目录、应用数据目录、工作区路径与裸用户名都换成占位符', () => {
    const out = redactDiagnosticText(
      `home=${HOME}, userData=${USER_DATA}, ws=${WORKSPACE.replace(/\\/g, '/')}, raw=${WORKSPACE}`,
      scope,
    )

    expect(out).not.toContain('alice')
    expect(out).not.toContain('Users')
    expect(out).toContain('<home>')
    expect(out).toContain('<userData>')
    expect(out).toContain('<workspace>')
  })

  it('应用自身目录同样换成 <appDir>', () => {
    const out = redactDiagnosticText(
      `程序目录 ${APP_DIR}, 正斜杠 ${APP_DIR.replace(/\\/g, '/')}`,
      scope,
    )

    expect(out).not.toContain('apps')
    expect(out).not.toContain('app.asar')
    expect(out).toBe('程序目录 <appDir>, 正斜杠 <appDir>')
  })

  it('不含用户名子串的普通词不被误伤', () => {
    const out = redactDiagnosticText('development environment is ready', scope)
    expect(out).toBe('development environment is ready')
  })
})

describe('诊断包内容', () => {
  it('整包对 sk-/apiKey/password 零命中', () => {
    const { text } = allText(baseInput())

    expect(text).not.toMatch(/sk-[A-Za-z0-9]/)
    expect(text.toLowerCase()).not.toContain('apikey')
    expect(text.toLowerCase()).not.toContain('password')
    expect(text).not.toContain('alice')
    expect(text).not.toContain('hunter2')
    expect(scanForSecrets(text)).toEqual([])
  })

  it('包含自检、环境、日志三份可读产物', () => {
    const { files, text } = allText(baseInput())
    const names = files.map((file) => file.name)

    expect(names).toEqual([
      'README.txt',
      'summary.txt',
      'environment.json',
      'self-check.txt',
      'self-check.json',
      'runtime-log.jsonl',
    ])
    expect(text).toContain('Pilot 内视')
    expect(text).toContain('<workspace>')
  })

  it('summary 写清版本、平台、沙箱、内视计数与日志条数', () => {
    const { files } = allText(baseInput())
    const summary = files.find((file) => file.name === 'summary.txt')?.text ?? ''

    expect(summary).toContain('1.3.1')
    expect(summary).toContain('win32 10.0.22631')
    expect(summary).toContain('x64')
    expect(summary).toContain('Electron 33.0.0')
    expect(summary).toContain('沙箱 未启用（none）')
    expect(summary).toContain('正常 1 · 注意 1 · 未启用 1 · 异常 0')
    expect(summary).toContain('日志 最近 3 条（错误 1 · 警告 1）')
    expect(summary).toContain('路径已打码')
  })

  it('runtime-log.jsonl 每条日志一行且是合法 JSON', () => {
    const { files } = allText(baseInput())
    const log = files.find((file) => file.name === 'runtime-log.jsonl')?.text ?? ''
    const lines = log.split('\n').filter(Boolean)

    expect(lines).toHaveLength(3)
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>
      expect(typeof record['at']).toBe('string')
      expect(typeof record['area']).toBe('string')
      expect(typeof record['event']).toBe('string')
    }
  })

  it('environment.json 保留沙箱与运行时事实，路径已打码', () => {
    const { files } = allText(baseInput())
    const raw = files.find((file) => file.name === 'environment.json')?.text ?? ''
    const parsed = JSON.parse(raw) as {
      platform: { os: string; electron: string }
      sandbox: { backend: string }
      workspaces: string[]
      logDir: string
    }

    expect(parsed.platform.os).toBe('win32 10.0.22631')
    expect(parsed.platform.electron).toBe('33.0.0')
    expect(parsed.sandbox.backend).toBe('none')
    expect(parsed.workspaces).toEqual(['<workspace>'])
    expect(parsed.logDir).toBe('<userData>\\logs')
  })

  it('内视没跑成功时写明原因，不把失败包装成正常', () => {
    const input = { ...baseInput(), selfCheck: null, selfCheckError: '内视超时' }
    const { files } = allText(input)
    const summary = files.find((file) => file.name === 'summary.txt')?.text ?? ''
    const check = files.find((file) => file.name === 'self-check.txt')?.text ?? ''

    expect(summary).toContain('内视 未完成：内视超时')
    expect(check).toContain('内视未完成：内视超时')
  })

  it('日志为空时不写坏行', () => {
    const input = { ...baseInput(), logs: [] }
    const { files } = allText(input)
    const log = files.find((file) => file.name === 'runtime-log.jsonl')?.text ?? ''
    expect(log).toBe('')
  })
})

describe('导出自检与文件名', () => {
  it('scanForSecrets 对未打码样本报出模式名', () => {
    expect(scanForSecrets('apiKey=sk-live-abcdefghijklmnop')).toContain('api key')
    expect(scanForSecrets('password=hunter2')).toContain('password')
    expect(scanForSecrets('ok nothing here')).toEqual([])
  })

  it('文件名带日期与分钟', () => {
    expect(diagnosticsFileName(new Date(2026, 10, 26, 15, 4))).toBe('Pilot-diagnostics-20261126-1504.zip')
  })

  // 真正落盘的那一步：主进程把文件清单交给 JSZip 压成 buffer。这里走同一条路径，
  // 解包后逐份文本再 grep 一遍：证明打码过的内容装进 zip 不会因为转义再泄一次，
  // 同时证明 zip 能被正常解开（否则用户拿到的是个坏包）。
  it('压成 zip 再解开后仍然零命中，且文件名一个不少', async () => {
    const JSZip = (await import('jszip')).default
    const { files } = buildDiagnosticsBundle(baseInput())

    const zip = new JSZip()
    for (const file of files) zip.file(file.name, file.text)
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const reopened = await JSZip.loadAsync(buffer)

    const names = Object.keys(reopened.files).sort()
    expect(names).toEqual(files.map((file) => file.name).sort())

    for (const name of names) {
      const text = await reopened.file(name)?.async('string')
      expect(text, name).toBeTruthy()
      expect(text!, name).not.toMatch(/sk-[A-Za-z0-9]/)
      expect(text!.toLowerCase(), name).not.toContain('apikey')
      expect(text!.toLowerCase(), name).not.toContain('password')
      expect(scanForSecrets(text!), name).toEqual([])
    }
  })
})
