import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useAppStore } from '../store'
import { useT } from '../i18n'

/** 读取图片并压缩成 data URL；maxSize 控制最长边，quality 用于 JPEG 重编码 */
export async function imageFileToDataUrl(file: File, maxSize = 256, quality = 0.82): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('not-image')
  if (file.size > 8 * 1024 * 1024) throw new Error('too-large')
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = dataUrl
  })
  const render = (limit: number, type: string): string => {
    const scale = Math.min(1, limit / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return dataUrl
    ctx.drawImage(img, 0, 0, w, h)
    return canvas.toDataURL(type, quality)
  }
  // 截图/带透明通道的图保留 PNG（文字更清晰）；照片类压成 JPEG 体积更小
  const keepPng = /png|webp|gif|svg/i.test(file.type)
  let out = render(maxSize, keepPng ? 'image/png' : 'image/jpeg')
  if (out.length > 2_000_000) {
    // 仍然太大时降到 JPEG 并缩小，保证落盘和发给模型都不至于卡住
    out = render(Math.min(maxSize, 720), 'image/jpeg')
  }
  return out
}

/** 落盘图片的显示地址（自定义协议由主进程注册） */
export function imageSrc(part: { dataUrl?: string; file?: string }): string {
  if (part.file) return `aih-attachment://local/${part.file.split('\\').join('/')}`
  return part.dataUrl || ''
}

export function AssistantAvatar({ size = 26, className = '' }: { size?: number; className?: string }) {
  const avatar = useAppStore((s) => s.settings.ui?.assistantAvatar)
  return (
    <div
      className={`avatar assistant-avatar ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.46)) }}
    >
      {avatar ? <img src={avatar} alt="AIH" /> : 'A'}
    </div>
  )
}

export function AgentIcon({
  icon,
  size = 16,
  className = ''
}: {
  icon?: string
  size?: number
  className?: string
}) {
  const value = icon || '✳️'
  if (value.startsWith('data:image/') || /^https?:\/\//.test(value)) {
    return (
      <img
        className={`agent-icon-img ${className}`}
        src={value}
        alt=""
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span className={className} style={{ fontSize: size, lineHeight: 1 }}>
      {value}
    </span>
  )
}

export function Dropdown({
  button,
  children,
  align = 'left',
  width = 280,
  className = ''
}: {
  button: ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // 面板挂到 body 上，避免被 topbar 的 backdrop-filter / composer 的 overflow 裁切或压住
  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const place = () => {
      const trigger = triggerRef.current
      const panel = panelRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const vw = window.innerWidth
      const vh = window.innerHeight
      const panelWidth = Math.min(width, vw - 16)
      const panelHeight = panel?.offsetHeight || 0
      const spaceBelow = vh - rect.bottom - 10
      const spaceAbove = rect.top - 10
      const placeAbove = panelHeight > spaceBelow && spaceAbove > spaceBelow
      const top = placeAbove
        ? Math.max(8, rect.top - panelHeight - 7)
        : Math.min(rect.bottom + 7, Math.max(8, vh - panelHeight - 8))
      let left = align === 'right' ? rect.right - panelWidth : rect.left
      left = Math.max(8, Math.min(left, vw - panelWidth - 8))
      setPos({ top, left, width: panelWidth })
    }
    place()
    const timer = window.setTimeout(place, 0)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, align, width])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <div className={`dd ${className}`} ref={triggerRef}>
        <div className="dd-trigger" onClick={() => setOpen((v) => !v)}>
          {button}
        </div>
      </div>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className={`dd-panel ${align}`}
            style={{
              width: pos?.width ?? width,
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              visibility: pos ? 'visible' : 'hidden'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body
        )}
    </>
  )
}

export function Modal({
  open,
  onClose,
  children,
  width = 520,
  className = ''
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  width?: number
  className?: string
}) {
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 打开后主动聚焦第一个表单控件，避免刚打开时输入框“点不动”或没有输入焦点
  useEffect(() => {
    if (!open) return
    const focusFirst = () => {
      const root = modalRef.current
      if (!root) return
      if (root.contains(document.activeElement)) return
      const el = root.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])'
      )
      el?.focus()
    }
    focusFirst()
    const timer = window.setTimeout(focusFirst, 60)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!open) return null
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={modalRef}
        className={`modal ${className}`}
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button className="modal-x" onClick={onClose} aria-label="close">
          <X size={16} />
        </button>
        {children}
      </div>
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      role="switch"
      aria-checked={checked}
    >
      <span className="knob" />
    </button>
  )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' }) {
  return <span className={`badge ${tone}`}>{children}</span>
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />
}

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts)
  const dismiss = useAppStore((s) => s.dismissToast)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`} onClick={() => dismiss(t.id)}>
          <span className="toast-bar" />
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  )
}

export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

export function ConfirmModal({
  open,
  title,
  message,
  onCancel,
  onConfirm,
  danger
}: {
  open: boolean
  title: string
  message: string
  onCancel: () => void
  onConfirm: () => void
  danger?: boolean
}) {
  const t = useT()
  return (
    <Modal open={open} onClose={onCancel} width={420}>
      <h2 className="modal-title">{title}</h2>
      <p className="modal-desc">{message}</p>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
          {t('common.confirm')}
        </button>
      </div>
    </Modal>
  )
}
