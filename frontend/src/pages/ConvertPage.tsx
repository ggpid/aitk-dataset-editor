import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type DatasetSummary, type SamOptions, type SamPreview, type SamResult } from '../api'
import DatasetCombo from '../DatasetCombo'
import { CancelledError, useJobs } from '../jobs'
import { previewName } from '../RenameDialog'
import { errorText, Spinner, useUi } from '../ui'

type Source = 'folders' | 'datasets'

export default function ConvertPage() {
  const { toast } = useUi()
  const { runJob } = useJobs()
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [source, setSource] = useState<Source>('folders')
  const [opt, setOpt] = useState<SamOptions>({
    image_dataset: '',
    mask_dataset: null,
    image_dir: 'im',
    mask_dir: 'gt',
    output: '',
    threshold: 128,
    split: false,
    min_area: 64,
    to_jpg: true,
    skip_empty: true,
  })
  const [preview, setPreview] = useState<SamPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SamResult | null>(null)
  const set = (p: Partial<SamOptions>) => setOpt((o) => ({ ...o, ...p }))

  useEffect(() => {
    api.listDatasets().then(setDatasets).catch((e) => toast(errorText(e), 'error'))
  }, [toast])

  const ready = !!opt.image_dataset && (source === 'folders' || !!opt.mask_dataset)
  const request: SamOptions = { ...opt, mask_dataset: source === 'datasets' ? opt.mask_dataset : null }

  // Re-check the pairs whenever the source changes (debounced for typed folder names).
  useEffect(() => {
    setPreview(null)
    setPreviewError(null)
    if (!ready) return
    setLoading(true)
    const t = setTimeout(() => {
      api
        .samPreview(request)
        .then((p) => {
          setPreview(p)
          setOpt((o) => ({ ...o, output: o.output || p.suggested_output }))
        })
        .catch((e) => setPreviewError(errorText(e)))
        .finally(() => setLoading(false))
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, opt.image_dataset, opt.mask_dataset, opt.image_dir, opt.mask_dir])

  const outName = previewName(opt.output)
  const outExists = datasets.some((d) => d.name === outName)
  const canRun = ready && !!preview?.pairs && !!outName && !outExists && !running

  const run = async () => {
    setRunning(true)
    setResult(null)
    try {
      const r = await runJob(() => api.samConvert(request))
      setResult(r)
      toast(`SAM 데이터셋 '${r.name}' 생성 — 이미지 ${r.written}개, 객체 ${r.annotations}개`, 'success')
      setDatasets(await api.listDatasets())
      set({ output: '' })
    } catch (e) {
      if (e instanceof CancelledError) toast('변환을 취소했습니다. 만들던 데이터셋은 남기지 않았습니다.', 'info')
      else toast(errorText(e), 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>BiRefNet → SAM 데이터셋 변환</h1>
      </div>
      <p className="muted small convert-intro">
        BiRefNet 형식(이미지 + 같은 이름의 흑백 전경 마스크)을 SAM / SAM 2 학습용 SA-1B 형식으로 변환해 새
        데이터셋을 만듭니다. 각 이미지 옆에 같은 이름의 <code>.json</code> 이 생기고, 그 안에 객체별 마스크(COCO
        RLE)·bbox·면적·프롬프트 점이 들어갑니다. 원본은 바뀌지 않습니다.
      </p>

      <div className="card form">
        <div className="form-field">
          <span>입력 형식</span>
          <div className="segmented">
            <button className={source === 'folders' ? 'active' : ''} onClick={() => setSource('folders')}>
              한 데이터셋 안의 im / gt 폴더
            </button>
            <button className={source === 'datasets' ? 'active' : ''} onClick={() => setSource('datasets')}>
              이미지 데이터셋 + 마스크 데이터셋
            </button>
          </div>
        </div>

        <div className="convert-grid">
          <label className="form-field">
            <span>{source === 'folders' ? '데이터셋' : '이미지 데이터셋'}</span>
            <DatasetCombo value={opt.image_dataset} datasets={datasets} onChange={(v) => set({ image_dataset: v, output: '' })} />
          </label>
          {source === 'datasets' ? (
            <label className="form-field">
              <span>마스크 데이터셋</span>
              <DatasetCombo
                value={opt.mask_dataset ?? ''}
                datasets={datasets}
                onChange={(v) => set({ mask_dataset: v || null })}
              />
            </label>
          ) : (
            <div className="convert-grid inner">
              <label className="form-field">
                <span>이미지 폴더</span>
                <input value={opt.image_dir} onChange={(e) => set({ image_dir: e.target.value })} />
              </label>
              <label className="form-field">
                <span>마스크 폴더</span>
                <input value={opt.mask_dir} onChange={(e) => set({ mask_dir: e.target.value })} />
              </label>
            </div>
          )}
        </div>

        {ready && (
          <div className="convert-preview">
            {loading ? (
              <Spinner />
            ) : previewError ? (
              <span className="error-text">{previewError}</span>
            ) : preview ? (
              <>
                <div>
                  이미지 {preview.images}개 · 마스크 {preview.masks}개 → <b>짝 {preview.pairs}개</b> 변환
                </div>
                {(preview.images_without_mask > 0 || preview.masks_without_image > 0) && (
                  <div className="muted small">
                    짝 없음 — 마스크 없는 이미지 {preview.images_without_mask}개, 이미지 없는 마스크{' '}
                    {preview.masks_without_image}개 (변환에서 제외)
                  </div>
                )}
                {preview.examples.length > 0 && (
                  <div className="muted small">예: {preview.examples.join(', ')}</div>
                )}
              </>
            ) : null}
          </div>
        )}
      </div>

      <div className="card form">
        <h3>옵션</h3>
        <label className="slider">
          마스크 임계값
          <input
            type="range"
            min={1}
            max={255}
            value={opt.threshold}
            onChange={(e) => set({ threshold: +e.target.value })}
          />
          <span className="num">{opt.threshold}</span>
          <span className="muted small">이 밝기 이상을 전경으로 (부드러운 경계의 마스크용)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={opt.split} onChange={(e) => set({ split: e.target.checked })} />
          떨어져 있는 영역을 각각 별도 객체로 나누기
        </label>
        {opt.split && (
          <label className="slider indent">
            최소 면적(px)
            <input
              type="number"
              min={1}
              value={opt.min_area}
              onChange={(e) => set({ min_area: Math.max(1, +e.target.value || 1) })}
              style={{ width: 90 }}
            />
            <span className="muted small">이보다 작은 조각은 무시</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={opt.to_jpg} onChange={(e) => set({ to_jpg: e.target.checked })} />
          JPG 가 아닌 이미지는 JPG 로 저장 (SA-1B 는 .jpg 기준)
        </label>
        <label className="check">
          <input type="checkbox" checked={opt.skip_empty} onChange={(e) => set({ skip_empty: e.target.checked })} />
          전경이 비어 있는 마스크의 이미지는 제외
        </label>
      </div>

      <div className="card form">
        <label className="form-field">
          <span>새 데이터셋 이름</span>
          <input value={opt.output} onChange={(e) => set({ output: e.target.value })} placeholder="예: mydata_sam" />
        </label>
        {opt.output && (
          <div className="small">
            폴더 이름: <code>{outName || '-'}</code>
            {outExists && <span className="error-text"> 이미 존재하는 데이터셋입니다</span>}
          </div>
        )}
        <div className="row end">
          <button className="primary" disabled={!canRun} onClick={run}>
            {running ? '변환 중…' : `변환 시작${preview?.pairs ? ` (${preview.pairs}개)` : ''}`}
          </button>
        </div>
      </div>

      {result && (
        <div className="card">
          <h3>완료</h3>
          <ul className="plain">
            <li>
              새 데이터셋: <Link to={`/datasets/${encodeURIComponent(result.name)}`}>{result.name}</Link>
            </li>
            <li>
              이미지 {result.written}개 · 객체(annotation) {result.annotations}개
            </li>
            {result.empty_skipped > 0 && <li>빈 마스크로 제외: {result.empty_skipped}개</li>}
            {result.resized_masks > 0 && <li>이미지와 크기가 달라 맞춘 마스크: {result.resized_masks}개</li>}
            {result.converted_to_jpg > 0 && <li>JPG 로 변환한 이미지: {result.converted_to_jpg}개</li>}
            {result.images_without_mask + result.masks_without_image > 0 && (
              <li className="muted">
                짝이 없어 제외: 이미지 {result.images_without_mask}개, 마스크 {result.masks_without_image}개
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
