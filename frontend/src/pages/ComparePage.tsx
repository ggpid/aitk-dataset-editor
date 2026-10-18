import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type CompareResult, type DatasetSummary, type Item, type Pair } from '../api'
import { CaptionEditor, Media } from '../components'
import DatasetCombo from '../DatasetCombo'
import OverlayViewer from '../OverlayViewer'
import PairGrid from '../PairGrid'
import { errorText, Spinner, useIncremental, useUi } from '../ui'

type Tab = 'paired' | 'only_a' | 'only_b'

const deletedText = (a: number, b: number, flips: number) =>
  `삭제 완료 — A: ${a}개, B: ${b}개${flips ? ` (+ _flip ${flips}개)` : ''}`

export default function ComparePage() {
  const { toast, confirm } = useUi()
  const [params, setParams] = useSearchParams()
  const a = params.get('a') ?? ''
  const b = params.get('b') ?? ''
  const tab = (params.get('tab') as Tab) || 'paired'
  const [opts, setOpts] = useState({ ignore_case: false, ignore_folders: false })
  const [datasets, setDatasets] = useState<DatasetSummary[]>([])
  const [result, setResult] = useState<CompareResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [selA, setSelA] = useState<Set<string>>(new Set())
  const [selB, setSelB] = useState<Set<string>>(new Set())
  const [selPairs, setSelPairs] = useState<Set<string>>(new Set())
  const lastToggled = useRef<string | null>(null)
  const [viewing, setViewing] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [pairView, setPairView] = useState<'list' | 'grid'>(() => {
    try {
      return localStorage.getItem('aitk-editor.pairview') === 'grid' ? 'grid' : 'list'
    } catch {
      return 'list'
    }
  })

  const changePairView = (v: 'list' | 'grid') => {
    setPairView(v)
    try {
      localStorage.setItem('aitk-editor.pairview', v)
    } catch {
      /* ignore */
    }
  }

  const setParam = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v) n.set(k, v)
        else n.delete(k)
        return n
      },
      { replace: true },
    )

  useEffect(() => {
    api.listDatasets().then(setDatasets).catch((e) => toast(errorText(e), 'error'))
  }, [toast])

  const load = useCallback(async () => {
    if (!a || !b) {
      setResult(null)
      return
    }
    setLoading(true)
    try {
      setResult(await api.compare(a, b, opts))
      setSelA(new Set())
      setSelB(new Set())
      setSelPairs(new Set())
    } catch (e) {
      toast(errorText(e), 'error')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }, [a, b, opts, toast])

  useEffect(() => {
    load()
  }, [load])

  const q = search.trim().toLowerCase()
  const paired = useMemo(
    () => (result?.paired ?? []).filter((p) => !q || p.key.toLowerCase().includes(q)),
    [result, q],
  )
  const onlyA = useMemo(() => (result?.only_a ?? []).filter((i) => !q || i.path.toLowerCase().includes(q)), [result, q])
  const onlyB = useMemo(() => (result?.only_b ?? []).filter((i) => !q || i.path.toLowerCase().includes(q)), [result, q])

  const deleteUnpaired = async (side: 'a' | 'b' | 'both', selection?: { a?: string[]; b?: string[] }) => {
    if (!result) return
    const countA = side === 'b' ? 0 : (selection?.a?.length ?? result.only_a.length)
    const countB = side === 'a' ? 0 : (selection?.b?.length ?? result.only_b.length)
    if (!countA && !countB) return
    const ok = await confirm({
      title: '짝없는 데이터 삭제',
      message: (
        <ul className="plain">
          {countA > 0 && (
            <li>
              A <b>{a}</b>: {countA}개
            </li>
          )}
          {countB > 0 && (
            <li>
              B <b>{b}</b>: {countB}개
            </li>
          )}
          <li className="muted">
            이미지와 캡션(.txt), 그리고 같은 이름의 <code>_flip</code> 파일까지 함께 영구 삭제됩니다.
          </li>
        </ul>
      ),
      confirmText: '삭제',
      danger: true,
    })
    if (!ok) return
    try {
      const r = await api.deleteUnpaired({
        a,
        b,
        side,
        ...opts,
        paths_a: selection?.a,
        paths_b: selection?.b,
      })
      toast(deletedText(r.deleted.a, r.deleted.b, r.flips_deleted.a + r.flips_deleted.b), 'success')
      load()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const togglePair = (key: string, shift: boolean) => {
    setSelPairs((prev) => {
      const next = new Set(prev)
      const last = lastToggled.current
      // Shift+click selects the range between the last toggled pair and this one.
      if (shift && last && last !== key) {
        const i1 = paired.findIndex((p) => p.key === last)
        const i2 = paired.findIndex((p) => p.key === key)
        if (i1 >= 0 && i2 >= 0) {
          const [s, t] = i1 < i2 ? [i1, i2] : [i2, i1]
          paired.slice(s, t + 1).forEach((p) => next.add(p.key))
          lastToggled.current = key
          return next
        }
      }
      if (next.has(key)) next.delete(key)
      else next.add(key)
      lastToggled.current = key
      return next
    })
  }

  const deletePairs = async (keys: string[], side: 'a' | 'b' | 'both') => {
    if (!result || !keys.length) return false
    const wanted = new Set(keys)
    const targets = result.paired.filter((p) => wanted.has(p.key))
    const sideText = side === 'a' ? `A (${a})` : side === 'b' ? `B (${b})` : `A (${a}) 와 B (${b}) 양쪽`
    const ok = await confirm({
      title: `짝있는 데이터 ${targets.length}쌍 삭제`,
      message: (
        <ul className="plain">
          <li>
            <b>{sideText}</b> 에서 삭제합니다.
          </li>
          {side !== 'both' && <li>남은 쪽은 짝없음 데이터가 됩니다.</li>}
          <li className="muted">
            이미지와 캡션(.txt), 그리고 같은 이름의 <code>_flip</code> 파일까지 함께 영구 삭제됩니다.
          </li>
        </ul>
      ),
      confirmText: '삭제',
      danger: true,
    })
    if (!ok) return false
    try {
      let da = 0
      let db = 0
      let flips = 0
      if (side !== 'b') {
        const r = await api.deleteItems(a, targets.map((p) => p.a.path), true)
        da = r.deleted
        flips += r.flips_deleted
      }
      if (side !== 'a') {
        const r = await api.deleteItems(b, targets.map((p) => p.b.path), true)
        db = r.deleted
        flips += r.flips_deleted
      }
      toast(deletedText(da, db, flips), 'success')
      await load()
      return true
    } catch (e) {
      toast(errorText(e), 'error')
      await load()
      return false
    }
  }

  const updatePairCaption = (side: 'a' | 'b', path: string, caption: string) =>
    setResult((r) =>
      r
        ? {
            ...r,
            paired: r.paired.map((p) => (p[side].path === path ? { ...p, [side]: { ...p[side], caption } } : p)),
          }
        : r,
    )

  return (
    <div className="page">
      <div className="page-head">
        <h1>데이터셋 비교</h1>
      </div>
      <div className="card compare-select">
        <DatasetSelect label="A" value={a} datasets={datasets} onChange={(v) => setParam('a', v)} />
        <button
          className="ghost"
          title="A/B 바꾸기"
          onClick={() =>
            setParams((p) => {
              const n = new URLSearchParams(p)
              n.set('a', b)
              n.set('b', a)
              return n
            })
          }
        >
          ⇄
        </button>
        <DatasetSelect label="B" value={b} datasets={datasets} onChange={(v) => setParam('b', v)} />
        <div className="spacer" />
        <label className="check">
          <input
            type="checkbox"
            checked={opts.ignore_case}
            onChange={(e) => setOpts((o) => ({ ...o, ignore_case: e.target.checked }))}
          />
          대소문자 무시
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={opts.ignore_folders}
            onChange={(e) => setOpts((o) => ({ ...o, ignore_folders: e.target.checked }))}
          />
          하위폴더 무시
        </label>
      </div>

      {!a || !b ? (
        <div className="empty">비교할 데이터셋 두 개를 선택하세요. 파일명(확장자 제외)이 같으면 짝으로 봅니다. _flip 파일은 비교에서 제외됩니다.</div>
      ) : loading && !result ? (
        <Spinner />
      ) : result ? (
        <>
          <div className="toolbar">
            <div className="segmented">
              <button className={tab === 'paired' ? 'active' : ''} onClick={() => setParam('tab', '')}>
                짝있음 {result.paired.length}
              </button>
              <button className={tab === 'only_a' ? 'active' : ''} onClick={() => setParam('tab', 'only_a')}>
                짝없음 · A에만 {result.only_a.length}
              </button>
              <button className={tab === 'only_b' ? 'active' : ''} onClick={() => setParam('tab', 'only_b')}>
                짝없음 · B에만 {result.only_b.length}
              </button>
            </div>
            <input placeholder="파일명 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
            <div className="spacer" />
            <div className="row">
              <span className="muted small">짝없는 데이터 삭제:</span>
              <button className="danger ghost" disabled={!result.only_a.length} onClick={() => deleteUnpaired('a')}>
                A만
              </button>
              <button className="danger ghost" disabled={!result.only_b.length} onClick={() => deleteUnpaired('b')}>
                B만
              </button>
              <button
                className="danger"
                disabled={!result.only_a.length && !result.only_b.length}
                onClick={() => deleteUnpaired('both')}
              >
                둘다
              </button>
            </div>
          </div>

          {tab === 'paired' && (
            <>
              <div className="row pair-view-switch">
                <span className="muted small">보기:</span>
                <div className="segmented">
                  <button className={pairView === 'list' ? 'active' : ''} onClick={() => changePairView('list')}>
                    나란히 (캡션 편집)
                  </button>
                  <button className={pairView === 'grid' ? 'active' : ''} onClick={() => changePairView('grid')}>
                    겹침 그리드
                  </button>
                </div>
                <div className="spacer" />
                {selPairs.size > 0 ? (
                  <>
                    <span>{selPairs.size}쌍 선택</span>
                    <button onClick={() => setSelPairs(new Set())}>선택 해제</button>
                    <span className="muted small">선택 삭제:</span>
                    <button className="danger ghost" onClick={() => deletePairs([...selPairs], 'a')}>
                      A만
                    </button>
                    <button className="danger ghost" onClick={() => deletePairs([...selPairs], 'b')}>
                      B만
                    </button>
                    <button className="danger" onClick={() => deletePairs([...selPairs], 'both')}>
                      둘다
                    </button>
                  </>
                ) : (
                  <button onClick={() => setSelPairs(new Set(paired.map((p) => p.key)))} disabled={!paired.length}>
                    보이는 짝 모두 선택
                  </button>
                )}
              </div>
              {pairView === 'grid' ? (
                <PairGrid a={a} b={b} pairs={paired} onOpen={setViewing} selected={selPairs} onToggle={togglePair} />
              ) : (
                <PairedList
                  a={a}
                  b={b}
                  pairs={paired}
                  onOpen={setViewing}
                  onCaption={updatePairCaption}
                  selected={selPairs}
                  onToggle={togglePair}
                />
              )}
            </>
          )}
          {tab === 'only_a' && (
            <UnpairedGrid
              dataset={a}
              label="A"
              items={onlyA}
              selected={selA}
              setSelected={setSelA}
              onDeleteSelected={() => deleteUnpaired('a', { a: [...selA] })}
            />
          )}
          {tab === 'only_b' && (
            <UnpairedGrid
              dataset={b}
              label="B"
              items={onlyB}
              selected={selB}
              setSelected={setSelB}
              onDeleteSelected={() => deleteUnpaired('b', { b: [...selB] })}
            />
          )}
        </>
      ) : null}

      {viewing !== null && paired[viewing] && (
        <OverlayViewer
          a={a}
          b={b}
          pairs={paired}
          index={viewing}
          setIndex={setViewing}
          onClose={() => setViewing(null)}
          onCaption={updatePairCaption}
          onDelete={async (side) => {
            const total = paired.length
            if (await deletePairs([paired[viewing].key], side)) {
              // The deleted pair drops out of the list; stay on the same position.
              if (total <= 1) setViewing(null)
              else if (viewing >= total - 1) setViewing(total - 2)
            }
          }}
        />
      )}
    </div>
  )
}

function DatasetSelect({
  label,
  value,
  datasets,
  onChange,
}: {
  label: string
  value: string
  datasets: DatasetSummary[]
  onChange: (v: string) => void
}) {
  return (
    <div className="ds-select">
      <span className={`side-badge side-${label.toLowerCase()}`}>{label}</span>
      <DatasetCombo value={value} datasets={datasets} onChange={onChange} />
    </div>
  )
}

function PairedList({
  a,
  b,
  pairs,
  onOpen,
  onCaption,
  selected,
  onToggle,
}: {
  a: string
  b: string
  pairs: Pair[]
  onOpen: (i: number) => void
  onCaption: (side: 'a' | 'b', path: string, caption: string) => void
  selected: Set<string>
  onToggle: (key: string, shift: boolean) => void
}) {
  const { visible, sentinel } = useIncremental(pairs, 60)
  if (!pairs.length) return <div className="empty">짝있는 데이터가 없습니다.</div>
  return (
    <div className="pairs">
      {visible.map((p, i) => (
        <div key={p.key} className={`pair ${selected.has(p.key) ? 'selected' : ''}`}>
          <div className="pair-head">
            <input
              type="checkbox"
              checked={selected.has(p.key)}
              onClick={(e) => onToggle(p.key, e.shiftKey)}
              readOnly
            />
            <strong className="break pair-key" onClick={(e) => onToggle(p.key, e.shiftKey)}>
              {p.key}
            </strong>
            <span className="muted small">
              {p.a.ext} · {p.b.ext}
            </span>
            <div className="spacer" />
            <button className="primary" onClick={() => onOpen(i)}>
              겹쳐보기
            </button>
          </div>
          <div className="pair-body">
            {(['a', 'b'] as const).map((side) => (
              <div key={side} className="pair-side">
                <div className="pair-media" onClick={() => onOpen(i)}>
                  <Media dataset={side === 'a' ? a : b} item={p[side]} />
                  <span className={`side-badge side-${side} floating`}>{side.toUpperCase()}</span>
                </div>
                <CaptionEditor
                  dataset={side === 'a' ? a : b}
                  item={p[side]}
                  rows={2}
                  onSaved={(c) => onCaption(side, p[side].path, c)}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
      {sentinel}
    </div>
  )
}

function UnpairedGrid({
  dataset,
  label,
  items,
  selected,
  setSelected,
  onDeleteSelected,
}: {
  dataset: string
  label: string
  items: Item[]
  selected: Set<string>
  setSelected: (s: Set<string>) => void
  onDeleteSelected: () => void
}) {
  const { visible, sentinel } = useIncremental(items)
  if (!items.length) return <div className="empty">{label} 쪽에만 있는 데이터가 없습니다.</div>
  const toggle = (path: string) => {
    const n = new Set(selected)
    if (n.has(path)) n.delete(path)
    else n.add(path)
    setSelected(n)
  }
  return (
    <>
      <div className="toolbar sub">
        <span className={`side-badge side-${label.toLowerCase()}`}>{label}</span>
        <span>
          <b>{dataset}</b> 에만 있는 항목 {items.length}개
        </span>
        <div className="spacer" />
        <button onClick={() => setSelected(new Set(items.map((i) => i.path)))}>모두 선택</button>
        <button onClick={() => setSelected(new Set())} disabled={!selected.size}>
          선택 해제
        </button>
        <button className="danger" disabled={!selected.size} onClick={onDeleteSelected}>
          선택 {selected.size}개 삭제
        </button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {visible.map((it) => (
          <div
            key={it.path}
            className={`tile ${selected.has(it.path) ? 'selected' : ''}`}
            onClick={() => toggle(it.path)}
          >
            <div className="tile-media">
              <Media dataset={dataset} item={it} />
              <input type="checkbox" className="tile-check" checked={selected.has(it.path)} readOnly />
            </div>
            <div className="tile-body">
              <div className="tile-name" title={it.path}>
                {it.path}
              </div>
              {it.caption && <div className="tile-caption">{it.caption}</div>}
            </div>
          </div>
        ))}
      </div>
      {sentinel}
    </>
  )
}
