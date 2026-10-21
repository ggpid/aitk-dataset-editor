import { useEffect, useRef, useState } from 'react'
import { api, type CompareOptions, type MaskInfo, type MaskParams, type MaskResult } from './api'
import { CancelledError, useJobs } from './jobs'
import { previewName } from './RenameDialog'
import { errorText, Modal, Spinner, useUi } from './ui'

const DEFAULTS: MaskParams = {
  diff_threshold: 40,
  alpha_threshold: 16,
  open_px: 1,
  close_px: 4,
  dilate_px: 8,
  no_control: 'alpha',
}

const PARAM_FIELDS: { key: Exclude<keyof MaskParams, 'no_control'>; label: string; help: string; max: number }[] = [
  { key: 'diff_threshold', label: '색 차이 임계값', help: 'RGB 채널 차이가 이 값보다 크면 칠해진 것으로 판단 (0~255)', max: 255 },
  { key: 'alpha_threshold', label: '알파 임계값', help: '이 값보다 큰 알파를 불투명(건물)으로 간주', max: 255 },
  { key: 'open_px', label: '잡티 제거(px)', help: '작은 점 제거 반경 (0=끔)', max: 64 },
  { key: 'close_px', label: '빈틈 메우기(px)', help: '줄무늬 사이 빈틈 메우기 반경 (0=끔)', max: 64 },
  { key: 'dilate_px', label: '경계 팽창(px)', help: '외벽 경계 여유 반경', max: 128 },
]

const PREFS_KEY = 'aitk-editor.wallmask'

