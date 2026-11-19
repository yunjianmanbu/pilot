import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  PluginCreateResult,
  PluginOverview,
  PluginRecordView,
  PluginSignatureState,
  PluginTemplateId,
  WorkspaceSummary,
} from '../../../shared/types'
import {
  CheckIcon,
  DownloadIcon,
  FolderIcon,
  LayersIcon,
  PlusIcon,
  RefreshIcon,
  SparkIcon,
  TrashIcon,
  WrenchIcon,
} from '../icons'
import { t } from '../i18n'
import { SelectMenu } from './SelectMenu'

/**
 * Plugin market and plugin assistant.
 *
 * Three tabs, one data source: `window.pilot.plugins.overview(workspace)`
 * returns the installed plugins, the bundled market, the workspace trust store
 * and the signature policy in a single call, so switching tabs never re-fetches.
 */

type Tab = 'market' | 'installed' | 'assistant'

/**
 * The four states are translated through literal `t()` calls so the English
 * dictionary covers them; a lookup table would fall back to Chinese there.
 */
function signatureLabel(state: PluginSignatureState): string {
  if (state === 'trusted') return t("签名可信")
  if (state === 'untrusted') return t("来源未知")
  if (state === 'tampered') return t("签名后改过")
  if (state === 'malformed') return t("签名文件损坏")
  return t("未签名")
}

const SIGNATURE_TONE: Record<PluginSignatureState, string> = {
  unsigned: 'warn',
  trusted: 'ok',
  untrusted: 'warn',
  tampered: 'bad',
  malformed: 'bad',
}

const CATEGORY_LABEL: Record<string, string> = {
  business: '业务',
  data: '数据',
  identity: '身份',
  ops: '运营',
}

function emptyOverview(workspace: string): PluginOverview {
  return {
    workspace,
    pluginsDir: '',
    plugins: [],
    invalid: [],
    market: [],
    trustedKeys: [],
    policy: 'warn',
    templates: [],
    maxPlugins: 16,
  }
}

function shortKey(keyId: string | null): string {
  if (!keyId) return '—'
  return keyId.replace(/^ed25519-/, '').slice(0, 8)
}

