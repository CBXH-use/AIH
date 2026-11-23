import { useMemo, useState } from 'react'
import { Download, Info, Package, RefreshCw, Search, ShieldCheck, Trash2 } from 'lucide-react'
import type { PluginCategory } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { Badge, PageHeader, Spinner, Switch } from '../components/ui'

const CATS: { key: 'all' | PluginCategory; label: string }[] = [
  { key: 'all', label: 'plugins.all' },
  { key: 'tools', label: 'plugins.tools' },
  { key: 'agents', label: 'plugins.agents' },
  { key: 'skills', label: 'plugins.skills' },
  { key: 'mcp', label: 'plugins.mcp' }
]

export function PluginsPage() {
  const t = useT()
  const plugins = useAppStore((s) => s.plugins)
  const states = useAppStore((s) => s.pluginStates)
  const settings = useAppStore((s) => s.settings)
  const setPage = useAppStore((s) => s.setPage)
  const refreshing = useAppStore((s) => s.pluginRefreshing)
  const installPlugin = useAppStore((s) => s.installPlugin)
  const uninstallPlugin = useAppStore((s) => s.uninstallPlugin)
  const togglePlugin = useAppStore((s) => s.togglePlugin)
  const refreshCatalog = useAppStore((s) => s.refreshPluginCatalog)
  const [category, setCategory] = useState<'all' | PluginCategory>('all')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const stateOf = (id: string) => states.find((s) => s.manifestId === id)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return plugins
      .filter((p) => category === 'all' || p.category === category)
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q) ||
          p.tags.some((tag) => tag.toLowerCase().includes(q))
      )
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
  }, [plugins, category, query])

  const install = async (id: string) => {
    setBusy(id)
    await installPlugin(id)
    setBusy(null)
  }

  return (
    <div className="page">
      <PageHeader
        title={t('plugins.title')}
        subtitle={t('plugins.subtitle')}
        actions={
          <button className="btn ghost" onClick={() => void refreshCatalog()} disabled={refreshing}>
            {refreshing ? <Spinner size={13} /> : <RefreshCw size={14} />} {t('common.refresh')}
          </button>
        }
      />

      <div className="toolbar">
        <div className="tab-row">
          {CATS.map((c) => (
            <button key={c.key} className={`tab ${category === c.key ? 'active' : ''}`} onClick={() => setCategory(c.key)}>
              {t(c.label)}
            </button>
          ))}
        </div>
        <div className="search-box">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('plugins.search')} />
        </div>
      </div>

      <div className="safety-strip">
        <ShieldCheck size={15} />
        <span>{t('plugins.safetyNote')}</span>
      </div>

      <div className="catalog-source">
        <Info size={15} />
        <div>
          <strong>{t('plugins.catalogSource')}</strong>
          <span>
            {settings.pluginCatalogUrl?.trim()
              ? t('plugins.sourceRemote', { url: settings.pluginCatalogUrl })
              : t('plugins.sourceBuiltin')}
          </span>
          <em>{t('plugins.sourceHint')}</em>
        </div>
        <button className="link-btn" onClick={() => setPage('settings')}>
          {t('plugins.openSettings')} →
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-strip">
          <Package size={18} />
          <span>{t('plugins.empty')}</span>
        </div>
      ) : (
        <div className="plugin-grid">
          {filtered.map((p) => {
            const state = stateOf(p.id)
            const installed = !!state?.installed
            const enabled = !!state?.enabled
            const counts = [
              p.tools?.length ? t('plugins.toolsCount', { n: p.tools.length }) : '',
              p.agents?.length ? t('plugins.agentsCount', { n: p.agents.length }) : '',
              p.skills?.length ? t('plugins.skillsCount', { n: p.skills.length }) : ''
            ].filter(Boolean)
            return (
              <div className={`plugin-card ${installed ? 'installed' : ''}`} key={p.id}>
                <div className="plugin-top">
                  <div className="plugin-icon">{p.icon}</div>
                  <div className="plugin-title">
                    <div className="plugin-name-row">
                      <strong>{p.name}</strong>
                      <span className="version">v{p.version}</span>
                      {installed && <span className="badge green tiny">{t('common.installed')}</span>}
                    </div>
                    <span className="plugin-author">
                      {t('plugins.by', { name: p.author })} · {t('plugins.downloads', { n: (p.downloads || 0).toLocaleString() })}
                    </span>
                  </div>
                  <Badge tone={p.category === 'mcp' ? 'blue' : p.category === 'tools' ? 'green' : 'neutral'}>
                    {t(`plugins.${p.category}`)}
                  </Badge>
                </div>

                <p className="plugin-desc">{p.description}</p>

                <div className="plugin-tags">
                  {p.tags.slice(0, 4).map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                  {counts.map((c) => (
                    <span className="tag muted-tag" key={c}>
                      {c}
                    </span>
                  ))}
                </div>

                {p.installType === 'mcp' && p.mcp && (
                  <div className="plugin-mcp-cmd">
                    <ShieldCheck size={12} />
                    <code>{[p.mcp.command, ...(p.mcp.args || [])].join(' ')}</code>
                  </div>
                )}

                {state?.runtime === 'error' && (
                  <div className="plugin-error">
                    <span>{state.error || t('plugins.mcpError')}</span>
                    <button className="link-btn" onClick={() => void togglePlugin(p.id, true)}>
                      {t('plugins.retryMcp')}
                    </button>
                  </div>
                )}

                <div className="plugin-foot">
                  <span className="plugin-source">
                    {p.installType === 'mcp' && <span className="badge blue tiny">MCP</span>}
                    {p.installType === 'declarative' && <span className="badge neutral tiny">HTTP</span>}
                  </span>
                  <span className="spacer" />
                  {!installed ? (
                    <button className="btn primary sm" onClick={() => void install(p.id)} disabled={busy === p.id}>
                      {busy === p.id ? <Spinner size={12} /> : <Download size={12} />} {t('plugins.install')}
                    </button>
                  ) : (
                    <>
                      <button
                        className="icon-btn sm danger-hover"
                        title={t('common.uninstall')}
                        onClick={() => {
                          if (window.confirm(t('plugins.uninstallConfirm'))) void uninstallPlugin(p.id)
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                      <Switch checked={enabled} onChange={(v) => void togglePlugin(p.id, v)} />
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
