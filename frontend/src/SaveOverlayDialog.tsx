import { useState } from 'react'
import { api, type CompareOptions } from './api'
import { CancelledError, useJobs } from './jobs'
import { previewName } from './RenameDialog'
import { errorText, Modal, useUi } from './ui'

/** Save the overlay grid's "겹치기" view (B over A at the current opacity) as a new dataset. */
export default function SaveOverlayDialog({
  a,
  b,
  keys,
  scopeLabel,
  opacity,
  stretch,
  opts,
  onClose,
  onSaved,
}: {
  a: string
  b: string
  keys: string[]
  scopeLabel: string
  opacity: number // 0..100
  stretch: boolean
  opts: CompareOptions
  onClose: () => void
  onSaved: (name: string) => void
}) {
  const { toast } = useUi()
  const { runJob } = useJobs()
  const [value, setValue] = useState(`${a}__${b}_overlay${opacity}`)
  const [captions, setCaptions] = useState<'a' | 'b' | 'none'>('a')
  const [saving, setSaving] = useState(false)
  const final = previewName(value)
  const invalid = !final || final.startsWith('.') || !/[^_.-]/.test(final)

  const submit = async () => {
    if (invalid || saving) return
    setSaving(true)
    let started: Awaited<ReturnType<typeof api.saveOverlay>>
    try {
      // Name problems come back here, so the dialog stays open for them.
      started = await api.saveOverlay({ a, b, name: value, opacity: opacity / 100, stretch, captions, keys, ...opts })
    } catch (e) {
      toast(errorText(e), 'error')
      setSaving(false)
      return
    }
    onClose()
    try {
      const r = await runJob(() => Promise.resolve(started))
      toast(
        `'${r.name}' 데이터셋으로 저장됨 (${r.written}개${r.skipped_non_image ? `, 영상 등 ${r.skipped_non_image}개 제외` : ''})`,
        'success',
      )
      onSaved(r.name)
    } catch (e) {
      if (e instanceof CancelledError) toast('저장을 취소했습니다.', 'info')
      else toast(errorText(e), 'error')
    }
  }

  return (
    <Modal onClose={() => !saving && onClose()}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h3>겹친 이미지를 새 데이터셋으로 저장</h3>
        <ul className="plain small">
          <li>
            대상: <b>{scopeLabel}</b>
          </li>
          <li>
            A <b>{a}</b> 위에 B <b>{b}</b> 를 투명도 <b>{opacity}%</b> 로 겹침 ·{' '}
            {stretch ? 'B를 A 크기에 맞춤' : 'B를 A 안에 비율 유지로 맞춤'}
          </li>
          <li className="muted">원본 해상도로 저장되며 파일 이름·하위폴더·형식은 A 를 따릅니다.</li>
        </ul>
        <label className="form-field">
          <span className="muted small">새 데이터셋 이름</span>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <div className="small">
          폴더 이름: <code>{invalid ? '-' : final}</code>
        </div>
        <div className="row small">
          <span className="muted">캡션:</span>
          <div className="segmented">
            {(
              [
                ['a', 'A 캡션'],
                ['b', 'B 캡션'],
                ['none', '없음'],
              ] as const
            ).map(([v, label]) => (
              <button type="button" key={v} className={captions === v ? 'active' : ''} onClick={() => setCaptions(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="row end">
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="submit" className="primary" disabled={invalid || saving}>
            {saving ? '시작 중…' : '저장'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
