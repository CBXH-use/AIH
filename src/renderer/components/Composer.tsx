import { useEffect, useRef, useState } from 'react'
import { ArrowUp, BookOpen, Check, FolderOpen, ImagePlus, Layers, Square } from 'lucide-react'
import { useAppStore, useCurrentSession } from '../store'
import { useT } from '../i18n'
import { Dropdown, imageFileToDataUrl } from './ui'
interface Attachment {
  dataUrl: string
  name?: string
}

export function Composer({ awaitingReply }: { awaitingReply?: boolean }) {
  const t = useT()
  const session = useCurrentSession()
  const knowledge = useAppStore((s) => s.knowledge)
  const projects = useAppStore((s) => s.projects)
  const send = useAppStore((s) => s.send)
  const stop = useAppStore((s) => s.stop)
  const compress = useAppStore((s) => s.compress)
  const attachKnowledge = useAppStore((s) => s.attachKnowledge)
  const setPage = useAppStore((s) => s.setPage)
  const setWorkspace = useAppStore((s) => s.setWorkspace)
  const openProjectFolder = useAppStore((s) => s.openProjectFolder)
  const toast = useAppStore((s) => s.toast)
  const settings = useAppStore((s) => s.settings)
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const running = session?.status === 'running' || session?.status === 'waiting-approval'
  const attached = session?.knowledgeBaseIds || []
  const sendOnEnter = settings.ui?.sendOnEnter !== false
  const project = projects.find((p) => p.id === session?.projectId)
  const projectLocked = !!project && project.id !== 'default'
  const workspacePath = session?.workspaceDir || project?.path || ''
  const workspaceName =
    (projectLocked && project ? project.name : workspacePath.split(/[\\/]/).filter(Boolean).pop()) || t('chat.workspace')
  const workspaceLabel = `${t('chat.workspace')} · ${workspaceName}`
  const changeWorkspace = () => {
    if (projectLocked && project) void openProjectFolder(project.id)
    else void setWorkspace()
  }

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(200, el.scrollHeight) + 'px'
  }, [text])

  const addFiles = (files: FileList | File[]) => {
    const list = Array.from(files)
      .filter((f) => f.type.startsWith('image/'))
      .slice(0, 4 - images.length)
    for (const file of list) {
      if (file.size > 8 * 1024 * 1024) {
        toast(t('chat.imagesTooLarge'), 'warn')
        continue
      }
      // 先压缩再发送：落盘文件更小，发给视觉模型的 token 也更少
      void imageFileToDataUrl(file, 1280)
        .then((dataUrl) => {
          setImages((prev) => [...prev, { dataUrl, name: file.name }].slice(0, 4))
        })
        .catch(() => toast(t('chat.imagesTooLarge'), 'warn'))
    }
  }

  const submit = async () => {
    if (running) {
      await stop()
      return
    }
    if (!text.trim() && !images.length) return
    const payload = { text, images }
    setText('')
    setImages([])
    await send(payload.text, payload.images)
  }

  return (
    <div
      className={`composer ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
      }}
    >
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((img, i) => (
            <div className="thumb" key={i}>
              <img src={img.dataUrl} alt={img.name || ''} />
              <button onClick={() => setImages((prev) => prev.filter((_, idx) => idx !== i))}>×</button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        value={text}
        rows={1}
        placeholder={
          awaitingReply
            ? t('chat.replyPlaceholder')
            : session?.model
              ? session.mode === 'chat'
                ? t('chat.chatPlaceholder')
                : t('chat.placeholder')
              : t('chat.noModelHint')
        }
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
          if (files.length) {
            e.preventDefault()
            addFiles(files)
          }
        }}
        onKeyDown={(e) => {
          const shouldSend = sendOnEnter ? e.key === 'Enter' && !e.shiftKey : e.key === 'Enter' && (e.ctrlKey || e.metaKey)
          if (shouldSend && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
          if (e.key === 'Escape' && running && !text) {
            e.preventDefault()
            void stop()
          }
        }}
      />
      <div className="composer-bar">
        <div className="composer-tools">
          {session?.mode !== 'chat' && (
            <button
              className={`tool-btn workspace-btn ${projectLocked ? 'locked' : ''}`}
              onClick={changeWorkspace}
              title={`${t('chat.changeWorkspace')}：${workspacePath || t('chat.workspace')}`}
            >
              <FolderOpen size={16} />
              <span className="tool-btn-label">{workspaceLabel}</span>
            </button>
          )}
          <button className="tool-btn" onClick={() => fileRef.current?.click()} title={t('chat.attach')}>
            <ImagePlus size={16} />
            <span className="tool-btn-label">{t('chat.labelImage')}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <Dropdown
            width={280}
            button={
              <button className={`tool-btn ${attached.length ? 'active' : ''}`} title={t('chat.attachKnowledge')}>
                <BookOpen size={16} />
                <span className="tool-btn-label">{t('chat.labelKnowledge')}</span>
                {attached.length > 0 && <span className="tool-count">{attached.length}</span>}
              </button>
            }
          >
            {(close) => (
              <div className="menu">
                <div className="menu-label">{t('chat.attachKnowledge')}</div>
                {knowledge.length === 0 && (
                  <div className="menu-empty">
                    <BookOpen size={16} />
                    <span>{t('chat.noKnowledge')}</span>
                    <button
                      className="link-btn"
                      onClick={() => {
                        close()
                        setPage('knowledge')
                      }}
                    >
                      {t('common.createNow')}
                    </button>
                  </div>
                )}
                {knowledge.map((kb) => {
                  const checked = attached.includes(kb.id)
                  return (
                    <button
                      key={kb.id}
                      className="menu-item"
                      onClick={() => {
                        const next = checked ? attached.filter((x) => x !== kb.id) : [...attached, kb.id]
                        void attachKnowledge(next)
                      }}
                    >
                      <div className="menu-item-check">{checked && <Check size={14} />}</div>
                      <div className="menu-item-body">
                        <div className="menu-item-title">{kb.name}</div>
                        <div className="menu-item-desc">
                          {t('chat.docsCount', { n: kb.docs.length })} · {Math.round(kb.sizeBytes / 1024)} KB
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </Dropdown>
          <button className="tool-btn" onClick={() => void compress()} title={t('chat.compress')} disabled={running}>
            <Layers size={16} />
            <span className="tool-btn-label">{t('chat.labelCompress')}</span>
          </button>
        </div>
        <div className="composer-right">
          <span className="composer-hint">{sendOnEnter ? t('chat.enterHint') : t('chat.ctrlEnterHint')}</span>
          <button
            className={`send-btn ${running ? 'stop' : ''}`}
            onClick={() => void submit()}
            disabled={!running && !text.trim() && !images.length}
            title={running ? t('chat.stop') : t('chat.send')}
          >
            {running ? <Square size={14} fill="currentColor" /> : <ArrowUp size={17} strokeWidth={2.4} />}
          </button>
        </div>
      </div>
    </div>
  )
}
