import { useEffect, useState } from 'react'
import { api, type Settings } from '../api'
import { errorText, Spinner, useUi } from '../ui'

const SOURCE_LABEL: Record<Settings['source'], string> = {
  aitk_db: 'ai-toolkit 설정 (aitk_db.db 의 DATASETS_FOLDER)',
  default: 'ai-toolkit 기본값 (<ai-toolkit>/datasets)',
  override: '직접 지정한 폴더',
  unset: '설정되지 않음',
}

export default function SettingsPage({ onSaved }: { onSaved: (s: Settings) => void }) {
  const { toast } = useUi()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [aitkPath, setAitkPath] = useState('')
  const [override, setOverride] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s)
      setAitkPath(s.aitk_path)
      setOverride(s.datasets_override)
    })
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const s = await api.saveSettings({ aitk_path: aitkPath, datasets_override: override })
      setSettings(s)
      onSaved(s)
      toast('설정을 저장했습니다.', 'success')
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  if (!settings) return <Spinner />

  return (
    <div className="page narrow">
      <h1>설정</h1>
      <div className="card form">
        <label>
          <span>ai-toolkit 설치 경로</span>
          <input
            value={aitkPath}
            onChange={(e) => setAitkPath(e.target.value)}
            placeholder="예: C:\ai-toolkit 또는 /home/me/ai-toolkit"
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
          <small>ai-toolkit 의 run.py 가 있는 폴더입니다. 데이터셋 폴더는 ai-toolkit UI 설정을 그대로 따릅니다.</small>
        </label>
        <label>
          <span>데이터셋 폴더 직접 지정 (선택)</span>
          <input
            value={override}
            onChange={(e) => setOverride(e.target.value)}
            placeholder="비워두면 ai-toolkit 설정을 사용"
          />
        </label>
        <div className="row end">
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>

      <div className="card">
        <h3>현재 상태</h3>
        <dl className="kv">
          <dt>데이터셋 폴더</dt>
          <dd>
            <code>{settings.datasets_root ?? '-'}</code>
            {settings.datasets_root && !settings.datasets_root_exists && (
              <span className="badge warn">아직 없음 (처음 접근 시 생성)</span>
            )}
          </dd>
          <dt>출처</dt>
          <dd>{SOURCE_LABEL[settings.source]}</dd>
          <dt>ai-toolkit 확인</dt>
          <dd>
            {settings.aitk_valid ? (
              <span className="badge ok">ai-toolkit 폴더 확인됨</span>
            ) : (
              <span className="badge warn">ai-toolkit 폴더로 보이지 않음</span>
            )}
          </dd>
          {settings.error && (
            <>
              <dt>오류</dt>
              <dd className="error-text">{settings.error}</dd>
            </>
          )}
        </dl>
      </div>
    </div>
  )
}
