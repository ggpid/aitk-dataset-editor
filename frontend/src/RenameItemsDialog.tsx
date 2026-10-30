import { useEffect, useState } from 'react'
import { api, type RenamePlan } from './api'
import { errorText, Modal, Spinner, useUi } from './ui'

/** Add a prefix and/or suffix to the file names of many items at once. */
export default function RenameItemsDialog({
  dataset,
  paths,
  scopeLabel,
  hasFlips,
  hasPatterns,
  onClose,
  onDone,
}: {
  dataset: string
  paths: string[]
  scopeLabel: string
  hasFlips: boolean
  hasPatterns: boolean
  onClose: () => void
  onDone: () => void
}) {
  const { toast } = useUi()
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState('')
  const [linked, setLinked] = useState(true)
  const [patterns, setPatterns] = useState(true)
  const [plan, setPlan] = useState<RenamePlan | null>(null)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const empty = !prefix.trim() && !suffix.trim()

  // Debounced dry run for the preview and conflict check.
  useEffect(() => {
    if (empty) {
      setPlan(null)
      setPlanErr(null)
      return
    }
    setLoading(true)
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const p = await api.renameItems(dataset, {
          paths,
          prefix,
          suffix,
          include_linked: linked,
          include_patterns: patterns,
          dry_run: true,
        })
        if (!cancelled) {
          setPlan(p)
          setPlanErr(null)
        }
      } catch (e) {
        if (!cancelled) {
          setPlan(null)
          setPlanErr(errorText(e))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [dataset, paths, prefix, suffix, linked, patterns, empty])

  const canApply = !!plan && !plan.conflicts.length && !planErr && !loading && !saving

  const apply = async () => {
    if (!canApply) return
    setSaving(true)
    try {
      const r = await api.renameItems(dataset, {
        paths,
        prefix,
        suffix,
        include_linked: linked,
        include_patterns: patterns,
        dry_run: false,
      })
      toast(
        `${r.renamed}개 이름 변경됨${r.captions ? ` (캡션 ${r.captions}개` : ''}${r.captions && r.patterns ? ', ' : r.patterns ? ' (' : ''}${r.patterns ? `패턴 ${r.patterns}개` : ''}${r.captions || r.patterns ? ' 포함)' : ''}`,
        'success',
      )
      onDone()
      onClose()
    } catch (e) {
      toast(errorText(e), 'error')
      setSaving(false)
    }
  }

  return (
    <Modal onClose={() => !saving && onClose()}>
      <form
        className="dialog rename-items"
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        <h3>접두사 / 접미사 붙이기</h3>
        <div className="small">
          대상: <b>{scopeLabel}</b> · 캡션(.txt)도 함께 바뀝니다.
        </div>
        <div className="row affix-row">
          <label className="form-field">
            <span className="muted small">접두사</span>
            <input autoFocus value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="예: v2_" />
          </label>
          <code className="affix-sample">
            {prefix}
            <span className="muted">파일명</span>
            {suffix}
          </code>
          <label className="form-field">
            <span className="muted small">접미사</span>
            <input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="예: _v2" />
          </label>
        </div>
        {hasFlips && (
          <label className="check small">
            <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />
            연결된 원본/<code>_flip</code> 도 함께 (접미사는 <code>_flip</code> 앞에 붙어 연결이 유지됩니다)
          </label>
        )}
        {hasPatterns && (
          <label className="check small">
            <input type="checkbox" checked={patterns} onChange={(e) => setPatterns(e.target.checked)} />
            <code>{dataset}_pattern</code> 의 패턴 이미지도 함께
          </label>
        )}

        <div className="rename-preview">
          {empty ? (
            <span className="muted small">접두사나 접미사를 입력하면 미리보기가 나옵니다.</span>
          ) : planErr ? (
            <span className="error-text small">{planErr}</span>
          ) : !plan ? (
            <Spinner />
          ) : (
            <>
              <div className="small">
                미리보기: 파일 <b>{plan.total}</b>개
                {plan.linked > 0 && <> (연결된 원본/flip {plan.linked}개 포함)</>}
                {plan.captions > 0 && <> · 캡션 {plan.captions}개</>}
                {plan.patterns > 0 && <> · 패턴 {plan.patterns}개</>}
                {loading && <Spinner />}
              </div>
              {plan.conflicts.length > 0 && (
                <div className="error-text small">
                  이미 있는 이름과 겹쳐서 바꿀 수 없습니다 ({plan.conflicts.length}개): {plan.conflicts.slice(0, 5).join(', ')}
                  {plan.conflicts.length > 5 && ' …'}
                </div>
              )}
              <table className="rename-table">
                <tbody>
                  {plan.renames.map((r) => (
                    <tr key={r.from}>
                      <td className="break">{r.from}</td>
                      <td className="muted">→</td>
                      <td className="break">
                        <b>{r.to}</b> {r.linked && <span className="badge">연결</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.total > plan.renames.length && (
                <div className="muted small">… 외 {plan.total - plan.renames.length}개</div>
              )}
            </>
          )}
        </div>

        <div className="row end">
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!canApply}>
            {saving ? '바꾸는 중…' : plan ? `${plan.total}개 이름 바꾸기` : '이름 바꾸기'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
