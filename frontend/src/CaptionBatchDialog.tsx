import { useEffect, useState } from 'react'
import { api, type CaptionOp, type CaptionPlan } from './api'
import { errorText, Modal, Spinner, useUi } from './ui'

const MODES: [CaptionOp['mode'], string][] = [
  ['prepend', '앞에 추가'],
  ['append', '뒤에 추가'],
  ['replace', '찾아 바꾸기'],
  ['set', '덮어쓰기'],
  ['clear', '캡션 비우기'],
]

const PREFS_KEY = 'aitk-editor.caption-batch'

function loadOp(): CaptionOp {
  const d: CaptionOp = {
    mode: 'prepend',
    text: '',
    separator: ', ',
    skip_if_contains: true,
    only_empty: false,
    find: '',
    replace_with: '',
    ignore_case: false,
  }
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return { ...d, mode: v.mode ?? d.mode, separator: v.separator ?? d.separator }
  } catch {
    return d
  }
}

/** Edit the captions of many items at once (selected items, or all shown). */
export default function CaptionBatchDialog({
  dataset,
  paths,
  scopeLabel,
  hasFlips,
  onClose,
  onDone,
}: {
  dataset: string
  paths: string[]
  scopeLabel: string
  hasFlips: boolean
  onClose: () => void
  onDone: () => void
}) {
  const { toast, confirm } = useUi()
  const [op, setOp] = useState<CaptionOp>(loadOp)
  const [linked, setLinked] = useState(true)
  const [plan, setPlan] = useState<CaptionPlan | null>(null)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const set = (p: Partial<CaptionOp>) => setOp((o) => ({ ...o, ...p }))

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: op.mode, separator: op.separator }))
    } catch {
      /* ignore */
    }
  }, [op.mode, op.separator])

  const incomplete =
    ((op.mode === 'prepend' || op.mode === 'append') && !op.text.trim()) || (op.mode === 'replace' && !op.find)

  useEffect(() => {
    if (incomplete) {
      setPlan(null)
      setPlanErr(null)
      return
    }
    setLoading(true)
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const p = await api.batchCaptions(dataset, { paths, op, include_linked: linked, dry_run: true })
        if (!cancelled) {
          setPlan(p)
          setPlanErr(null)
        }
      } catch (e) {
        if (!cancelled) setPlanErr(errorText(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [dataset, paths, op, linked, incomplete])

  const apply = async () => {
    if (!plan || !plan.changed || saving || loading) return
    if (
      (op.mode === 'set' || op.mode === 'clear') &&
      !(await confirm({
        title: op.mode === 'clear' ? '캡션 비우기' : '캡션 덮어쓰기',
        message: `${plan.changed}개 캡션의 기존 내용이 사라집니다.`,
        confirmText: '적용',
        danger: true,
      }))
    )
      return
    setSaving(true)
    try {
      const r = await api.batchCaptions(dataset, { paths, op, include_linked: linked, dry_run: false })
      toast(`캡션 ${r.changed}개 변경됨`, 'success')
      onDone()
      onClose()
    } catch (e) {
      toast(errorText(e), 'error')
      setSaving(false)
    }
  }

  const show = (c: string | null) =>
    c === null ? <span className="muted">(캡션 없음)</span> : c === '' ? <span className="muted">(빈 캡션)</span> : c

  return (
    <Modal onClose={() => !saving && onClose()}>
      <form
        className="dialog caption-batch"
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        <h3>일괄 캡션</h3>
        <div className="small">
          대상: <b>{scopeLabel}</b>
        </div>
        <div className="segmented">
          {MODES.map(([m, label]) => (
            <button type="button" key={m} className={op.mode === m ? 'active' : ''} onClick={() => set({ mode: m })}>
              {label}
            </button>
          ))}
        </div>

        {(op.mode === 'prepend' || op.mode === 'append') && (
          <>
            <label className="form-field">
              <span className="muted small">{op.mode === 'prepend' ? '앞에' : '뒤에'} 붙일 텍스트</span>
              <input autoFocus value={op.text} onChange={(e) => set({ text: e.target.value })} placeholder="예: sks building" />
            </label>
            <div className="row small">
              구분자
              <input className="sep-input" value={op.separator} onChange={(e) => set({ separator: e.target.value })} />
              <span className="muted">
                결과 예: <code>{op.mode === 'prepend' ? `${op.text || '텍스트'}${op.separator}기존 캡션` : `기존 캡션${op.separator}${op.text || '텍스트'}`}</code>
              </span>
            </div>
            <label className="check small">
              <input type="checkbox" checked={op.skip_if_contains} onChange={(e) => set({ skip_if_contains: e.target.checked })} />
              이미 이 텍스트가 들어 있는 캡션은 건너뛰기
            </label>
          </>
        )}
        {op.mode === 'replace' && (
          <>
            <div className="row affix-row">
              <label className="form-field">
                <span className="muted small">찾을 텍스트</span>
                <input autoFocus value={op.find} onChange={(e) => set({ find: e.target.value })} />
              </label>
              <span className="muted">→</span>
              <label className="form-field">
                <span className="muted small">바꿀 텍스트 (비우면 삭제)</span>
                <input value={op.replace_with} onChange={(e) => set({ replace_with: e.target.value })} />
              </label>
            </div>
            <label className="check small">
              <input type="checkbox" checked={op.ignore_case} onChange={(e) => set({ ignore_case: e.target.checked })} />
              대소문자 무시
            </label>
          </>
        )}
        {op.mode === 'set' && (
          <>
            <label className="form-field">
              <span className="muted small">새 캡션</span>
              <textarea autoFocus rows={3} value={op.text} onChange={(e) => set({ text: e.target.value })} />
            </label>
            <label className="check small">
              <input type="checkbox" checked={op.only_empty} onChange={(e) => set({ only_empty: e.target.checked })} />
              캡션이 없거나 비어 있는 항목만
            </label>
          </>
        )}
        {op.mode === 'clear' && <div className="small muted">대상 항목의 캡션 내용을 모두 지웁니다 (.txt 파일은 빈 파일로 남습니다).</div>}

        {hasFlips && (
          <label className="check small">
            <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
            연결된 원본/<code>_flip</code> 캡션도 함께 바꾸기
          </label>
        )}

        <div className="rename-preview">
          {incomplete ? (
            <span className="muted small">내용을 입력하면 미리보기가 나옵니다.</span>
          ) : planErr ? (
            <span className="error-text small">{planErr}</span>
          ) : !plan ? (
            <Spinner />
          ) : (
            <>
              <div className="small">
                대상 {plan.targets}개 중 <b>{plan.changed}</b>개 변경
                {loading && <Spinner />}
              </div>
              <table className="rename-table caption-preview">
                <tbody>
                  {plan.changes.map((c) => (
                    <tr key={c.path}>
                      <td className="break muted">{c.path}</td>
                      <td>
                        <div className="cap-before">{show(c.before)}</div>
                        <div className="cap-after">{show(c.after)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.changed > plan.changes.length && <div className="muted small">… 외 {plan.changed - plan.changes.length}개</div>}
            </>
          )}
        </div>

        <div className="row end">
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!plan || !plan.changed || saving || loading}>
            {saving ? '적용 중…' : plan ? `${plan.changed}개 적용` : '적용'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