export function PluginsPanel({ workspace }: { workspace: WorkspaceSummary | null }) {
  const [tab, setTab] = useState<Tab>('market')
  const [overview, setOverview] = useState<PluginOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Assistant form state.
  const [targetDir, setTargetDir] = useState('')
  const [template, setTemplate] = useState<PluginTemplateId>('http')
  const [pluginId, setPluginId] = useState('')
  const [pluginName, setPluginName] = useState('')
  const [pluginDescription, setPluginDescription] = useState('')
  const [signOnCreate, setSignOnCreate] = useState(true)
  const [created, setCreated] = useState<PluginCreateResult | null>(null)

  // Trust store input.
  const [pastedKey, setPastedKey] = useState('')
  const [keyLabel, setKeyLabel] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspace) {
      setOverview(null)
      return
    }
    setLoading(true)
    setError('')
    try {
      setOverview(await window.pilot.plugins.overview(workspace.path))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [workspace])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const off = window.pilot.onEvent((event) => {
      if (event.type === 'plugins.changed') void refresh()
    })
    return off
  }, [refresh])

  const act = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(key)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy('')
    }
  }

  const data = overview ?? emptyOverview(workspace?.path ?? '')
  const installedCount = data.plugins.length
  const enabledCount = data.plugins.filter((plugin) => plugin.enabled).length
  const trustedCount = data.trustedKeys.length

  const templateOptions = useMemo(
    () => data.templates.map((item) => ({ value: item.id, label: item.name })),
    [data.templates],
  )
  const policyOptions = useMemo(
    () => [
      { value: 'off', label: t("off：只记录，不提示") },
      { value: 'warn', label: t("warn：未签名给警告（默认）") },
      { value: 'required', label: t("required：拒绝未信任的插件") },
    ],
    [],
  )

  const chosenTemplate = data.templates.find((item) => item.id === template)

  const pickTargetDir = async (): Promise<void> => {
    const picked = await window.pilot.plugins.pickDir(t("选择插件创建目录"))
    if (!picked) return
    setTargetDir(picked)
    // Default the id to the folder name so the form is usable in one click.
    if (!pluginId) {
      const guess = picked.split(/[\\/]/).filter(Boolean).pop() ?? ''
      if (/^[a-z][a-z0-9-]{1,31}$/.test(guess)) setPluginId(guess)
    }
  }

  const create = async (): Promise<void> => {
    await act('create', async () => {
      const result = await window.pilot.plugins.create({
        targetDir,
        id: pluginId,
        name: pluginName,
        description: pluginDescription,
        template,
        sign: signOnCreate,
      })
      setCreated(result)
      setNotice(
        t("已在 {v1} 生成插件「{v2}」，共 {v3} 个文件。", {
          v1: result.dir,
          v2: pluginName,
          v3: result.files.length,
        }),
      )
    })
  }

  const installCreated = async (): Promise<void> => {
    if (!workspace || !created) return
    await act('install-created', async () => {
      await window.pilot.plugins.install(workspace.path, {
        sourceDir: created.dir,
        trust: created.publicKey !== null,
        publicKey: created.publicKey ?? undefined,
        label: `${pluginName}（本机创建）`,
      })
      setNotice(t("已安装到工作区并启用授权流程。回到「已安装」标签勾选启用。"))
      setTab('installed')
      await refresh()
    })
  }

  const installMarket = async (id: string): Promise<void> => {
    if (!workspace) return
    await act(`market:${id}`, async () => {
      await window.pilot.plugins.installMarket(workspace.path, id)
      setNotice(t("已安装 {v1}，并用本机密钥签名、加入信任库。", { v1: id }))
      await refresh()
    })
  }

  const toggle = async (plugin: PluginRecordView): Promise<void> => {
    if (!workspace) return
    await act(`toggle:${plugin.id}`, async () => {
      setOverview(await window.pilot.plugins.setEnabled(workspace.path, plugin.id, !plugin.enabled))
    })
  }

  const sign = async (plugin: PluginRecordView): Promise<void> => {
    if (!workspace) return
    await act(`sign:${plugin.id}`, async () => {
      await window.pilot.plugins.sign(workspace.path, plugin.id)
      setNotice(t("已用工作区密钥签名，并把公钥加入信任库。"))
      await refresh()
    })
  }

  const remove = async (plugin: PluginRecordView): Promise<void> => {
    if (!workspace) return
    if (!window.confirm(t("删除插件「{v1}」及其目录？这个操作不可撤销。", { v1: plugin.name }))) return
    await act(`remove:${plugin.id}`, async () => {
      setOverview(await window.pilot.plugins.remove(workspace.path, plugin.id))
      setNotice(t("已删除 {v1}。", { v1: plugin.id }))
    })
  }

  const trust = async (): Promise<void> => {
    if (!workspace) return
    await act('trust', async () => {
      setOverview(
        await window.pilot.plugins.trust(workspace.path, pastedKey, keyLabel.trim() || undefined),
      )
      setPastedKey('')
      setKeyLabel('')
      setNotice(t("已把该公钥加入信任库。"))
    })
  }

  const untrust = async (keyId: string): Promise<void> => {
    if (!workspace) return
    await act(`untrust:${keyId}`, async () => {
      setOverview(await window.pilot.plugins.untrust(workspace.path, keyId))
      setNotice(t("已移出信任库；用它签名的插件会回到「来源未知」。"))
    })
  }

  const changePolicy = async (policy: string): Promise<void> => {
    if (!workspace) return
    await act('policy', async () => {
      setOverview(
        await window.pilot.plugins.setPolicy(
          workspace.path,
          policy as PluginOverview['policy'],
        ),
      )
    })
  }

  if (!workspace) {
    return (
      <div className="page panel-page plugins-page">
        <div className="page-head">
          <div>
            <div className="page-eyebrow">
              <LayersIcon width={13} height={13} />
              {t("能力扩展")}
            </div>
            <h1>{t("插件")}</h1>
            <p>{t("插件安装在工作区里，因此需要一个工作区才能浏览、安装和创建。")}</p>
          </div>
        </div>
        <div className="empty-panel">
          <LayersIcon width={30} height={30} />
          <strong>{t("还没有选择工作区")}</strong>
          <span>{t("选择一个工作区后，这里会显示可安装的插件市场、已安装插件和插件助手。")}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="page panel-page plugins-page">
      <div className="page-head">
        <div>
          <div className="page-eyebrow">
            <LayersIcon width={13} height={13} />
            {t("能力扩展")}
          </div>
          <h1>{t("插件市场与插件助手")}</h1>
          <p>
            {t("插件独立进程运行，能访问 HTTP 路由、声明权限并参与登录。安装位置固定为 {v1}；插件助手可以把你自己的插件写到任意一个你选的目录，再导入这里。", {
              v1: '.pilot/plugins/<id>/',
            })}
          </p>
        </div>
        <div className="stat-strip">
          <div className="stat">
            <strong>{installedCount}</strong>
            <span>{t("个已安装")}</span>
          </div>
          <div className="stat">
            <strong>{enabledCount}</strong>
            <span>{t("个已启用")}</span>
          </div>
          <div className="stat">
            <strong>{trustedCount}</strong>
            <span>{t("个信任密钥")}</span>
          </div>
        </div>
      </div>

      <div className="plugins-tabs" role="tablist" aria-label={t("插件视图")}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'market'}
          className={`plugins-tab${tab === 'market' ? ' is-active' : ''}`}
          onClick={() => setTab('market')}
        >
          <DownloadIcon width={15} height={15} />
          {t("市场")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'installed'}
          className={`plugins-tab${tab === 'installed' ? ' is-active' : ''}`}
          onClick={() => setTab('installed')}
        >
          <WrenchIcon width={15} height={15} />
          {t("已安装")}
          {installedCount > 0 ? <span className="plugins-tab-badge">{installedCount}</span> : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'assistant'}
          className={`plugins-tab${tab === 'assistant' ? ' is-active' : ''}`}
          onClick={() => setTab('assistant')}
        >
          <SparkIcon width={15} height={15} />
          {t("插件助手")}
        </button>
        <button
          type="button"
          className="plugins-refresh"
          title={t("重新读取插件目录")}
          aria-label={t("刷新")}
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshIcon width={14} height={14} />
        </button>
      </div>

      {error ? <div className="tools-error plugins-alert">{error}</div> : null}
      {notice ? (
        <div className="tools-note plugins-notice">
          <CheckIcon width={13} height={13} /> {notice}
        </div>
      ) : null}

      {tab === 'market' ? (
        <section className="plugins-section">
          <div className="plugins-grid">
            {data.market.map((item) => {
              const working = busy === `market:${item.id}`
              return (
                <article className="plugins-card" key={item.id}>
                  <div className="plugins-card-head">
                    <div>
                      <h3>{item.name}</h3>
                      <div className="plugins-meta">
                        <span className="tools-chip">{CATEGORY_LABEL[item.category] ?? item.category}</span>
                        <span className="tools-chip">v{item.version}</span>
                        <span className="tools-chip">{item.routeCount} 个路由</span>
                        {item.installed ? (
                          <span className="tools-chip ok">{t("已安装")}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <p className="plugins-summary">{item.summary}</p>
                  <div className="plugins-facts">
                    <div>
                      <span>{t("权限")}</span>
                      <code>{item.permissions.length ? item.permissions.join(', ') : t("无")}</code>
                    </div>
                    <div>
                      <span>{t("来源")}</span>
                      <code>{item.publisher}</code>
                    </div>
                  </div>
                  <div className="plugins-actions">
                    <button
                      type="button"
                      className="button primary"
                      disabled={item.installed || working}
                      onClick={() => void installMarket(item.id)}
                    >
                      {item.installed ? t("已安装") : working ? t("安装中…") : t("安装")}
                    </button>
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => {
                        setTab('assistant')
                        setPluginId(item.id)
                        setPluginName(item.name)
                        setTemplate(item.template)
                        setPluginDescription(item.summary)
                      }}
                    >
                      {t("用这个模板自己改")}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
          <div className="tools-note">
            {t("市场列表内置在应用里，不需要联网；安装时用本工作区的密钥签名并加入信任库，所以你随时能核对文件有没有被改。")}
          </div>
        </section>
      ) : null}

      {tab === 'installed' ? (
        <section className="plugins-section">
          <div className="plugins-toolbar">
            <div className="plugins-toolbar-field">
              <span className="field-label">{t("签名策略")}</span>
              <SelectMenu
                value={data.policy}
                options={policyOptions}
                onChange={(value) => void changePolicy(value)}
                ariaLabel={t("签名策略")}
              />
            </div>
            <button
              type="button"
              className="button ghost"
              onClick={() => void window.pilot.plugins.reveal(data.pluginsDir)}
            >
              <FolderIcon width={14} height={14} />
              {t("打开插件目录")}
            </button>
          </div>

          {data.invalid.length > 0 ? (
            <div className="plugins-invalid">
              <strong>{t("这些目录没能通过清单校验")}</strong>
              <ul>
                {data.invalid.map((entry) => (
                  <li key={entry.id}>
                    <code>{entry.id}</code> {entry.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {loading && data.plugins.length === 0 ? (
            <div className="session-loading-view">
              <i className="spinner" />
              <span>{t("读取插件…")}</span>
            </div>
          ) : data.plugins.length === 0 ? (
            <div className="empty-panel">
              <LayersIcon width={30} height={30} />
              <strong>{t("还没有安装插件")}</strong>
              <span>{t("从「市场」装一个，或用「插件助手」把自己的插件生成到某个目录后导入。")}</span>
            </div>
          ) : (
            <div className="tools-list">
              {data.plugins.map((plugin) => {
                const state = plugin.signature?.state ?? 'unsigned'
                return (
                  <article className="tools-card plugins-card" key={plugin.id}>
                    <div className="tools-card-head">
                      <div>
                        <h3>
                          {plugin.name} <span className="plugins-id">{plugin.id}</span>
                        </h3>
                        <div className="tools-meta">
                          <span className={`tools-chip ${SIGNATURE_TONE[state]}`}>
                            {signatureLabel(state)}
                          </span>
                          <span className={`tools-chip ${plugin.enabled ? 'ok' : 'warn'}`}>
                            {plugin.enabled ? t("已启用") : t("未启用")}
                          </span>
                          <span className="tools-chip">
                            {t("签名密钥")} {shortKey(plugin.signature?.keyId ?? null)}
                          </span>
                          {plugin.providesSession ? (
                            <span className="tools-chip source-workspace">{t("身份提供者")}</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="tools-actions">
                        <button
                          type="button"
                          className={`button ${plugin.enabled ? 'ghost' : 'primary'}`}
                          disabled={busy === `toggle:${plugin.id}`}
                          onClick={() => void toggle(plugin)}
                        >
                          {plugin.enabled ? t("停用") : t("启用")}
                        </button>
                        <button
                          type="button"
                          className="button ghost"
                          disabled={busy === `sign:${plugin.id}`}
                          onClick={() => void sign(plugin)}
                        >
                          {t("重新签名")}
                        </button>
                        <button
                          type="button"
                          className="button ghost"
                          onClick={() => void window.pilot.plugins.reveal(plugin.dir)}
                        >
                          <FolderIcon width={14} height={14} />
                        </button>
                        <button
                          type="button"
                          className="button danger"
                          disabled={busy === `remove:${plugin.id}`}
                          onClick={() => void remove(plugin)}
                        >
                          <TrashIcon width={14} height={14} />
                        </button>
                      </div>
                    </div>
                    {plugin.description ? (
                      <p className="tools-description">{plugin.description}</p>
                    ) : null}
                    <div className="plugins-facts">
                      <div>
                        <span>{t("入口")}</span>
                        <code>{plugin.entry}</code>
                      </div>
                      <div>
                        <span>{t("权限")}</span>
                        <code>{plugin.permissions.length ? plugin.permissions.join(', ') : t("无")}</code>
                      </div>
                      <div>
                        <span>{t("路由")}</span>
                        <code>
                          {plugin.routes.length
                            ? plugin.routes
                                .map((route) => `${route.method} ${route.path}`)
                                .join(' · ')
                            : t("无")}
                        </code>
                      </div>
                    </div>
                    {plugin.signature ? (
                      <div className="plugins-signature">{plugin.signature.detail}</div>
                    ) : null}
                    <div className="plugins-dir">{plugin.dir}</div>
                  </article>
                )
              })}
            </div>
          )}

          <div className="plugins-keys">
            <h3>{t("信任的签名密钥")}</h3>
            {data.trustedKeys.length === 0 ? (
              <p className="plugins-keys-empty">
                {t("还没有信任任何密钥。未签名的插件在本机可以运行，但状态会显示为「未签名」。")}
              </p>
            ) : (
              <ul className="plugins-key-list">
                {data.trustedKeys.map((key) => (
                  <li key={key.keyId}>
                    <div>
                      <strong>{key.label}</strong>
                      <code>{key.keyId}</code>
                      <span>
                        {key.pluginIds.length > 0
                          ? t("签名了 {v1}", { v1: key.pluginIds.join(', ') })
                          : t("当前没有插件使用它")}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button ghost"
                      disabled={busy === `untrust:${key.keyId}`}
                      onClick={() => void untrust(key.keyId)}
                    >
                      {t("移出信任")}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="plugins-trust-form">
              <label className="settings-field wide">
                <span className="field-label">{t("公钥（PEM）")}</span>
                <textarea
                  className="text-input plugins-key-input"
                  rows={3}
                  value={pastedKey}
                  placeholder={'-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----'}
                  onChange={(event) => setPastedKey(event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span className="field-label">{t("备注名")}</span>
                <input
                  className="text-input"
                  value={keyLabel}
                  placeholder={t("例如：供应商甲 2026")}
                  onChange={(event) => setKeyLabel(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="button primary"
                disabled={!pastedKey.trim() || busy === 'trust'}
                onClick={() => void trust()}
              >
                {t("信任这个公钥")}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {tab === 'assistant' ? (
        <section className="plugins-section plugins-assistant">
          <div className="plugins-steps">
            <div className="plugins-step">
              <span>1</span>
              <div>
                <strong>{t("选目录")}</strong>
                <p>{t("插件代码写到你自己选的文件夹，必须是空目录或还不存在。")}</p>
              </div>
            </div>
            <div className="plugins-step">
              <span>2</span>
              <div>
                <strong>{t("选模板并命名")}</strong>
                <p>{t("生成 plugin.json、入口文件、README 和 .gitignore。")}</p>
              </div>
            </div>
            <div className="plugins-step">
              <span>3</span>
              <div>
                <strong>{t("签名与导入")}</strong>
                <p>{t("可选地生成自己的密钥并签名，然后一键导入当前工作区。")}</p>
              </div>
            </div>
          </div>

          <div className="plugins-form">
            <div className="settings-field wide">
              <span className="field-label">
                {t("创建目录")}
                <small>{t("插件会写在这个目录里")}</small>
              </span>
              <div className="plugins-path-row">
                <input
                  className="text-input"
                  value={targetDir}
                  placeholder={t("例如：D:\\work\\my-plugin")}
                  onChange={(event) => setTargetDir(event.target.value)}
                />
                <button type="button" className="button ghost" onClick={() => void pickTargetDir()}>
                  <FolderIcon width={14} height={14} />
                  {t("选择目录")}
                </button>
              </div>
            </div>

            <label className="settings-field">
              <span className="field-label">{t("插件 id")}</span>
              <input
                className="text-input"
                value={pluginId}
                placeholder="my-plugin"
                onChange={(event) => setPluginId(event.target.value)}
              />
            </label>
            <label className="settings-field">
              <span className="field-label">{t("显示名称")}</span>
              <input
                className="text-input"
                value={pluginName}
                placeholder={t("我的业务插件")}
                onChange={(event) => setPluginName(event.target.value)}
              />
            </label>

            <div className="settings-field">
              <span className="field-label">{t("模板")}</span>
              <SelectMenu
                value={template}
                options={templateOptions}
                onChange={(value) => setTemplate(value as PluginTemplateId)}
                ariaLabel={t("插件模板")}
              />
            </div>
            <label className="settings-field">
              <span className="field-label">{t("生成后签名")}</span>
              <span className="plugins-checkbox">
                <input
                  type="checkbox"
                  checked={signOnCreate}
                  onChange={(event) => setSignOnCreate(event.target.checked)}
                />
                {t("在 .keys/ 里生成 ed25519 密钥对并写入 plugin.sig")}
              </span>
            </label>

            <label className="settings-field wide">
              <span className="field-label">{t("说明")}</span>
              <textarea
                className="text-input"
                rows={2}
                value={pluginDescription}
                placeholder={t("一句话说明这个插件解决什么问题")}
                onChange={(event) => setPluginDescription(event.target.value)}
              />
            </label>

            {chosenTemplate ? (
              <div className="plugins-template-hint">
                <strong>{chosenTemplate.name}</strong>
                <p>{chosenTemplate.summary}</p>
                <div className="plugins-facts">
                  <div>
                    <span>{t("权限")}</span>
                    <code>
                      {chosenTemplate.permissions.length
                        ? chosenTemplate.permissions.join(', ')
                        : t("无")}
                    </code>
                  </div>
                  <div>
                    <span>{t("路由")}</span>
                    <code>{chosenTemplate.routeCount} 个</code>
                  </div>
                  <div>
                    <span>{t("身份提供者")}</span>
                    <code>{chosenTemplate.providesSession ? t("是") : t("否")}</code>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="plugins-form-actions">
              <button
                type="button"
                className="button primary"
                disabled={!targetDir.trim() || !pluginId.trim() || !pluginName.trim() || busy === 'create'}
                onClick={() => void create()}
              >
                <PlusIcon width={14} height={14} />
                {busy === 'create' ? t("生成中…") : t("生成插件")}
              </button>
              <span className="plugins-form-hint">
                {t("不会改动已有文件：目录非空时会直接报错。")}
              </span>
            </div>
          </div>

          {created ? (
            <div className="plugins-result">
              <h3>{t("已生成")}</h3>
              <div className="plugins-facts">
                <div>
                  <span>{t("目录")}</span>
                  <code>{created.dir}</code>
                </div>
                <div>
                  <span>{t("文件")}</span>
                  <code>{created.files.join(', ')}</code>
                </div>
                <div>
                  <span>{t("签名密钥")}</span>
                  <code>{created.keyId ? `${created.keyId}（未加入信任库）` : t("未签名")}</code>
                </div>
              </div>
              {created.publicKey ? (
                <label className="settings-field wide">
                  <span className="field-label">
                    {t("公钥")}
                    <small>{t("分发给客户时贴这个")}</small>
                  </span>
                  <textarea
                    className="text-input plugins-key-input"
                    rows={4}
                    readOnly
                    value={created.publicKey}
                  />
                </label>
              ) : null}
              <div className="plugins-actions">
                <button
                  type="button"
                  className="button primary"
                  disabled={busy === 'install-created'}
                  onClick={() => void installCreated()}
                >
                  {t("导入当前工作区")}
                </button>
                <button
                  type="button"
                  className="button ghost"
                  onClick={() => void window.pilot.plugins.reveal(created.dir)}
                >
                  <FolderIcon width={14} height={14} />
                  {t("打开目录")}
                </button>
              </div>
            </div>
          ) : null}

          <div className="tools-note">
            {t("插件在独立子进程里运行，只通过逐行 JSON-RPC 与宿主通信；启用时你会看到它声明的全部权限。签名只能证明文件没被改过，不是沙箱。")}
          </div>
        </section>
      ) : null}
    </div>
  )
}
