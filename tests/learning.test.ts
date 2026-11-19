import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_LEARNING_HOSTS,
  MAX_LEARNING_HOSTS,
  appendLearningEntry,
  checkEgress,
  detectUploadVector,
  fetchLearningSource,
  isLocalHost,
  normalizeLearningHostsInput,
  readLearningLedger,
  resolveLearningPolicy,
  sandboxNetworkFor,
  summarizeLearning,
} from '../src/main/agent/learning'

const dirs: string[] = []

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pilot-learning-'))
  dirs.push(root)
  return root
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const policy = resolveLearningPolicy({ learningMode: true })
const off = resolveLearningPolicy({})

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'text/html; charset=utf-8' },
  })
}

describe('resolveLearningPolicy', () => {
  it('defaults to off with the built-in host list', () => {
    const resolved = resolveLearningPolicy({})
    expect(resolved.enabled).toBe(false)
    expect(resolved.hosts).toEqual([...DEFAULT_LEARNING_HOSTS])
  })

  it('normalises user hosts and falls back to defaults when the list is empty', () => {
    const resolved = resolveLearningPolicy({
      learningMode: true,
      learningHosts: [' HTTPS://Docs.Example.COM/path ', 'https://a.test', '', 42],
    })
    expect(resolved.enabled).toBe(true)
    expect(resolved.hosts).toEqual(['docs.example.com', 'a.test'])
    expect(resolveLearningPolicy({ learningHosts: ['  '] }).hosts).toEqual([
      ...DEFAULT_LEARNING_HOSTS,
    ])
  })
})

describe('normalizeLearningHostsInput', () => {
  it('normalises phone-submitted hosts and removes duplicates', () => {
    expect(
      normalizeLearningHostsInput([
        ' HTTPS://Docs.Example.COM/path ',
        'nodejs.org:443',
        'nodejs.org',
        '',
        42,
      ]),
    ).toEqual(['docs.example.com', 'nodejs.org'])
  })

  it('rejects anything that is not a bare hostname', () => {
    for (const value of ['not a host', 'a b.test', '*.example.com', 'a\nb']) {
      expect(() => normalizeLearningHostsInput([value])).toThrow('无效主机')
    }
  })

  it('rejects localhost, private networks and oversized lists', () => {
    for (const value of ['localhost', '127.0.0.1', '192.168.1.10', 'service.internal']) {
      expect(() => normalizeLearningHostsInput([value])).toThrow('本机或内网地址')
    }
    const many = Array.from({ length: MAX_LEARNING_HOSTS + 1 }, (_, index) => `h${index}.test`)
    expect(() => normalizeLearningHostsInput(many)).toThrow(`最多 ${MAX_LEARNING_HOSTS} 个主机`)
  })
})

describe('checkEgress', () => {
  it('refuses everything while learning mode is off', () => {
    const verdict = checkEgress('https://nodejs.org/api/fs.html', 'GET', off)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('没有开启')
  })

  it('allows a read-only GET on an allowlisted host and its subdomains', () => {
    expect(checkEgress('https://nodejs.org/api/fs.html', 'GET', policy).ok).toBe(true)
    expect(checkEgress('https://docs.nodejs.org/x', 'HEAD', policy).ok).toBe(true)
  })

  it('refuses any verb that can carry a body', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const verdict = checkEgress('https://nodejs.org/api', method, policy)
      expect(verdict.ok).toBe(false)
      expect(verdict.reason).toContain('只读')
    }
  })

  it('refuses hosts outside the allowlist', () => {
    const verdict = checkEgress('https://evil.example/x', 'GET', policy)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('白名单')
  })

  it('refuses loopback, private ranges, link-local and metadata endpoints', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.1.2.3',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      '::1',
      '[::1]',
      'fd00::1',
      'svc.internal',
      'printer.local',
    ]) {
      expect(isLocalHost(host)).toBe(true)
      const target = host.startsWith('[') || host.includes(':') ? `[${host.replace(/[[\]]/g, '')}]` : host
      const verdict = checkEgress(`http://${target}/x`, 'GET', policy)
      expect(verdict.ok).toBe(false)
    }
  })

  it('refuses credentials in the URL and non-http schemes', () => {
    expect(checkEgress('https://user:pw@nodejs.org/x', 'GET', policy).ok).toBe(false)
    expect(checkEgress('file:///etc/passwd', 'GET', policy).ok).toBe(false)
    expect(checkEgress('not a url', 'GET', policy).ok).toBe(false)
  })
})

describe('detectUploadVector', () => {
  it('flags commands that ship workspace content off the machine', () => {
    for (const command of [
      'curl -X POST https://api.example.com -d @report.json',
      'curl --upload-file notes.md https://transfer.example.com',
      'wget --post-data=@out.txt https://example.com',
      'scp build.zip user@host:/tmp',
      'rsync -av ./out/ user@host:/srv',
      'git push origin main',
      'gh pr create --fill',
      'npm publish',
      'pnpm publish --access public',
      'docker push registry.example.com/app:1',
      'aws s3 sync ./out s3://bucket',
      'nc host 443',
      'terraform apply -auto-approve',
    ]) {
      expect(detectUploadVector(command), command).not.toBeNull()
    }
  })

  it('leaves ordinary local work alone', () => {
    for (const command of [
      'curl https://nodejs.org/api/fs.html -o tmp/fs.html',
      'git status --porcelain',
      'git commit -m "写好了"',
      'npm test -- learning',
      'pnpm typecheck',
      'ls -la out',
      'node scripts/build.mjs',
    ]) {
      expect(detectUploadVector(command), command).toBeNull()
    }
  })
})

