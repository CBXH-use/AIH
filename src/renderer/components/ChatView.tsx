import { useEffect, useMemo, useRef, useState } from 'react'
import { Bug, Code2, FileText, FolderTree, Loader2, MessageSquare, Presentation, Sparkles } from 'lucide-react'
import { useAppStore, useCurrentSession } from '../store'
import { useT } from '../i18n'
import { MessageView } from './Message'
import { Composer } from './Composer'
import { ApprovalInline } from './Approval'
import { QuestionPrompt } from './QuestionPrompt'
import { AgentIcon, AssistantAvatar } from './ui'

function estimate(messages: { parts: any[] }[]): number {
  let chars = 0
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'text' || p.type === 'reasoning') chars += p.text.length
      else if (p.type === 'tool-result') chars += p.result.output.length
    }
  }
  return Math.ceil(chars / 3.2)
}

const SUGGESTIONS = [
  { icon: FolderTree, key: 'chat.suggestion1' },
  { icon: Code2, key: 'chat.suggestion2' },
  { icon: Presentation, key: 'chat.suggestion3' },
  { icon: Bug, key: 'chat.suggestion4' }
]

const CHAT_SUGGESTIONS = [
  { icon: Sparkles, key: 'chat.chatSuggestion1' },
  { icon: Code2, key: 'chat.chatSuggestion2' },
  { icon: FileText, key: 'chat.chatSuggestion3' },
  { icon: Bug, key: 'chat.chatSuggestion4' }
]

