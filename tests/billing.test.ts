import { describe, expect, it } from 'vitest'
import {
  USD_CNY_RATE,
  cacheSplit,
  convertCost,
  costCurrencyFor,
  costOfUsage,
  formatCostAmount,
  isPeakTime,
  priceForModel,
  rateMultiplier,
  summarizeUsage,
} from '../src/shared/billing'
import {
  balanceFlavor,
  fetchBalance,
  BillingService,
  type BillingStore,
} from '../src/main/billing'

/** 2026-11-10 is a Tuesday: peak at 02:00 and 07:00 UTC, off-peak otherwise. */
const peak = new Date('2026-11-10T02:00:00Z')
const offPeak = new Date('2026-11-10T12:00:00Z')

describe('price table', () => {
  it('prices the models Pilot can select and refuses the rest', () => {
    expect(priceForModel('deepseek-chat')?.output).toBe(1.2)
    expect(priceForModel('DeepSeek-V4-Pro')?.output).toBe(3.96)
    expect(priceForModel('some-custom-model')).toBeNull()
    expect(priceForModel('')).toBeNull()
    expect(priceForModel(null)).toBeNull()
  })

  it('applies peak only inside the documented UTC windows on weekdays', () => {
    expect(isPeakTime(peak)).toBe(true)
    expect(isPeakTime(new Date('2026-11-10T07:30:00Z'))).toBe(true)
    expect(isPeakTime(new Date('2026-11-10T04:30:00Z'))).toBe(false)
    expect(isPeakTime(offPeak)).toBe(false)
    // Weekend is entirely off-peak, including a window hour.
    expect(isPeakTime(new Date('2026-11-14T02:00:00Z'))).toBe(false)
    expect(rateMultiplier(peak)).toBe(1)
    expect(rateMultiplier(offPeak)).toBe(0.5)
  })
})

describe('cost estimate', () => {
  it('bills cache hits, misses and output separately', () => {
    // 1M tokens of each at deepseek-chat peak price: 0.006 + 0.3 + 1.2.
    const cost = costOfUsage(
      'deepseek-chat',
      {
        promptTokens: 2_000_000,
        completionTokens: 1_000_000,
        cacheHitTokens: 1_000_000,
        cacheMissTokens: 1_000_000,
      },
      peak,
    )
    expect(cost).toBeCloseTo(1.506, 6)
  })

  it('halves the price off-peak', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0 }
    expect(costOfUsage('deepseek-chat', usage, peak)).toBeCloseTo(0.3, 6)
    expect(costOfUsage('deepseek-chat', usage, offPeak)).toBeCloseTo(0.15, 6)
  })

  it('returns null rather than inventing a price', () => {
    expect(costOfUsage('custom-endpoint-model', { promptTokens: 1, completionTokens: 1 }, peak)).toBeNull()
  })

  it('treats an un-split prompt as all misses', () => {
    expect(cacheSplit({ promptTokens: 500, completionTokens: 0 })).toEqual({ hit: 0, miss: 500 })
    // A recorded split wins over the derived one.
    expect(
      cacheSplit({ promptTokens: 500, completionTokens: 0, cacheHitTokens: 200, cacheMissTokens: 300 }),
    ).toEqual({ hit: 200, miss: 300 })
    // A hit count without a miss count derives the remainder.
    expect(cacheSplit({ promptTokens: 500, completionTokens: 0, cacheHitTokens: 200 })).toEqual({
      hit: 200,
      miss: 300,
    })
  })
})

