import { useRef, useState } from 'react'
import { Bot, Copy, ImagePlus, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { AgentPreset } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { AgentIcon, Badge, imageFileToDataUrl, Modal, PageHeader } from '../components/ui'

const TOOL_NAMES = [
  'list_dir',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'shell',
  'todo_write',
  'web_search',
  'web_fetch',
  'knowledge_search'
]

const EMPTY: AgentPreset = {
  id: '',
  name: '',
  icon: '🤖',
  description: '',
  category: 'general',
  systemPrompt: '',
  tools: ['list_dir', 'read_file', 'write_file', 'edit_file', 'glob', 'grep'],
  builtin: false
}

export function AgentsPage() {
  const t = useT()
  const agents = useAppStore((s) => s.agents)
  const saveAgent = useAppStore((s) => s.saveAgent)
  const deleteAgent = useAppStore((s) => s.deleteAgent)
  const newSession = useAppStore((s) => s.newSession)
  const [editing, setEditing] = useState<AgentPreset | null>(null)
  const [form, setForm] = useState<AgentPreset>(EMPTY)
  const iconInputRef = useRef<HTMLInputElement>(null)

  const pickIcon = async (file?: File) => {
    if (!file) return
    try {
      const dataUrl = await imageFileToDataUrl(file, 128)
      setForm((f) => ({ ...f, icon: dataUrl }))
    } catch {
      /* 忽略非图片或过大的文件 */
    }
  }

  const openNew = () => {
    setForm({ ...EMPTY })
    setEditing({ ...EMPTY })
  }

  const openEdit = (a: AgentPreset) => {
    setForm({ ...a })
    setEditing(a)
  }

  const duplicate = (a: AgentPreset) => {
    setForm({ ...a, id: '', name: `${a.name} ${t('agents.copySuffix')}`, builtin: false, pluginId: undefined })
    setEditing({ ...a, id: '' })
  }

  const toggleTool = (name: string) => {
    setForm((f) => ({
      ...f,
      tools: f.tools.includes(name) ? f.tools.filter((x) => x !== name) : [...f.tools, name]
    }))
  }

  const grouped = [
    { key: 'builtin', label: t('agents.builtin'), list: agents.filter((a) => a.builtin) },
    { key: 'plugin', label: t('agents.plugin'), list: agents.filter((a) => !a.builtin && a.pluginId) },
    { key: 'custom', label: t('agents.custom'), list: agents.filter((a) => !a.builtin && !a.pluginId) }
  ].filter((g) => g.list.length > 0)

  return (
    <div className="page">
      <PageHeader
        title={t('agents.title')}
        subtitle={t('agents.subtitle')}
        actions={
          <button className="btn primary" onClick={openNew}>
            <Plus size={14} /> {t('agents.create')}
          </button>
        }
      />

      <div className="agent-total">{t('agents.count', { n: agents.length })}</div>

      {grouped.map((group) => (
        <section className="section" key={group.key}>
          <div className="section-head">
            <h2>{group.label}</h2>
            <span className="muted small">{group.list.length}</span>
          </div>
          <div className="agent-grid">
            {group.list.map((a) => (
              <div className="agent-card" key={a.id}>
                <div className="agent-card-top">
                  <div className="agent-emoji">
                    <AgentIcon icon={a.icon} size={22} />
                  </div>
                  <div className="agent-title">
                    <strong>{a.name}</strong>
                    <span>{a.category}</span>
                  </div>
                  {a.pluginId && <Badge tone="blue">{t('agents.plugin')}</Badge>}
                  {a.builtin && <Badge tone="neutral">{t('agents.builtin')}</Badge>}
                </div>
                <p className="agent-desc">{a.description}</p>
                <div className="agent-tools">
                  {a.tools.slice(0, 6).map((tool) => (
                    <span className="tag" key={tool}>
                      {t(`agents.tool.${tool}`)}
                    </span>
                  ))}
                  {a.tools.length > 6 && <span className="tag muted-tag">+{a.tools.length - 6}</span>}
                </div>
                <div className="agent-foot">
                  <button className="btn subtle sm" onClick={() => void newSession({ agentId: a.id })}>
                    <Sparkles size={12} /> {t('agents.use')}
                  </button>
                  <span className="spacer" />
                  {!a.builtin && !a.pluginId ? (
                    <>
                      <button className="icon-btn sm" onClick={() => openEdit(a)} title={t('agents.edit')}>
                        <Pencil size={13} />
                      </button>
                      <button
                        className="icon-btn sm danger-hover"
                        onClick={() => {
                          if (window.confirm(t('agents.deleteConfirm'))) void deleteAgent(a.id)
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </>
                  ) : (
                    <button className="icon-btn sm" onClick={() => duplicate(a)} title={t('agents.duplicate')}>
                      <Copy size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}

      {agents.length === 0 && (
        <div className="empty-strip">
          <Bot size={18} />
          <span>{t('agents.create')}</span>
        </div>
      )}

      <Modal open={!!editing} onClose={() => setEditing(null)} width={640}>
        <h2 className="modal-title">{editing?.id ? t('agents.edit') : t('agents.create')}</h2>
        <div className="form grid2">
          <label>
            <span>{t('agents.icon')}</span>
            <div className="icon-editor">
              <div className="agent-icon-preview">
                <AgentIcon icon={form.icon} size={26} />
              </div>
              <input
                value={form.icon.startsWith('data:') ? '' : form.icon}
                maxLength={4}
                onChange={(e) => setForm({ ...form, icon: e.target.value })}
                placeholder={t('agents.iconPlaceholder')}
              />
              <button className="btn ghost sm" onClick={() => iconInputRef.current?.click()}>
                <ImagePlus size={13} /> {t('agents.uploadIcon')}
              </button>
              {form.icon.startsWith('data:') && (
                <button className="icon-btn sm" onClick={() => setForm({ ...form, icon: '🤖' })} title={t('settings.resetAvatar')}>
                  <Trash2 size={13} />
                </button>
              )}
              <input
                ref={iconInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  void pickIcon(e.target.files?.[0])
                  e.target.value = ''
                }}
              />
            </div>
          </label>
          <label>
            <span>{t('agents.name')}</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('agents.namePlaceholder')} autoFocus />
          </label>
          <label className="span2">
            <span>{t('agents.description')}</span>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="span2">
            <span>{t('agents.systemPrompt')}</span>
            <textarea
              rows={7}
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
              placeholder={t('agents.promptPlaceholder')}
            />
          </label>
          <div className="span2">
            <span className="field-label">{t('agents.tools')}</span>
            <div className="check-grid">
              {TOOL_NAMES.map((tool) => (
                <label className={`check-pill ${form.tools.includes(tool) ? 'checked' : ''}`} key={tool}>
                  <input type="checkbox" checked={form.tools.includes(tool)} onChange={() => toggleTool(tool)} />
                  {t(`agents.tool.${tool}`)}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setEditing(null)}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            disabled={!form.name.trim() || !form.systemPrompt.trim()}
            onClick={async () => {
              await saveAgent({ ...form, builtin: false })
              setEditing(null)
            }}
          >
            {t('agents.save')}
          </button>
        </div>
      </Modal>
    </div>
  )
}
