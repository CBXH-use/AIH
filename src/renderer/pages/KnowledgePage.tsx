import { useEffect, useState } from 'react'
import { BookOpen, Download, FileUp, Plus, Search, Trash2, Upload } from 'lucide-react'
import type { CatalogKnowledgeBase, KnowledgeHit } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { Badge, EmptyState, Modal, PageHeader, Spinner } from '../components/ui'

function fmt(bytes: number): string {
  if (!bytes) return '0 KB'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

export function KnowledgePage() {
  const t = useT()
  const knowledge = useAppStore((s) => s.knowledge)
  const currentSession = useAppStore((s) => s.sessions.find((x) => x.id === s.currentId) || null)
  const createKnowledge = useAppStore((s) => s.createKnowledge)
  const importKnowledge = useAppStore((s) => s.importKnowledge)
  const deleteKnowledge = useAppStore((s) => s.deleteKnowledge)
  const searchKnowledge = useAppStore((s) => s.searchKnowledge)
  const installCatalogKnowledge = useAppStore((s) => s.installCatalogKnowledge)
  const exportTraining = useAppStore((s) => s.exportTraining)
  const attachKnowledge = useAppStore((s) => s.attachKnowledge)
  const toast = useAppStore((s) => s.toast)

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CatalogKnowledgeBase[]>([])
  const [catalogOnline, setCatalogOnline] = useState(true)
  const [installingCatalog, setInstallingCatalog] = useState<string | null>(null)
  const [queries, setQueries] = useState<Record<string, string>>({})
  const [results, setResults] = useState<Record<string, KnowledgeHit[]>>({})
  const [searching, setSearching] = useState<string | null>(null)

  useEffect(() => {
    void window.aih.knowledgeCatalog().then((res) => {
      setCatalog(res.bases)
      setCatalogOnline(res.online)
    })
  }, [])

  const create = async () => {
    if (!name.trim()) return
    const kb = await createKnowledge(name.trim(), desc.trim())
    if (kb) {
      setCreateOpen(false)
      setName('')
      setDesc('')
    }
  }

  const doSearch = async (id: string) => {
    const q = queries[id]?.trim()
    if (!q) return
    setSearching(id)
    try {
      const hits = await searchKnowledge(id, q)
      setResults((prev) => ({ ...prev, [id]: hits }))
    } finally {
      setSearching(null)
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={t('knowledge.title')}
        subtitle={t('knowledge.subtitle')}
        actions={
          <button className="btn primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> {t('knowledge.create')}
          </button>
        }
      />

      {knowledge.length === 0 ? (
        <EmptyState
          icon={<BookOpen size={22} />}
          title={t('knowledge.empty')}
          hint={t('knowledge.emptyHint')}
          action={
            <button className="btn primary" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> {t('knowledge.create')}
            </button>
          }
        />
      ) : (
        <div className="kb-list">
          {knowledge.map((kb) => {
            const attached = currentSession?.knowledgeBaseIds?.includes(kb.id)
            return (
              <div className="kb-card" key={kb.id}>
                <div className="kb-head">
                  <div className="kb-icon">
                    <BookOpen size={17} />
                  </div>
                  <div className="kb-title">
                    <div className="kb-name-row">
                      <strong>{kb.name}</strong>
                      {attached && <Badge tone="green">{t('knowledge.attachedCurrent')}</Badge>}
                    </div>
                    <span>{kb.description || t('knowledge.emptyHint')}</span>
                  </div>
                  <div className="kb-stats">
                    <div>
                      <strong>{kb.docs.length}</strong>
                      <span>{t('knowledge.docs', { n: kb.docs.length })}</span>
                    </div>
                    <div>
                      <strong>{kb.docs.reduce((n, d) => n + d.chunks, 0)}</strong>
                      <span>{t('knowledge.chunkUnit')}</span>
                    </div>
                    <div>
                      <strong>{fmt(kb.sizeBytes)}</strong>
                      <span>{t('knowledge.corpusUnit')}</span>
                    </div>
                  </div>
                </div>

                <div className="kb-actions">
                  <button className="btn subtle sm" disabled={busy === kb.id} onClick={async () => {
                    setBusy(kb.id)
                    await importKnowledge(kb.id)
                    setBusy(null)
                  }}>
                    {busy === kb.id ? <Spinner size={12} /> : <FileUp size={13} />} {t('knowledge.import')}
                  </button>
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      if (!currentSession) {
                        toast(t('knowledge.needSession'), 'warn')
                        return
                      }
                      const next = attached
                        ? currentSession.knowledgeBaseIds.filter((x) => x !== kb.id)
                        : [...currentSession.knowledgeBaseIds, kb.id]
                      void attachKnowledge(next)
                    }}
                  >
                    <BookOpen size={13} /> {attached ? t('common.detach') : t('knowledge.attach')}
                  </button>
                  <button className="btn ghost sm" onClick={() => void exportTraining(kb.id)}>
                    <Download size={13} /> {t('knowledge.export')}
                  </button>
                  <span className="spacer" />
                  <button className="icon-btn sm danger-hover" onClick={() => {
                    if (window.confirm(t('knowledge.deleteConfirm'))) void deleteKnowledge(kb.id)
                  }}>
                    <Trash2 size={13} />
                  </button>
                </div>

                <div className="kb-docs">
                  {kb.docs.slice(0, 5).map((d) => (
                    <div className="kb-doc" key={d.id}>
                      <span className="kb-doc-name">{d.title}</span>
                      <span>{d.chunks} {t('knowledge.chunkUnit')}</span>
                      <span>{fmt(d.sizeBytes)}</span>
                    </div>
                  ))}
                  {kb.docs.length > 5 && <div className="kb-doc muted">{t('knowledge.moreDocs', { n: kb.docs.length - 5 })}</div>}
                </div>

                <div className="kb-search">
                  <div className="search-box">
                    <Search size={13} />
                    <input
                      value={queries[kb.id] || ''}
                      placeholder={t('knowledge.searchPlaceholder')}
                      onChange={(e) => setQueries({ ...queries, [kb.id]: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void doSearch(kb.id)
                      }}
                    />
                  </div>
                  <button className="btn subtle sm" onClick={() => void doSearch(kb.id)} disabled={searching === kb.id}>
                    {searching === kb.id ? <Spinner size={12} /> : <Search size={12} />} {t('knowledge.search')}
                  </button>
                </div>
                {results[kb.id] && (
                  <div className="kb-hits">
                    {results[kb.id].length === 0 && <span className="muted small">{t('knowledge.searchEmpty')}</span>}
                    {results[kb.id].map((hit, i) => (
                      <div className="kb-hit" key={i}>
                        <div className="kb-hit-head">
                          <strong>{hit.title}</strong>
                          <span>{hit.score.toFixed(2)}</span>
                        </div>
                        <p>{hit.snippet}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <section className="section">
        <div className="section-head">
          <h2>{t('knowledge.catalog')}</h2>
          <span className="muted small">{t('knowledge.catalogDesc')}</span>
        </div>
        {!catalogOnline && (
          <div className="notice warn">
            <Upload size={14} />
            <span>{t('knowledge.catalogOffline')}</span>
          </div>
        )}
        <div className="catalog-grid">
          {catalog.map((c) => (
            <div className="catalog-card" key={c.id}>
              <div className="catalog-top">
                <strong>{c.name}</strong>
                <span className="badge neutral tiny">{c.format}</span>
              </div>
              <p>{c.description}</p>
              <div className="rec-meta">
                <span>{fmt(c.sizeBytes)}</span>
                {c.minRamGb ? <span>{t('knowledge.minRam', { ram: c.minRamGb })}</span> : null}
              </div>
              {c.recommendedFor && c.recommendedFor.length > 0 && (
                <div className="rec-tags">
                  {c.recommendedFor.slice(0, 3).map((r) => (
                    <span className="tag" key={r}>
                      {r}
                    </span>
                  ))}
                </div>
              )}
              <div className="rec-actions">
                <button
                  className="btn primary full"
                  disabled={installingCatalog === c.id}
                  onClick={async () => {
                    if (!c.installUrl) {
                      await installCatalogKnowledge(c.id)
                      return
                    }
                    setInstallingCatalog(c.id)
                    await installCatalogKnowledge(c.id)
                    setInstallingCatalog(null)
                  }}
                >
                  {installingCatalog === c.id ? <Spinner size={12} /> : <Download size={12} />} {t('common.install')}
                </button>
                {c.installUrl && (
                  <button className="link-btn" onClick={() => void window.aih.openExternal(c.installUrl!)}>
                     {t('common.source')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} width={480}>
        <h2 className="modal-title">{t('knowledge.createTitle')}</h2>
        <div className="form">
          <label>
            <span>{t('knowledge.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('knowledge.namePlaceholder')} autoFocus />
          </label>
          <label>
            <span>{t('knowledge.description')}</span>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={t('knowledge.description')} />
          </label>
        </div>
        <p className="muted small">{t('knowledge.dropHint')}</p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setCreateOpen(false)}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={!name.trim()}>
            {t('common.create')}
          </button>
        </div>
      </Modal>
    </div>
  )
}