describe('usage summary', () => {
  it('groups runs per model and flags the unpriced ones', () => {
    const summary = summarizeUsage([
      {
        model: 'deepseek-chat',
        startedAt: peak.toISOString(),
        promptTokens: 1_000_000,
        completionTokens: 0,
      },
      {
        model: 'deepseek-chat',
        startedAt: offPeak.toISOString(),
        promptTokens: 1_000_000,
        completionTokens: 0,
      },
      { startedAt: peak.toISOString(), promptTokens: 10, completionTokens: 5 },
      {
        model: 'private-model',
        startedAt: peak.toISOString(),
        promptTokens: 10,
        completionTokens: 5,
      },
    ])
    expect(summary.runs).toBe(4)
    expect(summary.promptTokens).toBe(2_000_020)
    expect(summary.rows).toHaveLength(3)
    expect(summary.unpricedModels).toEqual(['', 'private-model'])
    // 0.3 (peak) + 0.15 (off-peak); the two unpriced rows add nothing.
    expect(summary.estimatedCostUsd).toBeCloseTo(0.45, 6)
  })

  it('reports no estimate at all when nothing is priced', () => {
    const summary = summarizeUsage([
      { model: 'x', startedAt: peak.toISOString(), promptTokens: 5, completionTokens: 5 },
    ])
    expect(summary.estimatedCostUsd).toBeNull()
    expect(summary.unpricedModels).toEqual(['x'])
  })
})

describe('cost display currency', () => {
  it('follows the UI language: Chinese in RMB, exactly English in USD', () => {
    expect(costCurrencyFor('zh-CN')).toBe('CNY')
    expect(costCurrencyFor('zh')).toBe('CNY')
    expect(costCurrencyFor('en')).toBe('USD')
    expect(costCurrencyFor('en-US')).toBe('USD')
    // An unknown or missing locale keeps the yuan default instead of guessing.
    expect(costCurrencyFor('')).toBe('CNY')
    expect(costCurrencyFor(undefined)).toBe('CNY')
  })

  it('converts only for display, leaving the recorded USD figure untouched', () => {
    expect(convertCost(1, 'CNY')).toBeCloseTo(USD_CNY_RATE, 10)
    expect(convertCost(1, 'USD')).toBe(1)
    expect(convertCost(null, 'CNY')).toBeNull()
    expect(convertCost(Number.NaN, 'USD')).toBeNull()
  })

  it('formats the estimate with the symbol and decimals the amount needs', () => {
    expect(formatCostAmount(null)).toBe('—')
    expect(formatCostAmount(0)).toBe('¥0')
    expect(formatCostAmount(0, 'USD')).toBe('$0')
    expect(formatCostAmount(0.0012, 'USD')).toBe('$0.00120')
    expect(formatCostAmount(1.2394, 'USD')).toBe('$1.24')
    expect(formatCostAmount(0.0012, 'CNY')).toBe(`¥${(0.0012 * USD_CNY_RATE).toFixed(5)}`)
    expect(formatCostAmount(1.2394, 'CNY')).toBe(`¥${(1.2394 * USD_CNY_RATE).toFixed(2)}`)
  })
})

function store(overrides: Partial<BillingStore> = {}): BillingStore {
  return {
    getApiKey: () => 'sk-test',
    settings: () => ({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' }),
    workspaces: () => [{ path: 'E:/work' }],
    runs: () => [
      { model: 'deepseek-chat', startedAt: peak.toISOString(), promptTokens: 1, completionTokens: 1 },
    ],
    ...overrides,
  }
}

describe('balance lookup', () => {
  it('reads the provider payload and keeps the endpoint for traceability', async () => {
    const state = await fetchBalance({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [
              {
                currency: 'CNY',
                total_balance: '110.00',
                granted_balance: '10.00',
                topped_up_balance: '100.00',
              },
            ],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
      now: () => peak,
    })
    expect(state.ok).toBe(true)
    expect(state.available).toBe(true)
    expect(state.source).toBe('https://api.deepseek.com/user/balance')
    expect(state.entries[0]).toEqual({
      currency: 'CNY',
      totalBalance: '110.00',
      grantedBalance: '10.00',
      toppedUpBalance: '100.00',
    })
  })

  it('turns every failure into state instead of throwing', async () => {
    const missing = await fetchBalance({ apiKey: '  ', baseUrl: 'https://api.deepseek.com' })
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe('missing-key')

    const unauthorized = await fetchBalance({
      apiKey: 'sk-bad',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    })
    expect(unauthorized.error).toBe('unauthorized')

    const unsupported = await fetchBalance({
      apiKey: 'sk-test',
      baseUrl: 'https://proxy.example.com',
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    })
    expect(unsupported.error).toBe('unsupported')

    const network = await fetchBalance({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: (async () => {
        throw new TypeError('getaddrinfo ENOTFOUND')
      }) as unknown as typeof fetch,
    })
    expect(network.error).toBe('network')
    expect(network.errorDetail).toContain('ENOTFOUND')

    const garbage = await fetchBalance({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: (async () => new Response('{not json', { status: 200 })) as unknown as typeof fetch,
    })
    expect(garbage.error).toBe('invalid-response')

    const noEntries = await fetchBalance({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ is_available: true, balance_infos: [] }), {
          status: 200,
        })) as unknown as typeof fetch,
    })
    expect(noEntries.error).toBe('invalid-response')
  })

  it('flags a depleted account without failing the request', async () => {
    const state = await fetchBalance({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            is_available: false,
            balance_infos: [{ currency: 'CNY', total_balance: '0.00' }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    })
    expect(state.ok).toBe(true)
    expect(state.available).toBe(false)
    expect(state.entries[0]?.toppedUpBalance).toBe('')
  })
})

