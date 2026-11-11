import { useEffect, useRef, useState } from 'react'
import { api, type AlphaMaskInfo, type AlphaMaskResult } from './api'
import { CancelledError, useJobs } from './jobs'
import { previewName } from './RenameDialog'
import { errorText, Modal, Spinner, useUi } from './ui'

const PREFS_KEY = 'aitk-editor.alphamask'

type EdgePos = 'inside' | 'center' | 'outside'

interface Prefs {
  threshold: number
  grow_px: number
  opaque_color: string // "#rrggbbaa"
  transparent_color: string
  shape: 'fill' | 'edge' // whole opaque area, or only its boundary
  edge_width: number
  edge_pos: EdgePos
}

const DEFAULTS: Prefs = {
  threshold: 16,
  grow_px: 0,
  opaque_color: '#ffffffff',
  transparent_color: '#000000ff',
  shape: 'fill',
  edge_width: 4,
  edge_pos: 'inside',
}

const EDGE_POSITIONS: [EdgePos, string, string][] = [
  ['inside', '안쪽', '불투명 영역 안쪽으로 그립니다 (윤곽 밖으로 나가지 않음)'],
  ['center', '가운데', '경계에 걸쳐 안팎 절반씩 그립니다'],
  ['outside', '바깥쪽', '불투명 영역 바깥쪽 둘레에 그립니다'],
]

/** What the API takes: edge_px 0 = whole area. */
const shapeParams = (p: Prefs) => ({
  threshold: p.threshold,
  grow_px: p.grow_px,
  opaque_color: p.opaque_color,
  transparent_color: p.transparent_color,
  edge_px: p.shape === 'edge' ? p.edge_width : 0,
  edge_pos: p.edge_pos,
})

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

const COLOR_PRESETS: [string, string][] = [
  ['#ffffffff', '흰색'],
  ['#000000ff', '검은색'],
  ['#00000000', '투명'],
]

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0')

/** Colour + transparency picker producing "#rrggbbaa". */
function ColorAlphaInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const rgb = value.slice(0, 7)
  const alpha = parseInt(value.slice(7, 9) || 'ff', 16)
  const opacity = Math.round((alpha / 255) * 100)
  return (
    <div className="mask-param color-alpha">
      <span>{label}</span>
      <div className="row">
        <span className="color-chip checker" title={value}>
          <span style={{ background: rgb, opacity: alpha / 255 }} />
        </span>
        <input type="color" value={rgb} onChange={(e) => onChange(e.target.value + hex2(alpha))} aria-label={`${label} 색`} />
        <label className="slider small">
          불투명도
          <input
            type="range"
            min={0}
            max={100}
            value={opacity}
            onChange={(e) => onChange(rgb + hex2((+e.target.value / 100) * 255))}
          />
          <span className="num">{opacity}%</span>
        </label>
      </div>
      <div className="row">
        {COLOR_PRESETS.map(([v, name]) => (
          <button type="button" key={v} className={`chip ${value === v ? 'active' : ''}`} onClick={() => onChange(v)}>
            {name}
          </button>
        ))}
        <code className="small muted">{value}</code>
      </div>
    </div>
  )
}

