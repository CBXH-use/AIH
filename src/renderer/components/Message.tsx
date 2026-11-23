import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle,
  Brain,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Info,
  Loader2,
  RotateCcw,
  Terminal,
  Wrench,
  XCircle
} from 'lucide-react'
import type { ChatMessage, MessagePart, ToolCall, ToolResult } from '@shared/types'
import { useAppStore } from '../store'
import { useT } from '../i18n'
import { AssistantAvatar, imageSrc } from './ui'

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const lang = /language-([\w+-]+)/.exec(className || '')?.[1] || ''
  const code = String(children ?? '').replace(/\n$/, '')
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'text'}</span>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(code)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children } = props as { className?: string; children?: React.ReactNode }
            const isBlock = /language-/.test(className || '') || String(children ?? '').includes('\n')
            if (!isBlock) return <code className="inline-code">{children}</code>
            return <CodeBlock className={className}>{children}</CodeBlock>
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault()
                  if (href && /^https?:\/\//.test(href)) void window.aih.openExternal(href)
                }}
              >
                {children}
              </a>
            )
          },
          table({ children }) {
            return (
              <div className="table-wrap">
                <table>{children}</table>
              </div>
            )
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function summarizeCall(call: ToolCall): string {
  const a = call.arguments || {}
  if (call.name === 'shell') return String(a.command || '')
  if (call.name === 'read_file' || call.name === 'write_file' || call.name === 'edit_file' || call.name === 'list_dir') return String(a.path || '')
  if (call.name === 'web_fetch') return String(a.url || '')
  if (call.name === 'web_search' || call.name === 'knowledge_search') return String(a.query || '')
  const first = Object.values(a)[0]
  return typeof first === 'string' ? first : JSON.stringify(a).slice(0, 80)
}

function toolIcon(name: string) {
  if (name === 'shell') return <Terminal size={13} />
  if (name.includes('file') || name === 'read_file' || name === 'edit_file' || name === 'write_file') return <FileText size={13} />
  return <Wrench size={13} />
}

function ToolCard({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const status = !result ? 'running' : result.ok ? 'ok' : 'error'
  const risk = result?.risk
  return (
    <div className={`tool-card ${status}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-ico">{toolIcon(call.name)}</span>
        <span className="tool-name">{call.name}</span>
        <code className="tool-summary">{summarizeCall(call)}</code>
        <span className="tool-status">
          {status === 'running' && <Loader2 size={13} className="spin" />}
          {status === 'ok' && <CheckCircle2 size={13} />}
          {status === 'error' && <XCircle size={13} />}
          {status === 'running' ? t('chat.running') : status === 'ok' ? t('chat.done') : t('chat.failed')}
        </span>
        {risk?.level === 'high' && <span className="badge red tiny">{t('chat.highRisk')}</span>}
        <span className="tool-dur">{result?.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : ''}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">{t('chat.params')}</div>
          <pre className="tool-pre">{JSON.stringify(call.arguments, null, 2)}</pre>
          {result && (
            <>
              <div className="tool-label">{t('chat.toolResult')}</div>
              <pre className="tool-pre output">{result.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Notice({ level, text }: { level: 'info' | 'warn' | 'error'; text: string }) {
  const Icon = level === 'error' ? XCircle : level === 'warn' ? AlertTriangle : Info
  return (
    <div className={`notice ${level}`}>
      <Icon size={14} />
      <span>{text}</span>
    </div>
  )
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const t = useT()
  return (
    <div className="reasoning">
      <button onClick={() => setOpen((v) => !v)}>
        <Brain size={13} />
        <span>{t('chat.thinking')}</span>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}

export function MessageView({
  message,
  isLastAssistant,
  onRegenerate,
  continuation
}: {
  message: ChatMessage
  isLastAssistant?: boolean
  onRegenerate?: () => void
  /** 连续助手消息的后续部分：不再重复显示头像与消息头 */
  continuation?: boolean
}) {
  const t = useT()
  const toast = useAppStore((s) => s.toast)
  const showReasoning = useAppStore((s) => s.settings.ui?.showReasoning !== false)
  const [copied, setCopied] = useState(false)

  const grouped = useMemo(() => {
    const text = message.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('')
    const reasoning = message.parts.filter((p): p is { type: 'reasoning'; text: string } => p.type === 'reasoning').map((p) => p.text).join('')
    const images = message.parts.filter(
      (p): p is { type: 'image'; dataUrl?: string; file?: string; name?: string } => p.type === 'image'
    )
    const notices = message.parts.filter((p): p is { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string } => p.type === 'notice')
    const calls = message.parts.filter((p): p is { type: 'tool-call'; call: ToolCall } => p.type === 'tool-call').map((p) => p.call)
    const results = message.parts.filter((p): p is { type: 'tool-result'; result: ToolResult } => p.type === 'tool-result').map((p) => p.result)
    return { text, reasoning, images, notices, calls, results }
  }, [message.parts])

  const copy = () => {
    void navigator.clipboard.writeText(grouped.text)
    setCopied(true)
    toast('toast.copied', 'success')
    setTimeout(() => setCopied(false), 1500)
  }

  if (message.role === 'system') {
    return (
      <div className="system-message">
        {grouped.notices.map((n, i) => (
          <Notice key={i} level={n.level} text={n.text} />
        ))}
        {grouped.text && <div className="system-summary">{grouped.text}</div>}
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className="msg user">
        {grouped.text && (
          <button className="user-copy" onClick={copy} title={t('common.copy')}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
        <div className="bubble">
          {grouped.images.length > 0 && (
            <div className="bubble-images">
              {grouped.images.map((img, i) => (
                <img key={i} src={imageSrc(img)} alt={img.name || 'image'} />
              ))}
            </div>
          )}
          {grouped.text && <div className="bubble-text">{grouped.text}</div>}
        </div>
      </div>
    )
  }

  const hasContent = grouped.text || grouped.reasoning || grouped.calls.length || grouped.notices.length
  const thinking = message.streaming && !grouped.text && !grouped.reasoning && grouped.calls.length === 0
  return (
    <div className={`msg assistant${continuation ? ' continuation' : ''}`}>
      {continuation ? (
        <span className="avatar-spacer" aria-hidden />
      ) : (
        <AssistantAvatar />
      )}
      <div className="msg-main">
        {!continuation && (
          <div className="msg-head">
            <span className="msg-name">AIH</span>
            {message.model && <span className="msg-model">{message.model.label}</span>}
            {thinking && (
              <span className="msg-status">
                <Loader2 size={11} className="spin" />
                {t('chat.thinkingNow')}
              </span>
            )}
            <div className="msg-tools">
              {grouped.text && (
                <button onClick={copy} title={t('common.copy')}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              )}
              {isLastAssistant && !message.streaming && onRegenerate && (
                <button onClick={onRegenerate} title={t('chat.regenerate')}>
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          </div>
        )}
        <div className="msg-body">
          {grouped.reasoning && showReasoning && <Reasoning text={grouped.reasoning} />}
          {grouped.notices.map((n, i) => (
            <Notice key={i} level={n.level} text={n.text} />
          ))}
          {grouped.text && <Markdown text={grouped.text} />}
          {grouped.calls.length > 0 && (
            <div className="tool-stack">
              {grouped.calls.map((call) => (
                <ToolCard key={call.id} call={call} result={grouped.results.find((r) => r.callId === call.id)} />
              ))}
              {grouped.results
                .filter((r) => !grouped.calls.some((c) => c.id === r.callId))
                .map((r) => (
                  <ToolCard key={r.callId} call={{ id: r.callId, name: r.name, arguments: {} }} result={r} />
                ))}
            </div>
          )}
          {!hasContent && message.streaming && (
            <div className="typing">
              <span />
              <span />
              <span />
            </div>
          )}
          {message.streaming && hasContent && <span className="cursor" />}
        </div>
      </div>
    </div>
  )
}

export function partText(parts: MessagePart[]): string {
  return parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('')
}
