import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUp, MessageSquare, PenLine, X } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { parseQuestion } from '../questionParse'
import { useT } from '../i18n'

export function QuestionPrompt({
  message,
  onAnswer,
  onSkip
}: {
  message: ChatMessage
  onAnswer: (text: string) => void
  onSkip: () => void
}) {
  const t = useT()
  const text = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
  const question = useMemo(() => parseQuestion(text), [text])
  const [selected, setSelected] = useState(-1)
  const [value, setValue] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setSelected(-1)
    setValue('')
    setSubmitted(false)
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [message.id])

  const submit = (answer?: string) => {
    if (submitted) return
    const finalText = (answer ?? (selected >= 0 ? question.options[selected]?.title : value)).trim()
    if (!finalText) return
    setSubmitted(true)
    onAnswer(finalText)
  }

  return (
    <div className="question-card">
      <div className="question-head">
        <span className="question-tag">
          <MessageSquare size={12} />
          {t('chat.questionTag')}
        </span>
        <button className="question-close" onClick={onSkip} title={t('common.skip')}>
          <X size={14} />
        </button>
      </div>
      {question.title && <div className="question-title">{question.title}</div>}
      {question.options.length > 0 && (
        <div className="question-options">
          {question.options.map((option, index) => (
            <button
              key={`${option.title}-${index}`}
              className={`question-option ${selected === index ? 'selected' : ''}`}
              onClick={() => {
                setSelected(index)
                setValue('')
              }}
              onDoubleClick={() => submit(option.title)}
            >
              <span className="question-option-index">{index + 1}</span>
              <span className="question-option-body">
                <span className="question-option-title">
                  {option.title}
                  {option.recommended && <span className="question-badge">{t('chat.recommended')}</span>}
                </span>
                {option.desc && <span className="question-option-desc">{option.desc}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="question-answer">
        <PenLine size={14} />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setSelected(-1)
          }}
          placeholder={t('chat.answerPlaceholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
      </div>
      <div className="question-actions">
        <button className="btn ghost sm" onClick={onSkip}>
          {t('common.skip')}
        </button>
        <button className="btn primary sm" disabled={selected < 0 && !value.trim()} onClick={() => submit()}>
          <ArrowUp size={13} />
          {t('chat.sendAnswer')}
        </button>
      </div>
    </div>
  )
}