/** Mask dataset from transparency: opaque / transparent pixels painted in chosen colours
 * (white / black by default; either may be (semi-)transparent). */
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
  const [withOverlay, setWithOverlayState] = useState(false)
  const [overlayOpacity, setOverlayOpacity] = useState(50)
  // Overlay mode saves the sources with the mask laid over them into the mask dataset itself;
  // switch the default name along unless the user typed their own.
  const setWithOverlay = (on: boolean) => {
    setWithOverlayState(on)
    setOutName((n) =>
      on && n === `${name}_masks` ? `${name}_masks_overlay` : !on && n === `${name}_masks_overlay` ? `${name}_masks` : n,
    )
  }
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
        const r = await api.alphaMaskPreview(
          name,
          { path, ...shapeParams(prefs), overlay_opacity: withOverlay ? overlayOpacity / 100 : null },
          ctl.signal,
        )
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
  }, [name, path, prefs, withOverlay, overlayOpacity])

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
        ...shapeParams(prefs),
        overlay_opacity: withOverlay ? overlayOpacity / 100 : null,
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
              {result.overlay ? '겹친 이미지' : '마스크'} <b>{result.made}</b>개 → <code>{result.name}</code>
            </li>
            {result.preview && (
              <li>
                확인용 이미지 → <code>{result.preview}</code> (왼쪽 원본, 오른쪽 저장된 마스크)
              </li>
            )}
            {result.overlay && <li>원본 위에 마스크를 겹친 이미지로 저장했습니다.</li>}
          </ul>
          {result.no_alpha.length > 0 && (
            <details open>
              <summary className="error-text">
                투명 영역이 없는 이미지 {result.no_alpha.length}개 (마스크 전체가 불투명 영역 색)
              </summary>
              <pre className="key-list">{result.no_alpha.join('\n')}</pre>
            </details>
          )}
          {result.empty.length > 0 && (
            <details open>
              <summary className="error-text">완전히 투명한 이미지 {result.empty.length}개 (마스크 전체가 투명 영역 색)</summary>
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
          <b>{name}</b> 의 각 이미지에서 불투명한 부분과 투명한 부분을 각각 지정한 색(기본: 흰색 / 검은색)으로 칠한 마스크 PNG 를 같은 이름으로 만듭니다
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
            <div className="mask-param">
              <span>마스크 모양</span>
              <div className="segmented">
                <button
                  type="button"
                  className={prefs.shape === 'fill' ? 'active' : ''}
                  onClick={() => setPrefs((p) => ({ ...p, shape: 'fill' }))}
                >
                  영역 전체
                </button>
                <button
                  type="button"
                  className={prefs.shape === 'edge' ? 'active' : ''}
                  onClick={() => setPrefs((p) => ({ ...p, shape: 'edge' }))}
                >
                  경계선만
                </button>
              </div>
            </div>
            {prefs.shape === 'edge' && (
              <>
                <label className="mask-param">
                  <span>
                    경계선 두께(px) <span className="muted small">1~64</span>
                  </span>
                  <div className="row">
                    <input
                      type="range"
                      min={1}
                      max={64}
                      value={prefs.edge_width}
                      onChange={(e) => setPrefs((p) => ({ ...p, edge_width: +e.target.value }))}
                    />
                    <input
                      type="number"
                      min={1}
                      max={64}
                      value={prefs.edge_width}
                      onChange={(e) =>
                        setPrefs((p) => ({ ...p, edge_width: Math.max(1, Math.min(64, Math.round(+e.target.value) || 1)) }))
                      }
                    />
                  </div>
                </label>
                <div className="mask-param">
                  <span>경계선 위치</span>
                  <div className="segmented">
                    {EDGE_POSITIONS.map(([v, label, help]) => (
                      <button
                        type="button"
                        key={v}
                        title={help}
                        className={prefs.edge_pos === v ? 'active' : ''}
                        onClick={() => setPrefs((p) => ({ ...p, edge_pos: v }))}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="muted small">{EDGE_POSITIONS.find((e) => e[0] === prefs.edge_pos)![2]}</span>
                </div>
              </>
            )}
            <ColorAlphaInput
              label={prefs.shape === 'edge' ? '경계선 색' : '불투명 영역 색'}
              value={prefs.opaque_color}
              onChange={(v) => setPrefs((p) => ({ ...p, opaque_color: v }))}
            />
            <ColorAlphaInput
              label={prefs.shape === 'edge' ? '나머지 영역 색' : '투명 영역 색'}
              value={prefs.transparent_color}
              onChange={(v) => setPrefs((p) => ({ ...p, transparent_color: v }))}
            />
            <button type="button" className="ghost small" onClick={() => setPrefs(DEFAULTS)}>
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
                {withOverlay ? '저장될 이미지 (원본 위에 마스크 겹침)' : '왼쪽 원본 · 오른쪽 저장될 마스크'} (체크무늬 = 투명) ·{' '}{prefs.shape === 'edge' ? '경계선' : '불투명 영역'} 비율{' '}
                <b>{preview.cover}%</b>
                {!preview.hasAlpha && <span className="badge warn">투명 영역 없음 → 전체가 불투명 영역 색</span>}
              </div>
            )}
          </div>
        </div>
        <label className="form-field">
          <span className="muted small">{withOverlay ? '저장할 데이터셋 이름' : '마스크 데이터셋 이름'}</span>
          <input value={outName} onChange={(e) => setOutName(e.target.value)} />
        </label>
        <label className="check small">
          <input type="checkbox" checked={withPreview} onChange={(e) => setWithPreview(e.target.checked)} />
          확인용 미리보기 데이터셋도 만들기
        </label>
        {withPreview && (
          <input value={previewDs} onChange={(e) => setPreviewDs(e.target.value)} aria-label="미리보기 데이터셋 이름" />
        )}
        <label className="check small">
          <input type="checkbox" checked={withOverlay} onChange={(e) => setWithOverlay(e.target.checked)} />
          원본 위에 마스크를 겹쳐서 저장 (마스크만 따로 저장하지 않음)
        </label>
        {withOverlay && (
          <div className="overlay-opts">
            <label className="slider small">
              겹침 불투명도
              <input type="range" min={0} max={100} value={overlayOpacity} onChange={(e) => setOverlayOpacity(+e.target.value)} />
              <span className="num">{overlayOpacity}%</span>
            </label>
          </div>
        )}
        <div className="small muted">
          폴더: <code>{invalid(finalName) ? '-' : finalName}</code>
          {withPreview && (
            <>
              {' '}
              · <code>{invalid(finalPreview) ? '-' : finalPreview}</code>
            </>
          )}
          {withPreview && finalPreview === finalName && <span className="error-text"> · 데이터셋 이름이 겹칩니다</span>}
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
