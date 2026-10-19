import { useEffect, useState } from 'react'
import { api } from './api'
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
  const [value, setValue] = useState<string | null>(null)
  const [includeFlips, setIncludeFlips] = useState(true)
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
    try {
      const r = await api.duplicateDataset(name, value, includeFlips)
      toast(
        `'${name}' → '${r.name}' 복제됨 (${r.count}개${r.skipped_flips ? `, _flip ${r.skipped_flips}개 제외` : ''})`,
        'success',
      )
      onDuplicated(r.name)
    } catch (e) {
      toast(errorText(e), 'error')
      setSaving(false)
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
            {saving ? '복제 중…' : '복제'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
