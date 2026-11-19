import { useEffect, useState } from 'react'
import { AlertTriangle, Check, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import type { ApprovalRequest } from '@shared/types'
import { useT } from '../i18n'
import { Modal, Spinner } from './ui'
import { useAppStore } from '../store'

export function ApprovalDialog({ request }: { request: ApprovalRequest | null }) {
  const t = useT()
  const approve = useAppStore((s) => s.approve)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setBusy(false)
  }, [request?.id])

  if (!request) return null
  const risk = request.risk
  const catastrophic = risk.reasons.includes('catastrophic')

  const decide = async (choice: 'allow' | 'allow-always' | 'deny') => {
    setBusy(true)
    await approve(choice)
  }

  return (
    <Modal open={!!request} onClose={() => void decide('deny')} width={580} className="approval-modal">
      <div className="approval-head">
        <div className={`approval-icon ${risk.level}`}>
          <ShieldAlert size={20} />
        </div>
        <div>
          <h2 className="modal-title">{t('approval.title')}</h2>
          <p className="modal-desc">
            {t('approval.subtitle')} <code>{request.call.name}</code>
          </p>
        </div>
        <span className={`badge ${risk.level === 'high' ? 'red' : risk.level === 'medium' ? 'amber' : 'green'}`}>
          {t('approval.risk')} · {t(`approval.${risk.level}`)}
        </span>
      </div>

      {catastrophic && (
        <div className="danger-banner">
          <AlertTriangle size={14} />
          <span>{t('approval.catastrophic')}</span>
        </div>
      )}

      <div className="approval-section">
        <div className="section-label">{t('approval.preview')}</div>
        <pre className="approval-preview">{request.preview || JSON.stringify(request.call.arguments, null, 2)}</pre>
      </div>

      {risk.reasons.length > 0 && (
        <div className="approval-section">
          <div className="section-label">{t('approval.reasons')}</div>
          <ul className="reason-list">
            {risk.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="approval-hint">{t('approval.hint')}</p>

      <div className="modal-actions approval-actions">
        <button className="btn ghost" onClick={() => void decide('deny')} disabled={busy}>
          <X size={14} /> {t('approval.deny')}
        </button>
        <span className="spacer" />
        <button className="btn subtle" onClick={() => void decide('allow-always')} disabled={busy || catastrophic}>
          <ShieldCheck size={14} /> {t('approval.allowAlways')}
        </button>
        <button className={`btn ${risk.level === 'high' ? 'danger' : 'primary'}`} onClick={() => void decide('allow')} disabled={busy}>
          {busy ? <Spinner size={13} /> : <Check size={14} />} {t('approval.allowOnce')}
        </button>
      </div>
    </Modal>
  )
}

export function ApprovalInline({ request }: { request: ApprovalRequest }) {
  const t = useT()
  const approve = useAppStore((s) => s.approve)
  const [busy, setBusy] = useState(false)
  const risk = request.risk
  const catastrophic = risk.reasons.includes('catastrophic')

  useEffect(() => {
    setBusy(false)
  }, [request.id])

  const decide = async (choice: 'allow' | 'allow-always' | 'deny') => {
    setBusy(true)
    await approve(choice)
  }

  return (
    <div className={`approval-inline ${risk.level}`}>
      <div className="approval-inline-head">
        <div className={`approval-inline-icon ${risk.level}`}>
          <ShieldAlert size={15} />
        </div>
        <div className="approval-inline-title">
          <strong>{t('approval.title')}</strong>
          <span>
            {t('approval.subtitle')} <code>{request.call.name}</code>
          </span>
        </div>
        <span className={`badge ${risk.level === 'high' ? 'red' : risk.level === 'medium' ? 'amber' : 'green'}`}>
          {t('approval.risk')} · {t(`approval.${risk.level}`)}
        </span>
      </div>
      {catastrophic && (
        <div className="danger-banner">
          <AlertTriangle size={14} />
          <span>{t('approval.catastrophic')}</span>
        </div>
      )}
      <pre className="approval-inline-preview">{request.preview || JSON.stringify(request.call.arguments, null, 2)}</pre>
      {risk.reasons.filter((r) => r !== 'catastrophic').length > 0 && (
        <div className="approval-inline-preview reasons">
          {risk.reasons.filter((r) => r !== 'catastrophic').join(' · ')}
        </div>
      )}
      <div className="approval-inline-actions">
        <button className="btn ghost sm" onClick={() => void decide('deny')} disabled={busy}>
          <X size={13} /> {t('approval.deny')}
        </button>
        <button className="btn subtle sm" onClick={() => void decide('allow-always')} disabled={busy || catastrophic}>
          <ShieldCheck size={13} /> {t('approval.allowAlways')}
        </button>
        <button
          className={`btn sm ${risk.level === 'high' ? 'danger' : 'primary'}`}
          onClick={() => void decide('allow')}
          disabled={busy}
        >
          {busy ? <Spinner size={12} /> : <Check size={13} />} {t('approval.allowOnce')}
        </button>
      </div>
    </div>
  )
}

export function FullAccessModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setPermission = useAppStore((s) => s.setPermission)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    if (open) setChecked(false)
  }, [open])

  const enable = async () => {
    await updateSettings({ fullAccessAcknowledged: true })
    await setPermission('full')
    onClose()
  }

  const keepSafe = async () => {
    await setPermission('auto-safe')
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} width={560} className="full-modal">
      <div className="approval-head">
        <div className="approval-icon high">
          <ShieldAlert size={20} />
        </div>
        <div>
          <h2 className="modal-title">{t('full.title')}</h2>
          <p className="modal-desc">{t('full.desc')}</p>
        </div>
      </div>

      <ul className="risk-list">
        <li>
          <AlertTriangle size={14} />
          <span>{t('full.risk1')}</span>
        </li>
        <li>
          <AlertTriangle size={14} />
          <span>{t('full.risk2')}</span>
        </li>
        <li>
          <AlertTriangle size={14} />
          <span>{t('full.risk3')}</span>
        </li>
      </ul>

      <div className="recommend-box">
        <ShieldCheck size={15} />
        <span>{t('full.recommend')}</span>
      </div>

      <label className={`checkline ${checked ? 'checked' : ''}`}>
        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span>{t('full.check')}</span>
      </label>

      {settings.fullAccessAcknowledged && <p className="muted small">{t('approval.acknowledged')}</p>}

      <div className="modal-actions approval-actions">
        <button className="btn ghost" onClick={() => void keepSafe()}>
          {t('full.keepSafe')}
        </button>
        <button className="btn danger" disabled={!checked} onClick={() => void enable()}>
          {t('full.enable')}
        </button>
      </div>
    </Modal>
  )
}
