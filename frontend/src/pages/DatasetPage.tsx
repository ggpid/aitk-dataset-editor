import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Item } from '../api'
import { CaptionEditor, Media, useArrowKeys } from '../components'
import { errorText, formatBytes, Modal, Spinner, useIncremental, useUi } from '../ui'

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
  const [busy, setBusy] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setItems(await api.listItems(name))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [name])

  useEffect(() => {
    load()
    setSelected(new Set())
  }, [load])

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

  const updateCaption = (path: string, caption: string) =>
    setItems((list) => list?.map((it) => (it.path === path ? { ...it, caption } : it)) ?? null)

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const upload = (files: File[]) =>
    run('업로드 중…', async () => {
      if (!files.length) return
      const res = await api.upload(name, files)
      toast(`${res.files.length}개 파일 업로드됨`, 'success')
      await load()
    })

  const deletePaths = async (paths: string[]) => {
    const ok = await confirm({
      title: `${paths.length}개 항목 삭제`,
      message: '이미지와 캡션(.txt) 파일이 함께 삭제됩니다.',
      confirmText: '삭제',
      danger: true,
    })
    if (!ok) return false
    await run('삭제 중…', async () => {
      const r = await api.deleteItems(name, paths)
      toast(`${r.deleted}개 삭제됨`, 'success')
      setSelected(new Set())
      await load()
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
    run('flip 이미지 생성 중…', async () => {
      const r = await api.addFlips(name)
      const extra = [
        r.skipped.length ? `${r.skipped.length}개 이미 있음` : '',
        r.unsupported.length ? `${r.unsupported.length}개 미지원(영상 등)` : '',
      ]
        .filter(Boolean)
        .join(', ')
      toast(`${r.created.length}개 flip 생성${extra ? ` (${extra})` : ''}`, 'success')
      await load()
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
    run('flip 제거 중…', async () => {
      const r = await api.removeFlips(name)
      toast(`${r.removed.length}개 flip 제거됨`, 'success')
      await load()
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
          {name}
        </h1>
        <div className="row">
          <button onClick={() => fileInput.current?.click()}>⬆ 업로드</button>
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
          <button onClick={addFlips}>⇋ flip 추가</button>
          <button className="danger ghost" onClick={removeFlips} disabled={!flipCount}>
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
            <button className="danger" onClick={() => deletePaths([...selected])}>
              선택 삭제
            </button>
          </>
        ) : (
          <button onClick={() => setSelected(new Set(shown.map((i) => i.path)))} disabled={!shown.length}>
            보이는 항목 모두 선택
          </button>
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
              <div className="tile-media" onClick={() => setViewing(shown.indexOf(it))}>
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
              </div>
              <div className="tile-body">
                <div className="tile-name" title={it.path}>
                  {it.path}
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
          onDelete={async (it) => {
            if (await deletePaths([it.path])) {
              if (viewing >= shown.length - 1) setViewing(shown.length > 1 ? viewing - 1 : null)
            }
          }}
        />
      )}
      {busy && (
        <div className="busy">
          <Spinner /> {busy}
        </div>
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
  return (
    <Modal onClose={onClose} wide>
      <div className="lightbox">
        <div className="lightbox-media">
          <button className="nav prev" onClick={prev} disabled={index === 0}>
            ‹
          </button>
          <Media dataset={dataset} item={it} full />
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
          <small className="muted">Ctrl+Enter 또는 포커스 해제 시 저장 · ←/→ 이동 · Esc 닫기</small>
          <div className="spacer" />
          <button className="danger" onClick={() => onDelete(it)}>
            이 항목 삭제
          </button>
        </div>
      </div>
    </Modal>
  )
}
