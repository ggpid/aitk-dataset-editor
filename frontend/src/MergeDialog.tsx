import { useEffect, useState } from 'react'
import { api, type MergePlan, type MergeStrategy } from './api'
import { CancelledError, useJobs } from './jobs'
import { previewName } from './RenameDialog'
import { errorText, Modal, Spinner, useUi } from './ui'

const STRATEGIES: [MergeStrategy, string, string][] = [
  ['prefix_conflicts', '겹치는 것만 접두사', '이름이 겹치는 파일만 앞에 "데이터셋이름_" 을 붙입니다'],
  ['prefix_all', '모두 접두사', '모든 파일 앞에 "데이터셋이름_" 을 붙입니다'],
  ['skip', '먼저 것 유지', '이름이 겹치면 목록에서 위쪽 데이터셋 것만 넣고 나머지는 건너뜁니다'],
]

/** Merge several datasets into a new one (sources stay as they are). */
export default function MergeDialog({
  sources: initial,
  onClose,
  onMerged,
}: {
  sources: string[]
  onClose: () => void
  onMerged: (name: string) => void
}) {
  const { toast } = useUi()
  const { runJob } = useJobs()
  const [sources, setSources] = useState(initial)
  const [name, setName] = useState(`${initial.slice(0, 3).join('_')}${initial.length > 3 ? '_etc' : ''}_merged`)
  const [strategy, setStrategy] = useState<MergeStrategy>('prefix_conflicts')
  const [includeFlips, setIncludeFlips] = useState(true)
  const [plan, setPlan] = useState<MergePlan | null>(null)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setPlan(null)
    api
      .mergeDatasets({ sources, name: '', strategy, include_flips: includeFlips, dry_run: true })
      .then((p) => !cancelled && (setPlan(p), setPlanErr(null)))
      .catch((e) => !cancelled && setPlanErr(errorText(e)))
    return () => {
      cancelled = true
    }
  }, [sources, strategy, includeFlips])

  const move = (i: number, d: number) =>
    setSources((s) => {
      const n = [...s]
      ;[n[i], n[i + d]] = [n[i + d], n[i]]
      return n
    })

  const final = previewName(name)
  const invalid = !final || final.startsWith('.') || !/[^_.-]/.test(final)
  const canSubmit = !!plan && !plan.clashes.length && !invalid && !saving

  const submit = async () => {
    if (!canSubmit) return
    setSaving(true)
    let started: Awaited<ReturnType<typeof api.mergeDatasets<false>>>
    try {
      started = await api.mergeDatasets({ sources, name, strategy, include_flips: includeFlips, dry_run: false })
    } catch (e) {
      toast(errorText(e), 'error')
      setSaving(false)
      return
    }
    onClose()
    try {
      const r = await runJob(() => Promise.resolve(started))
      toast(
        `'${r.name}' 로 합침: ${r.items}개${r.conflicts ? ` · 이름 겹침 ${r.conflicts}건 처리` : ''}${r.skipped ? ` · ${r.skipped}개 건너뜀` : ''}`,
        'success',
      )
      onMerged(r.name)
    } catch (e) {
      if (e instanceof CancelledError) toast('합치기를 취소했습니다.', 'info')
      else toast(errorText(e), 'error')
    }
  }

  return (
    <Modal onClose={() => !saving && onClose()}>
      <form
        className="dialog merge-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h3>데이터셋 합치기</h3>
        <div className="small muted">
          아래 데이터셋의 이미지와 캡션(.txt)을 새 데이터셋으로 복사합니다. 원본 데이터셋은 그대로 남습니다.
        </div>
        <ol className="merge-sources">
          {sources.map((s, i) => (
            <li key={s}>
              <span className="break">
                <b>{s}</b>
                {plan && <span className="muted small"> · {plan.per_source[s] ?? 0}개</span>}
              </span>
              <span className="row">
                <button type="button" className="ghost" onClick={() => move(i, -1)} disabled={i === 0} title="위로">
                  ↑
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => move(i, 1)}
                  disabled={i === sources.length - 1}
                  title="아래로"
                >
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ol>
        <div className="form-field">
          <span className="muted small">이름이 겹칠 때</span>
          <div className="segmented">
            {STRATEGIES.map(([v, label, help]) => (
              <button type="button" key={v} className={strategy === v ? 'active' : ''} onClick={() => setStrategy(v)} title={help}>
                {label}
              </button>
            ))}
          </div>
          <span className="muted small">{STRATEGIES.find((s) => s[0] === strategy)![2]}</span>
        </div>
        <label className="check small">
          <input type="checkbox" checked={includeFlips} onChange={(e) => setIncludeFlips(e.target.checked)} />
          <code>_flip</code> 파일도 포함 (원본과 flip 은 함께 이름이 정해져 연결이 유지됩니다)
        </label>
        <div className="merge-summary small">
          {planErr ? (
            <span className="error-text">{planErr}</span>
          ) : !plan ? (
            <Spinner />
          ) : (
            <>
              합친 결과: <b>{plan.items}</b>개
              {plan.conflict_count > 0 ? (
                <>
                  {' '}
                  · 이름 겹침 <b>{plan.conflict_count}</b>건
                  {plan.skipped > 0 && <> · {plan.skipped}개 건너뜀</>}
                  <details>
                    <summary>겹치는 이름 보기</summary>
                    <pre className="key-list">
                      {plan.conflicts.join('\n')}
                      {plan.conflict_count > plan.conflicts.length && '\n…'}
                    </pre>
                  </details>
                </>
              ) : (
                <> · 겹치는 이름 없음</>
              )}
              {plan.clashes.length > 0 && (
                <div className="error-text">
                  합친 뒤에도 이름이 겹치는 파일이 있습니다 (예: {plan.clashes.slice(0, 3).join(', ')}). 다른 방법을 고르세요.
                </div>
              )}
            </>
          )}
        </div>
        <label className="form-field">
          <span className="muted small">새 데이터셋 이름</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <div className="small">
          폴더 이름: <code>{invalid ? '-' : final}</code>
        </div>
        <div className="row end">
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            {saving ? '시작 중…' : '합치기'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