describe('provider-specific balance lookup', () => {
  it('detects GLM and Qwen from the host or model name', () => {
    expect(balanceFlavor('https://open.bigmodel.cn/api/paas/v4', 'glm-5.3')).toBe('glm')
    expect(balanceFlavor('https://api.z.ai/api/paas/v4', 'glm-5.3')).toBe('glm')
    expect(
      balanceFlavor('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max'),
    ).toBe('qwen')
    expect(balanceFlavor('https://api.deepseek.com', 'deepseek-chat')).toBe('deepseek')
    // An unknown relay keeps the DeepSeek-style endpoint even for a Qwen or
    // GLM model name; that is the convention relays actually implement.
    expect(balanceFlavor('https://example.com/v1', 'glm-5.3')).toBe('deepseek')
    expect(balanceFlavor('https://example.com/v1', 'qwen3.8-max')).toBe('deepseek')
  })

  it('reads the GLM account report with the raw console key', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const state = await fetchBalance({
      apiKey: 'glm-secret',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.3',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seenUrl = url
        seenAuth = String((init.headers as Record<string, string>).Authorization)
        return new Response(
          JSON.stringify({
            success: true,
            code: 200,
            data: {
              balance: '12.00',
              availableBalance: '10.50',
              giveAmount: '2.00',
              rechargeAmount: '100.00',
              totalSpendAmount: '89.50',
            },
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
    })
    expect(seenUrl).toBe(
      'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
    )
    expect(seenAuth).toBe('glm-secret')
    expect(state.ok).toBe(true)
    expect(state.available).toBe(true)
    expect(state.entries[0]).toEqual({
      currency: 'CNY',
      totalBalance: '10.50',
      grantedBalance: '2.00',
      toppedUpBalance: '100.00',
    })
  })

  it('falls back to the GLM legacy balance route', async () => {
    const calls: string[] = []
    const state = await fetchBalance({
      apiKey: 'glm-secret',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.3',
      fetchImpl: (async (url: string) => {
        calls.push(url)
        if (calls.length === 1) return new Response('', { status: 404 })
        return new Response(
          JSON.stringify({ data: { total_balance: '5.00', available_balance: '4.00' } }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
    })
    expect(calls).toHaveLength(2)
    expect(state.ok).toBe(true)
    expect(state.source).toBe('https://open.bigmodel.cn/api/paas/v4/balance')
    expect(state.entries[0]?.totalBalance).toBe('4.00')
  })

  it('explains that an official DashScope key has no balance API', async () => {
    const state = await fetchBalance({
      apiKey: 'qwen-secret',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-max',
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    })
    expect(state.ok).toBe(false)
    expect(state.error).toBe('unsupported')
    expect(state.errorDetail).toContain('DashScope')
    expect(state.errorDetail).toContain('AccessKey')
  })

  it('still reads a relay that exposes the DeepSeek-style route for Qwen', async () => {
    const state = await fetchBalance({
      apiKey: 'relay-secret',
      baseUrl: 'https://relay.example.com/v1',
      model: 'qwen3.8-max',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: 'CNY', total_balance: '8.00' }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    })
    expect(state.ok).toBe(true)
    expect(state.entries[0]?.totalBalance).toBe('8.00')
  })

  it('never repeats the key in an error detail', async () => {
    const state = await fetchBalance({
      apiKey: 'glm-secret',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.3',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ success: false, code: 500, msg: 'rejected glm-secret' }),
          { status: 200 },
        )) as unknown as typeof fetch,
    })
    expect(state.ok).toBe(false)
    expect(state.errorDetail).not.toContain('glm-secret')
    expect(state.errorDetail).toContain('[redacted]')
  })
})

describe('billing service', () => {
  it('caches the balance until a refresh is asked for', async () => {
    let calls = 0
    const service = new BillingService({
      store: store(),
      fetchImpl: (async () => {
        calls += 1
        return new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: 'CNY', total_balance: '5.00' }],
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
    })
    await service.report()
    await service.report()
    expect(calls).toBe(1)
    await service.report(true)
    expect(calls).toBe(2)
    service.invalidate()
    await service.report()
    expect(calls).toBe(3)
  })

  it('builds a report even when the key is missing', async () => {
    const service = new BillingService({ store: store({ getApiKey: () => null }) })
    const report = await service.report()
    expect(report.hasKey).toBe(false)
    expect(report.balance.error).toBe('missing-key')
    expect(report.usage.runs).toBe(1)
    expect(report.priceSource).toContain('deepseek.com')
  })

  it('never leaks the key into the report', async () => {
    const service = new BillingService({
      store: store(),
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    })
    const serialized = JSON.stringify(await service.report())
    expect(serialized).not.toContain('sk-test')
  })

  it('reports the balance of every configured model, reviewers included', async () => {
    const accounts = [
      {
        id: 'primary',
        label: '',
        role: 'primary' as const,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        enabled: true,
        apiKey: 'sk-test',
      },
      {
        id: 'judge-1',
        label: 'GLM 评审',
        role: 'judge' as const,
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-5.3',
        enabled: false,
        apiKey: 'glm-secret',
      },
      {
        id: 'judge-2',
        label: '备用评审',
        role: 'judge' as const,
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        enabled: true,
        apiKey: '',
      },
    ]
    let calls = 0
    const service = new BillingService({
      store: store({ billingAccounts: () => accounts }),
      fetchImpl: (async (url: string) => {
        calls += 1
        if (String(url).includes('bigmodel')) {
          return new Response(
            JSON.stringify({ success: true, data: { availableBalance: '9.00' } }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: 'CNY', total_balance: '5.00' }],
          }),
          { status: 200 },
        )
      }) as unknown as typeof fetch,
    })

    const report = await service.report()
    expect(report.accounts).toHaveLength(3)
    expect(report.accounts?.[0]).toMatchObject({ id: 'primary', role: 'primary' })
    expect(report.accounts?.[0]?.balance.entries[0]?.totalBalance).toBe('5.00')
    expect(report.accounts?.[1]).toMatchObject({
      id: 'judge-1',
      role: 'judge',
      label: 'GLM 评审',
      enabled: false,
    })
    expect(report.accounts?.[1]?.balance.entries[0]?.totalBalance).toBe('9.00')
    // A reviewer without a saved key is reported, not skipped or fetched.
    expect(report.accounts?.[2]?.balance.error).toBe('missing-key')
    expect(calls).toBe(2)

    // Reviewer balances are cached like the primary one, and a refresh clears it.
    await service.report()
    expect(calls).toBe(2)
    await service.report(true)
    expect(calls).toBe(4)

    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('sk-test')
    expect(serialized).not.toContain('glm-secret')
  })
})
