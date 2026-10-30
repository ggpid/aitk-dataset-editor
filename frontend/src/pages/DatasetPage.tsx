import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type Item, type PatternList } from '../api'
import { CaptionEditor, Media, OpenDetailButton, useArrowKeys } from '../components'
import AlphaMaskDialog from '../AlphaMaskDialog'
import PatternEditor from '../PatternEditor'
import RenameItemsDialog from '../RenameItemsDialog'
import DuplicateDialog from '../DuplicateDialog'
import { CancelledError, useJobs } from '../jobs'
import RenameDialog from '../RenameDialog'
import { errorText, formatBytes, Modal, Spinner, useIncremental, useUi } from '../ui'
import { useZoom, ZoomBadge, ZoomPane } from '../zoom'

type Filter = 'all' | 'original' | 'flip' | 'nocaption'

export default function DatasetPage() {
  const name = useParams().name!
  const { toast, confirm } = useUi()
  const [items, setItems] = useState<Item[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [thumb, setThumb] = useState(200)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [viewing, setViewing] = useState<number | null>(null)
  const { runJob, runUpload, busyDatasets } = useJobs()
  const busy = busyDatasets.has(name)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [renaming, setRenaming] = useState(false)
  const [duplicating, setDuplicating] = useState(false)
  const [alphaMasking, setAlphaMasking] = useState(false)
  const [patterns, setPatterns] = useState<PatternList | null>(null)
  const [patternItem, setPatternItem] = useState<Item | null>(null)
  const [renamingItems, setRenamingItems] = useState<string[] | null>(null)
  const navigate = useNavigate()

  const load = useCallback(async () => {
    try {
      setItems(await api.listItems(name))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [name])

  const loadPatterns = useCallback(() => {
    api
      .listPatterns(name)
      .then(setPatterns)
      .catch(() => setPatterns(null))
  }, [name])

  useEffect(() => {
    load()
    loadPatterns()
    setSelected(new Set())
  }, [load, loadPatterns])

  const shown = useMemo(() => {
    if (!items) return []
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (filter === 'original' && it.is_flip) return false
      if (filter === 'flip' && !it.is_flip) return false
      if (filter === 'nocaption' && it.caption !== null && it.caption.trim() !== '') return false
      if (q && !it.path.toLowerCase().includes(q) && !(it.caption ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [items, filter, search])

  const { visible, sentinel } = useIncremental(shown)

  // Deleting can remove several shown items at once (original + _flip); keep the viewer in range.
  useEffect(() => {
    if (viewing === null) return
    if (!shown.length) setViewing(null)
    else if (viewing >= shown.length) setViewing(shown.length - 1)
  }, [shown.length, viewing])

  const updateCaption = (path: string, caption: string) =>
    setItems((list) => list?.map((it) => (it.path === path ? { ...it, caption } : it)) ?? null)

  // Progress is shown in the job panel; here we only report the outcome and refresh
  // (also after a cancel or error, since part of the work may already be done).
  const run = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (e) {
      if (e instanceof CancelledError) toast('작업을 취소했습니다. 이미 처리된 파일은 그대로 남습니다.', 'info')
      else toast(errorText(e), 'error')
    } finally {
      await load()
    }
  }

  const upload = (files: File[]) =>
    files.length > 0 &&
    run(async () => {
      const saved = await runUpload(name, files)
      toast(`${saved.length}개 파일 업로드됨`, 'success')
    })

  /** Originals and their _flip copies are deleted together (a.png <-> a_flip.png). */
  const linkedCount = (paths: string[]) => {
    const wanted = new Set(paths)
    const keys = new Set(items?.filter((i) => wanted.has(i.path)).map((i) => i.key))
    const linked = new Set<string>()
    for (const k of keys) {
      const other = k.endsWith('_flip') ? k.slice(0, -'_flip'.length) : `${k}_flip`
      if (other && !keys.has(other)) linked.add(other)
    }
    return items?.filter((i) => linked.has(i.key) && !wanted.has(i.path)).length ?? 0
  }

  const deletePaths = async (paths: string[]) => {
    const linked = linkedCount(paths)
    const ok = await confirm({
      title: `${paths.length}개 항목 삭제`,
      message: (
        <ul className="plain">
          {linked > 0 && (
            <li>
              연결된 원본/<code>_flip</code> 항목 <b>{linked}개</b>도 함께 삭제됩니다 (총 {paths.length + linked}개).
            </li>
          )}
          <li className="muted">이미지와 캡션(.txt) 파일이 함께 영구 삭제됩니다.</li>
        </ul>
      ),
      confirmText: '삭제',
      danger: true,
    })
    if (!ok) return false
    await run(async () => {
      const r = await runJob(() => api.deleteItems(name, paths, true))
      toast(`${r.deleted}개 삭제됨${r.flips_deleted ? ` (+ 연결된 원본/_flip ${r.flips_deleted}개)` : ''}`, 'success')
      setSelected(new Set())
    })
    return true
  }

  const addFlips = async () => {
    const originals = items?.filter((i) => !i.is_flip).length ?? 0
    const ok = await confirm({
      title: '좌우 반전(flip) 이미지 추가',
      message: (
        <>
          원본 이미지 {originals}개에 대해 <code>파일명_flip.확장자</code> 로 좌우 반전된 이미지를 만들고 캡션도
          복사합니다. 이미 _flip 이 있는 항목은 건너뜁니다.
        </>
      ),
      confirmText: 'flip 추가',
    })
    if (!ok) return
    run(async () => {
      const r = await runJob(() => api.addFlips(name))
      const extra = [
        r.skipped.length ? `${r.skipped.length}개 이미 있음` : '',
        r.unsupported.length ? `${r.unsupported.length}개 미지원(영상 등)` : '',
      ]
        .filter(Boolean)
        .join(', ')
      toast(`${r.created.length}개 flip 생성${extra ? ` (${extra})` : ''}`, 'success')
    })
  }

  const removeFlips = async () => {
    const flips = items?.filter((i) => i.is_flip).length ?? 0
    const ok = await confirm({
      title: '_flip 항목 모두 제거',
      message: `파일명이 _flip 으로 끝나는 ${flips}개 항목과 캡션을 삭제합니다.`,
      confirmText: '모두 제거',
      danger: true,
    })
    if (!ok) return
    run(async () => {
      const r = await runJob(() => api.removeFlips(name))
      toast(`${r.removed.length}개 flip 제거됨`, 'success')
    })
  }

  const toggle = (path: string, e?: MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev)
      // Shift+click selects a range within the currently shown list.
      if (e?.shiftKey && prev.size) {
        const last = [...prev].pop()!
        const i1 = shown.findIndex((i) => i.path === last)
        const i2 = shown.findIndex((i) => i.path === path)
        if (i1 >= 0 && i2 >= 0) {
          const [s, t] = i1 < i2 ? [i1, i2] : [i2, i1]
          shown.slice(s, t + 1).forEach((i) => next.add(i.path))
          return next
        }
      }
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (error)
    return (
      <div className="page narrow">
        <div className="card error-card">{error}</div>
      </div>
    )
  if (!items) return <Spinner />

  const flipCount = items.filter((i) => i.is_flip).length
  const noCaption = items.filter((i) => !i.caption?.trim()).length

  return (
    <div
      className={`page ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragging(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        upload(Array.from(e.dataTransfer.files))
      }}
    >
      <div className="page-head">
        <h1>
          <Link to="/" className="muted">
            데이터셋 /
          </Link>{' '}
          {name}{' '}
          <button className="ghost rename-btn" title="이름 변경" onClick={() => setRenaming(true)} disabled={busy}>
            ✎
          </button>
        </h1>
        <div className="row">
          <button
            onClick={() => setAlphaMasking(true)}
            disabled={busy || !items.length}
            title="불투명한 부분은 흰색, 투명한 부분은 검은색인 마스크 데이터셋을 만듭니다"
          >
            🎭 불투명 영역 마스크
          </button>
          <button onClick={() => setDuplicating(true)} disabled={busy}>
            ⧉ 복제
          </button>
          <button onClick={() => fileInput.current?.click()} disabled={busy}>
            ⬆ 업로드
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept="image/*,video/*,audio/*,.txt"
            onChange={(e) => {
              upload(Array.from(e.target.files ?? []))
              e.target.value = ''
            }}
          />
          <button onClick={addFlips} disabled={busy}>
            ⇋ flip 추가
          </button>
          <button className="danger ghost" onClick={removeFlips} disabled={!flipCount || busy}>
            _flip 모두 제거
          </button>
        </div>
      </div>

      <div className="toolbar">
        <div className="segmented">
          {(
            [
              ['all', `전체 ${items.length}`],
              ['original', `원본 ${items.length - flipCount}`],
              ['flip', `flip ${flipCount}`],
              ['nocaption', `캡션 없음 ${noCaption}`],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <input placeholder="파일명/캡션 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="slider">
          크기
          <input type="range" min={120} max={420} value={thumb} onChange={(e) => setThumb(+e.target.value)} />
        </label>
        <div className="spacer" />
        {selected.size > 0 ? (
          <>
            <span>{selected.size}개 선택</span>
            <button onClick={() => setSelected(new Set())}>선택 해제</button>
            <button onClick={() => setRenamingItems([...selected])} disabled={busy}>
              접두사/접미사
            </button>
            <button className="danger" onClick={() => deletePaths([...selected])}>
              선택 삭제
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setRenamingItems(shown.map((i) => i.path))}
              disabled={!shown.length || busy}
              title="보이는 항목 전체의 파일명에 접두사/접미사를 붙입니다 (일부만 하려면 먼저 선택)"
            >
              접두사/접미사
            </button>
            <button onClick={() => setSelected(new Set(shown.map((i) => i.path)))} disabled={!shown.length}>
              보이는 항목 모두 선택
            </button>
          </>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty dropzone" onClick={() => fileInput.current?.click()}>
          이미지와 캡션(.txt)을 여기로 끌어다 놓거나 클릭해서 업로드하세요.
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumb}px, 1fr))` }}>
          {visible.map((it) => (
            <div key={it.path} className={`tile ${selected.has(it.path) ? 'selected' : ''}`}>
              <div className="tile-media" onClick={(e) => toggle(it.path, e)}>
                <Media dataset={name} item={it} size={thumb > 256 ? 512 : 384} />
                <input
                  type="checkbox"
                  className="tile-check"
                  checked={selected.has(it.path)}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(it.path, e)
                  }}
                  readOnly
                />
                {it.is_flip && <span className="tag">flip</span>}
                <OpenDetailButton onOpen={() => setViewing(shown.indexOf(it))} />
              </div>
              <div className="tile-body">
                <div className="tile-name-row">
                  <div className="tile-name" title={it.path}>
                    {it.path}
                  </div>
                  {it.kind === 'image' && (
                    <button
                      className={`pattern-btn ${patterns && it.key in patterns.items ? 'has' : ''}`}
                      title={
                        patterns && it.key in patterns.items
                          ? `${patterns.dataset} 에 패턴이 있습니다 (편집)`
                          : '패턴 가이드 그리기 / 기존 패턴 복제'
                      }
                      onClick={() => setPatternItem(it)}
                    >
                      {patterns && it.key in patterns.items ? '▦ 패턴 ✓' : '▦ 패턴'}
                    </button>
                  )}
                </div>
                <CaptionEditor dataset={name} item={it} onSaved={(c) => updateCaption(it.path, c)} />
              </div>
            </div>
          ))}
        </div>
      )}
      {sentinel}

      {viewing !== null && shown[viewing] && (
        <Lightbox
          dataset={name}
          items={shown}
          index={viewing}
          setIndex={setViewing}
          onClose={() => setViewing(null)}
          onCaption={updateCaption}
          onDelete={(it) => deletePaths([it.path])}
        />
      )}
      {renamingItems && (
        <RenameItemsDialog
          dataset={name}
          paths={renamingItems}
          scopeLabel={selected.size ? `선택한 ${renamingItems.length}개` : `보이는 항목 ${renamingItems.length}개`}
          hasFlips={items.some((i) => i.is_flip)}
          hasPatterns={!!patterns?.exists}
          onClose={() => setRenamingItems(null)}
          onDone={() => {
            setSelected(new Set())
            load()
            loadPatterns()
          }}
        />
      )}
      {patternItem && (
        <PatternEditor
          dataset={name}
          items={shown.filter((i) => i.kind === 'image')}
          startIndex={Math.max(0, shown.filter((i) => i.kind === 'image').indexOf(patternItem))}
          patterns={patterns}
          onClose={() => setPatternItem(null)}
          onSaved={loadPatterns}
        />
      )}
      {alphaMasking && <AlphaMaskDialog name={name} onClose={() => setAlphaMasking(false)} onCreated={() => {}} />}
      {duplicating && (
        <DuplicateDialog
          name={name}
          hasFlips={items.some((i) => i.is_flip)}
          onClose={() => setDuplicating(false)}
          onDuplicated={(n) => {
            setDuplicating(false)
            navigate(`/datasets/${encodeURIComponent(n)}`)
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          name={name}
          onClose={() => setRenaming(false)}
          onRenamed={(n) => {
            setRenaming(false)
            navigate(`/datasets/${encodeURIComponent(n)}`, { replace: true })
          }}
        />
      )}
      {dragging && <div className="drop-overlay">여기에 놓으면 업로드됩니다</div>}
    </div>
  )
}

function Lightbox({
  dataset,
  items,
  index,
  setIndex,
  onClose,
  onCaption,
  onDelete,
}: {
  dataset: string
  items: Item[]
  index: number
  setIndex: (i: number) => void
  onClose: () => void
  onCaption: (path: string, caption: string) => void
  onDelete: (it: Item) => void
}) {
  const it = items[index]
  const prev = useCallback(() => setIndex(Math.max(0, index - 1)), [index, setIndex])
  const next = useCallback(() => setIndex(Math.min(items.length - 1, index + 1)), [index, items.length, setIndex])
  useArrowKeys(prev, next)
  const zoom = useZoom(it.path)
  return (
    <Modal onClose={onClose} wide>
      <div className="lightbox">
        <div className="lightbox-media" ref={zoom.containerRef}>
          <button className="nav prev" onClick={prev} disabled={index === 0}>
            ‹
          </button>
          <ZoomPane zoom={zoom}>
            <Media dataset={dataset} item={it} full />
          </ZoomPane>
          <ZoomBadge zoom={zoom} hint="휠로 확대" />
          <button className="nav next" onClick={next} disabled={index === items.length - 1}>
            ›
          </button>
        </div>
        <div className="lightbox-side">
          <div className="row between">
            <strong className="break">{it.path}</strong>
            <button className="ghost" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="muted small">
            {index + 1} / {items.length} · {formatBytes(it.size)}
          </div>
          <CaptionEditor dataset={dataset} item={it} rows={10} onSaved={(c) => onCaption(it.path, c)} />
          <small className="muted">Ctrl+Enter 또는 포커스 해제 시 저장 · ←/→ 이동 · 휠 확대/축소, 드래그 이동, 더블클릭·0 원래 크기 · Esc 닫기</small>
          <div className="spacer" />
          <button className="danger" onClick={() => onDelete(it)}>
            이 항목 삭제
          </button>
        </div>
      </div>
    </Modal>
  )
}
