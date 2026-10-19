import { useState } from 'react'
import { api } from './api'
import { errorText, Modal, useUi } from './ui'

/** Mirrors the backend's clean_rename_name so the user sees the final folder name. */
export function previewName(name: string) {
  return name.trim().replace(/[^\p{L}\p{M}\p{N}_.-]+/gu, '_')
}

export default function RenameDialog({
  name,
  onClose,
  onRenamed,
}: {
  name: string
  onClose: () => void
  onRenamed: (newName: string) => void
}) {
  const { toast } = useUi()
  const [value, setValue] = useState(name)
  const [saving, setSaving] = useState(false)
  const final = previewName(value)
  const invalid = !final || final.startsWith('.') || !/[^_.-]/.test(final)
  const unchanged = final === name

  const submit = async () => {
    if (invalid || unchanged || saving) return
    setSaving(true)
    try {
      const r = await api.renameDataset(name, value)
      toast(`'${name}' → '${r.name}' 이름 변경됨`, 'success')
      onRenamed(r.name)
    } catch (e) {
      toast(errorText(e), 'error')
      setSaving(false)
    }
  }

  return (
    <Modal onClose={onClose}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h3>데이터셋 이름 변경</h3>
        <label className="form-field">
          <span className="muted small">새 이름</span>
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} />
        </label>
        <div className="small">
          폴더 이름: <code>{invalid ? '-' : final}</code>
          {!invalid && final !== value.trim() && <span className="muted"> (사용할 수 없는 문자는 _ 로 바뀝니다)</span>}
        </div>
        <div className="dialog-msg small">
          ai-toolkit 에서 이 데이터셋 경로를 쓰는 기존 학습 작업(job)이 있다면, 이름 변경 후에는 그 작업의 데이터셋 경로를
          새 이름으로 바꿔야 합니다.
        </div>
        <div className="row end">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={invalid || unchanged || saving}>
            {saving ? '변경 중…' : '이름 변경'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