export function ChatView() {
  const t = useT()
  const session = useCurrentSession()
  const page = useAppStore((s) => s.page)
  const sessions = useAppStore((s) => s.sessions)
  const agents = useAppStore((s) => s.agents)
  const settings = useAppStore((s) => s.settings)
  const models = useAppStore((s) => s.models)
  const providers = useAppStore((s) => s.providers)
  const approvals = useAppStore((s) => s.approvals)
  const assistantAvatar = useAppStore((s) => s.settings.ui?.assistantAvatar)
  const newSession = useAppStore((s) => s.newSession)
  const send = useAppStore((s) => s.send)
  const setPage = useAppStore((s) => s.setPage)
  const regenerate = useAppStore((s) => s.regenerate)
  const knowledge = useAppStore((s) => s.knowledge)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [stick, setStick] = useState(true)
  const [dismissedQuestionId, setDismissedQuestionId] = useState<string | null>(null)

  const messages = session?.messages || []

  useEffect(() => {
    if (stick) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, stick])

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i].id
    return null
  }, [messages])

  const agent = agents.find((a) => a.id === session?.agentId)
  const chatMode = session?.mode === 'chat' || (!session && page === 'chat')
  const reasoningModel = !!session?.model && /deepseek-r1|qwq|reasoner|reasoning/i.test(session.model.label)
  const suggestions = chatMode ? CHAT_SUGGESTIONS : SUGGESTIONS
  const streamingAssistant = messages.some((m) => m.role === 'assistant' && m.streaming)
  const lastMessage = messages[messages.length - 1]
  const showThinking =
    !!session && session.status === 'running' && !streamingAssistant && (!lastMessage || lastMessage.role === 'user')
  const approvalForCurrent = session ? approvals.find((a) => a.sessionId === session.id) || null : null
  const modelInfo = models.find(
    (m) => session?.model && m.providerId === session.model.providerId && m.remoteId === session.model.modelId
  )
  const effectiveWindow = modelInfo?.contextLength
    ? Math.min(settings.harness.context.window, modelInfo.contextLength)
    : settings.harness.context.window
  const tokens = estimate(messages)
  const window = effectiveWindow
  const pct = Math.min(100, Math.round((tokens / Math.max(1, window)) * 100))
  const noModel = !session?.model
  const providerLocal = providers.find((p) => p.id === session?.model?.providerId)?.isLocal
  const attached = knowledge.filter((k) => session?.knowledgeBaseIds?.includes(k.id))
  const awaitingReply =
    !!session &&
    session.status === 'idle' &&
    !!lastMessage &&
    lastMessage.role === 'assistant' &&
    !!lastMessage.awaitingReply
  const showQuestion = awaitingReply && !!lastMessage && dismissedQuestionId !== lastMessage.id

  if (!session) {
    return (
      <div className="chat-page">
        <div className="chat-scroll">
          <div className="hero">
            <div className="hero-mark">{assistantAvatar ? <img src={assistantAvatar} alt="AIH" /> : 'A'}</div>
            <h1>{chatMode ? t('chat.chatEmptyTitle') : 'AIH'}</h1>
            <p>{chatMode ? t('chat.chatEmptySubtitle') : t('chat.emptySubtitle')}</p>
            <div className="chat-empty-actions">
              <button className="btn primary" onClick={() => void newSession({ mode: chatMode ? 'chat' : 'task' })}>
                <Sparkles size={15} /> {chatMode ? t('sidebar.newChat') : t('sidebar.newTask')}
              </button>
              <button className="btn ghost" onClick={() => void newSession({ mode: chatMode ? 'task' : 'chat' })}>
                {chatMode ? t('sidebar.newTask') : t('sidebar.newChat')}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const hasMessages = messages.some((m) => m.role === 'user' || m.parts.length > 0)

  return (
    <div className="chat-page">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current
          if (!el) return
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 120)
        }}
      >
        {!hasMessages && (
          <div className="hero">
            <div className="hero-mark">{assistantAvatar ? <img src={assistantAvatar} alt="AIH" /> : 'A'}</div>
            <div className="hero-agent">
              <span>{chatMode ? <MessageSquare size={12} /> : <AgentIcon icon={agent?.icon || '✳️'} size={14} />}</span>
              <span>{chatMode ? t('chat.modeChat') : agent?.name || 'AIH'}</span>
            </div>
            <h1>{chatMode ? t('chat.chatEmptyTitle') : t('chat.emptyTitle')}</h1>
            <p>{chatMode ? t('chat.chatEmptySubtitle') : agent?.description || t('chat.emptySubtitle')}</p>
            {noModel && (
              <div className="hero-warning">
                <span>{t('chat.emptyNoModel')}</span>
                <button className="link-btn" onClick={() => setPage('models')}>
                  {t('sidebar.models')} →
                </button>
              </div>
            )}
            {chatMode && reasoningModel && (
              <div className="hero-warning">
                <span>{t('chat.reasoningSlowHint')}</span>
              </div>
            )}
            <div className="suggestions">
              {suggestions.map((s) => {
                const Icon = s.icon
                return (
                  <button key={s.key} className="suggestion" onClick={() => void send(t(s.key))}>
                    <Icon size={16} />
                    <span>{t(s.key)}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <div className="messages">
          {messages.map((m, i) => (
            <MessageView
              key={m.id}
              message={m}
              isLastAssistant={m.id === lastAssistantId}
              continuation={m.role === 'assistant' && messages[i - 1]?.role === 'assistant'}
              onRegenerate={() => void regenerate(m.id)}
            />
          ))}
          {showThinking && (
            <div className="msg assistant">
              <AssistantAvatar />
              <div className="msg-main">
                <div className="msg-head">
                  <span className="msg-name">AIH</span>
                  {session.model && <span className="msg-model">{session.model.label}</span>}
                  <span className="msg-status">
                    <Loader2 size={11} className="spin" />
                    {t('chat.thinkingNow')}
                  </span>
                </div>
                <div className="thinking-body">
                  <span className="typing">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span>{t('chat.thinkingWait')}</span>
                </div>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="chat-bottom">
        {approvalForCurrent && <ApprovalInline request={approvalForCurrent} />}
        {showQuestion && lastMessage && (
          <QuestionPrompt
            message={lastMessage}
            onAnswer={(text) => {
              setDismissedQuestionId(null)
              void send(text)
            }}
            onSkip={() => setDismissedQuestionId(lastMessage.id)}
          />
        )}
        <Composer awaitingReply={awaitingReply} />
        <div className="statusbar">
          <span className="status-item">
            {chatMode ? <MessageSquare size={12} /> : <Sparkles size={12} />}
            <span>{chatMode ? t('chat.modeChatHint') : t('chat.modeTaskHint')}</span>
          </span>
          {attached.length > 0 && (
            <span className="status-item">
              <FileText size={12} />
              {attached.map((k) => k.name).join('、')}
            </span>
          )}
          <span className="status-spacer" />
          {settings.ui?.showTokenUsage !== false && (
            <span className={`status-item ${pct > 85 ? 'warn' : ''}`} title={`${tokens} / ${window} tokens`}>
              {t('chat.contextShort', { n: pct })}
            </span>
          )}
          <span className="status-item">
            {session.model ? (providerLocal ? t('chat.localMode') : t('chat.remoteMode')) : t('top.noModel')}
          </span>
        </div>
      </div>
    </div>
  )
}
