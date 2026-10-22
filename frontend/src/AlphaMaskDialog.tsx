import { useEffect, useRef, useState } from 'react'
import { api, type AlphaMaskInfo, type AlphaMaskResult } from './api'
import { CancelledError, useJobs } from './jobs'
import { previewName } from './RenameDialog'
import { errorText, Modal, Spinner, useUi } from './ui'

const PREFS_KEY = 'aitk-editor.alphamask'

function loadPrefs(): { threshold: number; grow_px: number } {
  const d = { threshold: 16, grow_px: 0 }
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return d
  }
}

/** Mask dataset from transparency: opaque pixels white, transparent black. */
export default function AlphaMaskDialog({
  name,
  onClose,
  onCreated,
}: {
  name: string
  onClose: () => void
  onCreated: () => void
}) {
  const { toast } = useUi()
  const { runJob } = useJobs()
  const [prefs, setPrefs] = useState(loadPrefs)
  const [info, setInfo] = useState<AlphaMaskInfo | null>(null)
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState<{ url: string; cover: number; hasAlpha: boolean } | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [includeFlips, setIncludeFlips] = useState(true)
  const [outName, setOutName] = useState(`${name}_masks`)
  const [withPreview, setWithPreview] = useState(false)
  const [previewDs, setPreviewDs] = useState(`${name}_masks_preview`)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<AlphaMaskResult | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }, [prefs])

  useEffect(() => {
    api
      .alphaMaskInfo(name)
      .then((i) => {
        setInfo(i)
        setPath(i.sample_paths[0] ?? '')
      })
      .catch((e) => toast(errorText(e), 'error'))
  }, [name, toast])

  useEffect(() => {
    if (!path) return
    setLoadingPreview(true)
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const r = await api.alphaMaskPreview(name, { path, ...prefs }, ctl.signal)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = r.url
        setPreview(r)
        setPreviewErr(null)
      } catch (e) {
        if (!ctl.signal.aborted) setPreviewErr(errorText(e))
      } finally {
        if (!ctl.signal.aborted) setLoadingPreview(false)
      }
    }, 200)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [name, path, prefs])

  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), [])

  const paths = info?.sample_paths ?? []
  const pi = paths.indexOf(path)
  const invalid = (n: string) => !n || n.startsWith('.') || !/[^_.-]/.test(n)
  const finalName = previewName(outName)
  const finalPreview = previewName(previewDs)
  const count = info ? (includeFlips ? info.images : info.images - info.flips) : 0
  const canSubmit =
    count > 0 && !invalid(finalName) && (!withPreview || (!invalid(finalPreview) && finalPreview !== finalName))

  const submit = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    let started: Awaited<ReturnType<typeof api.makeAlphaMasks>>
    try {
      started = await api.makeAlphaMasks(name, {
        name: outName,
        preview_name: withPreview ? previewDs : null,
        include_flips: includeFlips,
        ...prefs,
      })
    } catch (e) {
      toast(errorText(e), 'error')
      setSaving(false)
      return
    }
    try {
      const r = await runJob(() => Promise.resolve(started))
      onCreated()
      setResult(r)
    } catch (e) {
      if (e instanceof CancelledError) toast('마스크 생성을 취소했습니다.', 'info')
      else toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  if (result)
    return (
      <Modal onClose={onClose}>
        <div className="dialog mask-dialog">
          <h3>마스크 생성 완료</h3>
          <ul className="plain">
            <li>
              마스크 <b>{result.made}</b>개 → <code>{result.name}</code>
            </li>
            {result.preview && (
              <li>
                확인용 이미지 → <code>{result.preview}</code> (왼쪽 원본, 오른쪽 자홍색 = 마스크)
              </li>
            )}
          </ul>
          {result.no_alpha.length > 0 && (
            <details open>
              <summary className="error-text">
                투명 영역이 없는 이미지 {result.no_alpha.length}개 (마스크가 전부 흰색)
              </summary>
              <pre className="key-list">{result.no_alpha.join('\n')}</pre>
            </details>
          )}
          {result.empty.length > 0 && (
            <details open>
              <summary className="error-text">완전히 투명한 이미지 {result.empty.length}개 (마스크가 전부 검은색)</summary>
              <pre className="key-list">{result.empty.join('\n')}</pre>
            </details>
          )}
          <div className="row end">
            <button className="primary" onClick={onClose}>
              닫기
            </button>
          </div>
        </div>
      </Modal>
    )

  return (
    <Modal onClose={() => !saving && onClose()}>
      <form
        className="dialog mask-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h3>불투명 영역 마스크 데이터셋 생성</h3>
        <div className="small">
          <b>{name}</b> 의 각 이미지에서 불투명한 부분은 흰색, 투명한 부분은 검은색인 마스크 PNG 를 같은 이름으로 만듭니다
          (ai-toolkit <code>mask_path</code> 용).{' '}
          {info ? <>이미지 {count}개 대상.</> : <Spinner />}
        </div>
        <div className="mask-body">
          <div className="mask-params">
            <label className="mask-param">
              <span>
                알파 임계값 <span className="muted small">이 값보다 큰 알파를 불투명으로 간주 (0~255)</span>
              </span>
              <div className="row">
                <input
                  type="range"
                  min={0}
                  max={254}
                  value={prefs.threshold}
                  onChange={(e) => setPrefs((p) => ({ ...p, threshold: +e.target.value }))}
                />
                <input
                  type="number"
                  min={0}
                  max={254}
                  value={prefs.threshold}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, threshold: Math.max(0, Math.min(254, Math.round(+e.target.value || 0))) }))
                  }
                />
              </div>
            </label>
            <label className="mask-param">
              <span>
                경계 조정(px) <span className="muted small">+ 확장 / − 축소, 0 = 그대로</span>
              </span>
              <div className="row">
                <input
                  type="range"
                  min={-32}
                  max={32}
                  value={prefs.grow_px}
                  onChange={(e) => setPrefs((p) => ({ ...p, grow_px: +e.target.value }))}
                />
                <input
                  type="number"
                  min={-128}
                  max={128}
                  value={prefs.grow_px}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, grow_px: Math.max(-128, Math.min(128, Math.round(+e.target.value || 0))) }))
                  }
                />
              </div>
            </label>
            {info && info.flips > 0 && (
              <label className="check small">
                <input type="checkbox" checked={includeFlips} onChange={(e) => setIncludeFlips(e.target.checked)} />
                <code>_flip</code> 이미지도 포함 ({info.flips}개)
              </label>
            )}
            <button type="button" className="ghost small" onClick={() => setPrefs({ threshold: 16, grow_px: 0 })}>
              기본값으로
            </button>
          </div>
          <div className="mask-preview">
            <div className="row">
              <button type="button" onClick={() => setPath(paths[pi - 1])} disabled={pi <= 0}>
                ‹
              </button>
              <select value={path} onChange={(e) => setPath(e.target.value)} disabled={!paths.length}>
                {paths.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setPath(paths[pi + 1])} disabled={pi < 0 || pi >= paths.length - 1}>
                ›
              </button>
              {loadingPreview && <Spinner />}
            </div>
            <div className="mask-preview-img">
              {previewErr ? (
                <span className="error-text small">{previewErr}</span>
              ) : preview ? (
                <img src={preview.url} alt="미리보기" />
              ) : (
                <span className="muted small">{info && !paths.length ? '이미지가 없습니다' : '불러오는 중…'}</span>
              )}
            </div>
            {preview && !previewErr && (
              <div className="small">
                왼쪽 원본 · 오른쪽 <span style={{ color: '#ff4dff' }}>자홍색 = 마스크</span> · 마스크 비율{' '}
                <b>{preview.cover}%</b>
                {!preview.hasAlpha && <span className="badge warn">투명 영역 없음 → 전부 흰색</span>}
              </div>
            )}
          </div>
        </div>
        <label className="form-field">
          <span className="muted small">마스크 데이터셋 이름</span>
          <input value={outName} onChange={(e) => setOutName(e.target.value)} />
        </label>
        <label className="check small">
          <input type="checkbox" checked={withPreview} onChange={(e) => setWithPreview(e.target.checked)} />
          확인용 미리보기 데이터셋도 만들기
        </label>
        {withPreview && (
          <input value={previewDs} onChange={(e) => setPreviewDs(e.target.value)} aria-label="미리보기 데이터셋 이름" />
        )}
        <div className="small muted">
          폴더: <code>{invalid(finalName) ? '-' : finalName}</code>
          {withPreview && (
            <>
              {' '}
              · <code>{invalid(finalPreview) ? '-' : finalPreview}</code>
            </>
          )}
        </div>
        <div className="row end">
          <button type="button" onClick={onClose} disabled={saving}>
            닫기
          </button>
          <button type="submit" className="primary" disabled={!canSubmit || saving}>
            {saving ? '생성 중…' : '마스크 생성'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
