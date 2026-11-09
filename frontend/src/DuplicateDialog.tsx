import { useEffect, useState } from 'react'
import { api } from './api'
import { CancelledError, useJobs } from './jobs'
import { previewName } from './RenameDialog'
import { errorText, Modal, Spinner, useUi } from './ui'

export default function DuplicateDialog({
  name,
  hasFlips,
  onClose,
  onDuplicated,
}: {
  name: string
  hasFlips: boolean
  onClose: () => void
  onDuplicated: (newName: string) => void
}) {
  const { toast } = useUi()
  const { runJob } = useJobs()
  const [value, setValue] = useState<string | null>(null)
  const [includeFlips, setIncludeFlips] = useState(true)
  const [fill, setFill] = useState(false)
  const [fillColor, setFillColor] = useState('#ffffff')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api
      .suggestDuplicateName(name)
      .then((r) => setValue(r.name))
      .catch(() => setValue(`${name}_copy`))
  }, [name])

  const final = previewName(value ?? '')
  const invalid = !final || final.startsWith('.') || !/[^_.-]/.test(final)

  const submit = async () => {
    if (value === null || invalid || saving) return
    setSaving(true)
    let started: Awaited<ReturnType<typeof api.duplicateDataset>>
    try {
      // Name problems (invalid / already exists) come back here, so the dialog stays open for them.
      started = await api.duplicateDataset(name, value, includeFlips, fill ? fillColor : null)
    } catch (e) {
      toast(errorText(e), 'error')
      setSaving(false)
      return
    }
    // The copy itself runs in the background; its progress is shown in the job panel.
    onClose()
    try {
      const r = await runJob(() => Promise.resolve(started))
      toast(
        `'${name}' → '${r.name}' 복제됨 (${r.count}개${r.skipped_flips ? `, _flip ${r.skipped_flips}개 제외` : ''}${fill ? `, 투명 이미지 ${r.filled}개를 ${fillColor} 로 채움` : ''})`,
        'success',
      )
      onDuplicated(r.name)
    } catch (e) {
      if (e instanceof CancelledError) toast('복제를 취소했습니다.', 'info')
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
        <h3>데이터셋 복제</h3>
        {value === null ? (
          <Spinner />
        ) : (
          <>
            <label className="form-field">
              <span className="muted small">
                <b>{name}</b> 의 복사본 이름
              </span>
              <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
            </label>
            <div className="small">
              폴더 이름: <code>{invalid ? '-' : final}</code>
              {!invalid && final !== value.trim() && <span className="muted"> (사용할 수 없는 문자는 _ 로 바뀝니다)</span>}
            </div>
            {hasFlips && (
              <label className="check">
                <input type="checkbox" checked={!includeFlips} onChange={(e) => setIncludeFlips(!e.target.checked)} />
                _flip 파일은 복제하지 않기
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} />
              투명한 부분을 색으로 채워 불투명하게 복제
            </label>
            {fill && (
              <div className="row small fill-row">
                <input type="color" value={fillColor} onChange={(e) => setFillColor(e.target.value)} aria-label="채울 색" />
                <code>{fillColor}</code>
                {(
                  [
                    ['#ffffff', '흰색'],
                    ['#000000', '검은색'],
                    ['#808080', '회색'],
                  ] as const
                ).map(([c, label]) => (
                  <button type="button" key={c} className={`chip ${fillColor === c ? 'active' : ''}`} onClick={() => setFillColor(c)}>
                    {label}
                  </button>
                ))}
                <span className="muted">
                  PNG·WebP·TIFF 등 투명도가 있는 이미지만 바뀌고(반투명 가장자리는 자연스럽게 섞임), 나머지는 그대로 복사됩니다.
                </span>
              </div>
            )}
            <div className="dialog-msg small">
              이미지·캡션·<code>_controls</code> 폴더를 복사합니다. ai-toolkit 캐시 폴더(<code>*_cache</code>)는 학습 시 다시
              만들어지므로 복사하지 않습니다.
            </div>
          </>
        )}
        <div className="row end">
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="submit" className="primary" disabled={value === null || invalid || saving}>
            {saving ? '시작 중…' : '복제'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