function loadParams(): MaskParams {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

/**
 * Wall-mask dataset generator (port of make_wall_masks.py): compares a painted target
 * with a white-building control and writes white(wall)/black masks named like the target.
 */
export default function MaskDialog({
  a,
  b,
  opts,
  onClose,
  onCreated,
}: {
  a: string
  b: string
  opts: CompareOptions
  onClose: () => void
  onCreated: () => void
}) {
  const { toast } = useUi()
  const { runJob } = useJobs()
  const [targetSide, setTargetSide] = useState<'a' | 'b'>('a')
  const target = targetSide === 'a' ? a : b
  const control = targetSide === 'a' ? b : a
  const [params, setParams] = useState<MaskParams>(loadParams)
  const [info, setInfo] = useState<MaskInfo | null>(null)
  const [key, setKey] = useState('')
  const [preview, setPreview] = useState<{ url: string; cover: number; resized: boolean } | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [name, setName] = useState(`${target}_masks`)
  const [withPreview, setWithPreview] = useState(false)
  const [previewDs, setPreviewDs] = useState(`${target}_masks_preview`)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<MaskResult | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(params))
    } catch {
      /* ignore */
    }
  }, [params])

  // Pairing info whenever the target side changes.
  useEffect(() => {
    setInfo(null)
    setName(`${target}_masks`)
    setPreviewDs(`${target}_masks_preview`)
    api
      .masksInfo({ target, control, ...opts })
      .then((i) => {
        setInfo(i)
        setKey(i.sample_keys[0] ?? '')
      })
      .catch((e) => toast(errorText(e), 'error'))
  }, [target, control, opts, toast])

  // Live preview for one pair, debounced while sliders move.
  useEffect(() => {
    if (!key) return
    setLoadingPreview(true)
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      try {
        const r = await api.masksPreview({ target, control, key, params, ...opts }, ctl.signal)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = r.url
        setPreview(r)
        setPreviewErr(null)
      } catch (e) {
        if (!ctl.signal.aborted) setPreviewErr(errorText(e))
      } finally {
        if (!ctl.signal.aborted) setLoadingPreview(false)
      }
    }, 250)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [target, control, key, params, opts])

  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), [])

  const keys = info?.sample_keys ?? []
  const ki = keys.indexOf(key)
  const finalName = previewName(name)
  const finalPreview = previewName(previewDs)
  const invalid = (n: string) => !n || n.startsWith('.') || !/[^_.-]/.test(n)
  const canSubmit =
    !!info && info.targets > 0 && !invalid(finalName) && (!withPreview || (!invalid(finalPreview) && finalPreview !== finalName))

  const submit = async () => {
    if (!canSubmit || saving) return
    setSaving(true)
    let started: Awaited<ReturnType<typeof api.makeMasks>>
    try {
      started = await api.makeMasks({
        target,
        control,
        name,
        preview_name: withPreview ? previewDs : null,
        params,
        ...opts,
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

  if (result) return <MaskResultView result={result} onClose={onClose} />

  return (
    <Modal onClose={() => !saving && onClose()}>
      <form
        className="dialog mask-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h3>외벽 마스크 데이터셋 생성</h3>
        <div className="row small">
          <span className="muted">타깃(칠해진 건물):</span>
          <div className="segmented">
            {(['a', 'b'] as const).map((s) => (
              <button type="button" key={s} className={targetSide === s ? 'active' : ''} onClick={() => setTargetSide(s)}>
                {s.toUpperCase()} · {s === 'a' ? a : b}
              </button>
            ))}
          </div>
          <span className="muted">
            컨트롤(흰 건물): <b>{control}</b>
          </span>
        </div>
        <div className="small">
          {info ? (
            <>
              타깃 {info.targets}개 · 컨트롤 짝 {info.pairs}개
              {info.only_target.length > 0 && <> · 컨트롤 없는 타깃 <b>{info.only_target.length}</b>개</>}
              {info.only_control.length > 0 && <> · 타깃 없는 컨트롤 {info.only_control.length}개(무시)</>}
            </>
          ) : (
            <Spinner />
          )}
        </div>

        <div className="mask-body">
          <div className="mask-params">
            {PARAM_FIELDS.map((f) => (
              <label key={f.key} className="mask-param" title={f.help}>
                <span>
                  {f.label} <span className="muted small">{f.help}</span>
                </span>
                <div className="row">
                  <input
                    type="range"
                    min={0}
                    max={f.key === 'diff_threshold' || f.key === 'alpha_threshold' ? 255 : Math.min(f.max, 32)}
                    value={params[f.key]}
                    onChange={(e) => setParams((p) => ({ ...p, [f.key]: +e.target.value }))}
                  />
                  <input
                    type="number"
                    min={0}
                    max={f.max}
                    value={params[f.key]}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, [f.key]: Math.max(0, Math.min(f.max, Math.round(+e.target.value || 0))) }))
                    }
                  />
                </div>
              </label>
            ))}
            <div className="mask-param">
              <span>컨트롤이 없는 타깃</span>
              <div className="segmented">
                <button
                  type="button"
                  className={params.no_control === 'alpha' ? 'active' : ''}
                  onClick={() => setParams((p) => ({ ...p, no_control: 'alpha' }))}
                >
                  건물 전체(알파)로 마스크
                </button>
                <button
                  type="button"
                  className={params.no_control === 'skip' ? 'active' : ''}
                  onClick={() => setParams((p) => ({ ...p, no_control: 'skip' }))}
                >
                  건너뜀
                </button>
              </div>
            </div>
            <button type="button" className="ghost small" onClick={() => setParams(DEFAULTS)}>
              기본값으로
            </button>
          </div>

          <div className="mask-preview">
            <div className="row">
              <button type="button" onClick={() => setKey(keys[ki - 1])} disabled={ki <= 0}>
                ‹
              </button>
              <select value={key} onChange={(e) => setKey(e.target.value)} disabled={!keys.length}>
                {keys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setKey(keys[ki + 1])} disabled={ki < 0 || ki >= keys.length - 1}>
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
                <span className="muted small">{keys.length ? '불러오는 중…' : '컨트롤과 짝이 맞는 이미지가 없습니다'}</span>
              )}
            </div>
            {preview && !previewErr && (
              <div className="small">
                왼쪽 원본 · 오른쪽 <span style={{ color: '#ff4dff' }}>자홍색 = 마스크</span> · 외벽 비율{' '}
                <b className={preview.cover < 3 || preview.cover > 95 ? 'error-text' : ''}>{preview.cover}%</b>
                {preview.resized && <span className="badge warn">컨트롤 크기가 달라 리사이즈함</span>}
              </div>
            )}
          </div>
        </div>

        <label className="form-field">
          <span className="muted small">마스크 데이터셋 이름 (ai-toolkit mask_path)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
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
          )}{' '}
          · 마스크는 타깃과 같은 이름의 PNG(흰색=외벽, 검은색=나머지)로 저장됩니다.
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

function MaskResultView({ result, onClose }: { result: MaskResult; onClose: () => void }) {
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
        {result.only_target.length > 0 && (
          <KeyList
            title={`컨트롤이 없는 타깃 ${result.only_target.length}개 (${result.no_control === 'alpha' ? '건물 전체(알파)로 대체' : '건너뜀'})`}
            keys={result.only_target}
          />
        )}
        {result.only_control.length > 0 && (
          <KeyList title={`타깃이 없는 컨트롤 ${result.only_control.length}개 (학습에 쓰이지 않음, 무시됨)`} keys={result.only_control} />
        )}
        {result.warnings.length > 0 && (
          <KeyList
            title={`확인이 필요한 이미지 ${result.warnings.length}개`}
            keys={result.warnings.map((w) => `${w.key}: ${w.notes.join(', ')}`)}
            warn
          />
        )}
        <div className="row end">
          <button className="primary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </Modal>
  )
}

function KeyList({ title, keys, warn }: { title: string; keys: string[]; warn?: boolean }) {
  return (
    <details open={warn}>
      <summary className={warn ? 'error-text' : ''}>{title}</summary>
      <pre className="key-list">{keys.join('\n')}</pre>
    </details>
  )
}