describe('sandboxNetworkFor', () => {
  it('keeps task-session networking unless the user isolates the shell', () => {
    // 学习模式默认不接管 shell：沙箱网络只由 sandboxNetwork 决定。
    expect(sandboxNetworkFor(policy, true)).toBe(true)
    expect(sandboxNetworkFor(policy, false)).toBe(false)
    expect(sandboxNetworkFor(off, true)).toBe(true)
    expect(sandboxNetworkFor(null, true)).toBe(true)
  })

  it('cuts the shell network only when learning and isolation are both on', () => {
    // 用户显式开启隔离时，才是文本匹配之外的第二层兜底。
    expect(sandboxNetworkFor(policy, true, true)).toBe(false)
    expect(sandboxNetworkFor(policy, false, true)).toBe(false)
    expect(sandboxNetworkFor(off, true, true)).toBe(true)
    expect(sandboxNetworkFor(null, true, true)).toBe(true)
  })
})

describe('fetchLearningSource', () => {
  it('stores a capped copy inside the workspace and returns an id', async () => {
    const root = await workspace()
    const source = await fetchLearningSource({
      root,
      url: 'https://nodejs.org/api/fs.html',
      policy,
      maxBytes: 2048,
      fetchImpl: async () =>
        response(`<html>${'文档内容'.repeat(2000)}</html>`, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    })
    expect(source.path.startsWith('.pilot/learning/sources/')).toBe(true)
    expect(source.truncated).toBe(true)
    expect(source.bytes).toBe(2048)
    const onDisk = await readFile(join(root, source.path), 'utf8')
    expect(onDisk).toContain('# source: https://nodejs.org/api/fs.html')
    expect(onDisk).toContain('never uploaded')
    expect(source.id).toMatch(/^source-[0-9a-f]{12}$/)
  })

  it('re-checks every redirect hop, so a 302 to an internal address is refused', async () => {
    const root = await workspace()
    await expect(
      fetchLearningSource({
        root,
        url: 'https://nodejs.org/api/fs.html',
        policy,
        fetchImpl: async () =>
          response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
      }),
    ).rejects.toThrow(/出域守门拒绝/)
  })

  it('refuses binary payloads and non-2xx responses', async () => {
    const root = await workspace()
    await expect(
      fetchLearningSource({
        root,
        url: 'https://nodejs.org/logo.png',
        policy,
        fetchImpl: async () => response('PNG', { headers: { 'content-type': 'image/png' } }),
      }),
    ).rejects.toThrow(/非文本/)
    await expect(
      fetchLearningSource({
        root,
        url: 'https://nodejs.org/missing',
        policy,
        fetchImpl: async () => response('nope', { status: 404, headers: { 'content-type': 'text/plain' } }),
      }),
    ).rejects.toThrow(/HTTP 404/)
  })
})

describe('learning ledger', () => {
  it('appends and reads entries, skipping corrupt lines', async () => {
    const root = await workspace()
    await appendLearningEntry(root, {
      kind: 'source',
      url: 'https://nodejs.org/api/fs.html',
      host: 'nodejs.org',
    })
    await appendLearningEntry(root, { kind: 'task', title: '整理 fs 的异步 API', goal: '写出对照表' })
    expect(await readLearningLedger(root)).toHaveLength(2)

    const path = join(root, '.pilot/learning/ledger.jsonl')
    const { appendFile } = await import('node:fs/promises')
    await appendFile(path, '{ not json }\n', 'utf8')
    expect(await readLearningLedger(root)).toHaveLength(2)
  })

  it('summarises outcomes into an approval rate and focus suggestions', async () => {
    const entries = [
      { at: '2026-01-01T00:00:00.000Z', kind: 'source' as const, id: 's1', host: 'nodejs.org' },
      { at: '2026-01-01T00:01:00.000Z', kind: 'source' as const, id: 's2', host: 'nodejs.org' },
      { at: '2026-01-01T00:02:00.000Z', kind: 'task' as const, id: 't1', title: 'A' },
      { at: '2026-01-01T00:03:00.000Z', kind: 'task' as const, id: 't2', title: 'B' },
      {
        at: '2026-01-01T00:04:00.000Z',
        kind: 'outcome' as const,
        id: 'o1',
        taskId: 't1',
        verdict: 'rejected' as const,
        quality: 0.4,
      },
      { at: '2026-01-01T00:05:00.000Z', kind: 'outcome' as const, id: 'o2', taskId: 't2', verdict: 'pending' as const },
    ]
    const summary = summarizeLearning(entries)
    expect(summary.sources).toBe(2)
    expect(summary.tasks).toBe(2)
    expect(summary.outcomes).toBe(2)
    expect(summary.rejected).toBe(1)
    expect(summary.pending).toBe(1)
    expect(summary.approvalRate).toBe(0)
    expect(summary.averageQuality).toBeCloseTo(0.4)
    // t1 已被驳回（算已裁决），t2 仍是待批，所以只剩 1 个未收尾任务。
    expect(summary.openTasks).toBe(1)
    expect(summary.hosts).toEqual([{ host: 'nodejs.org', sources: 2 }])
    expect(summary.focus.join(' ')).toContain('等用户裁决')
    expect(summary.focus.join(' ')).toContain('先收尾')
    expect(summary.focus.length).toBeLessThanOrEqual(4)
  })

  it('reports an empty ledger as all-zero rather than dividing by zero', () => {
    const summary = summarizeLearning([])
    expect(summary.approvalRate).toBe(0)
    expect(summary.averageQuality).toBe(0)
    expect(summary.focus).toEqual([])
  })
})
