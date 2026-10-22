import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { api, fileUrl, type Item, type PatternList, type PatternSpec, type PatternTarget } from './api'
import { errorText, Modal, Spinner, useUi } from './ui'
import { useZoom, ZoomBadge, ZoomPane } from './zoom'

type Tool = 'pen' | 'eraser' | 'fill' | 'picker'

const WHITE = '#ffffff' // empty cells are always white
const PRESET_COLORS = ['#ffffff', '#b9b543', '#666666', '#a34f4f', '#5768bc']
const SIZE_PRESETS: [number, number][] = [
  [8, 8],
  [16, 16],
  [32, 32],
  [1, 16],
  [16, 1],
  [8, 32],
]

const sizeKey = (dataset: string) => `aitk-editor.pattern.size.${dataset}`

function savedSize(dataset: string): [number, number] | null {
  try {
    const v = JSON.parse(localStorage.getItem(sizeKey(dataset)) ?? 'null')
    return Array.isArray(v) && v.length === 2 ? [v[0], v[1]] : null
  } catch {
    return null
  }
}

const blankTile = (w: number, h: number) => Array(w * h).fill(WHITE) as string[]
const mod = (a: number, n: number) => ((a % n) + n) % n

/** Small picture of a tile (for the "existing patterns" list). */
export function TileThumb({ spec, size = 56 }: { spec: PatternSpec; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = spec.w
    c.height = spec.h
    const ctx = c.getContext('2d')!
    spec.pixels.forEach((p, i) => {
      ctx.fillStyle = p || WHITE
      ctx.fillRect(i % spec.w, Math.floor(i / spec.w), 1, 1)
    })
  }, [spec])
  const scale = size / Math.max(spec.w, spec.h)
  return (
    <canvas
      ref={ref}
      className="tile-thumb"
      style={{ width: Math.max(4, spec.w * scale), height: Math.max(4, spec.h * scale), imageRendering: 'pixelated' }}
    />
  )
}

export default function PatternEditor({
  dataset,
  items,
  startIndex,
  patterns,
  onClose,
  onSaved,
}: {
  dataset: string
  items: Item[] // image items in the order shown on the page (for 이전/다음)
  startIndex: number
  patterns: PatternList | null
  onClose: () => void
  onSaved: () => void
}) {
  const { toast, confirm } = useUi()
  const [index, setIndex] = useState(startIndex)
  const item = items[index]
  const [target, setTarget] = useState<PatternTarget | null>(null)
  const [tileW, setTileW] = useState(16)
  const [tileH, setTileH] = useState(16)
  const [pixels, setPixels] = useState<string[]>(blankTile(16, 16))
  const [sizeW, setSizeW] = useState(16) // tile size inputs (applied with 적용)
  const [sizeH, setSizeH] = useState(16)
  const [outW, setOutW] = useState<number | null>(null)
  const [outH, setOutH] = useState<number | null>(null)
  const [hasExisting, setHasExisting] = useState(false)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(PRESET_COLORS[1])
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const history = useRef<string[][]>([])
  const future = useRef<string[][]>([])
  const painting = useRef<{ erase: boolean } | null>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)
  const tileSize = useRef<[number, number]>([16, 16])
  tileSize.current = [tileW, tileH]
  const commonSize = useRef(patterns?.common_size ?? null)
  commonSize.current = patterns?.common_size ?? null
  const zoom = useZoom(item?.path)

  // Load the item: its existing pattern, or a blank white tile (current tile size kept).
  useEffect(() => {
    if (!item) return
    let cancelled = false
    setTarget(null)
    api
      .patternTarget(dataset, item.path)
      .then((t) => {
        if (cancelled) return
        setTarget(t)
        history.current = []
        future.current = []
        setDirty(false)
        setHasExisting(!!t.spec || t.mirrored)
        if (t.spec) {
          setTileW(t.spec.w)
          setTileH(t.spec.h)
          setSizeW(t.spec.w)
          setSizeH(t.spec.h)
          setPixels(t.spec.pixels)
          setOutW(t.spec.out_w)
          setOutH(t.spec.out_h)
        } else {
          setPixels(blankTile(...tileSize.current))
          // Output size: last set in this dataset → most used in its patterns → the image's size.
          const s = savedSize(dataset) ?? commonSize.current ?? [t.width, t.height]
          setOutW(s[0])
          setOutH(s[1])
        }
      })
      .catch((e) => toast(errorText(e), 'error'))
    return () => {
      cancelled = true
    }
  }, [dataset, item, toast])

  const record = useCallback(() => {
    setPixels((p) => {
      history.current.push(p)
      if (history.current.length > 200) history.current.shift()
      future.current = []
      return p
    })
  }, [])

  const setOut = (w: number, h: number) => {
    const cw = Math.max(1, Math.min(8192, Math.round(w) || 1))
    const ch = Math.max(1, Math.min(8192, Math.round(h) || 1))
    setOutW(cw)
    setOutH(ch)
    setDirty(true)
    try {
      localStorage.setItem(sizeKey(dataset), JSON.stringify([cw, ch]))
    } catch {
      /* ignore */
    }
  }

  // ---- grid editor --------------------------------------------------------
  const cellPx = Math.max(4, Math.floor(Math.min(440 / tileW, 440 / tileH)))
  useEffect(() => {
    const c = gridRef.current
    if (!c) return
    c.width = tileW * cellPx
    c.height = tileH * cellPx
    const ctx = c.getContext('2d')!
    pixels.forEach((p, i) => {
      ctx.fillStyle = p || WHITE
      ctx.fillRect((i % tileW) * cellPx, Math.floor(i / tileW) * cellPx, cellPx, cellPx)
    })
    if (cellPx >= 8) {
      ctx.strokeStyle = 'rgba(128,128,128,0.45)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x <= tileW; x++) {
        ctx.moveTo(x * cellPx + 0.5, 0)
        ctx.lineTo(x * cellPx + 0.5, tileH * cellPx)
      }
      for (let y = 0; y <= tileH; y++) {
        ctx.moveTo(0, y * cellPx + 0.5)
        ctx.lineTo(tileW * cellPx, y * cellPx + 0.5)
      }
      ctx.stroke()
    }
  }, [tileW, tileH, pixels, cellPx])

  const cellAt = (e: PointerEvent) => {
    const r = gridRef.current!.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * tileW)
    const y = Math.floor(((e.clientY - r.top) / r.height) * tileH)
    return x >= 0 && y >= 0 && x < tileW && y < tileH ? y * tileW + x : -1
  }

  const floodFill = (src: string[], start: number, value: string) => {
    const from = src[start]
    if (from === value) return src
    const out = [...src]
    const stack = [start]
    while (stack.length) {
      const i = stack.pop()!
      if (out[i] !== from) continue
      out[i] = value
      const x = i % tileW
      const y = Math.floor(i / tileW)
      if (x > 0) stack.push(i - 1)
      if (x < tileW - 1) stack.push(i + 1)
      if (y > 0) stack.push(i - tileW)
      if (y < tileH - 1) stack.push(i + tileW)
    }
    return out
  }

  // Functional update so fast strokes never drop cells between renders.
  const paintAt = (i: number, erase: boolean) => {
    if (i < 0) return
    const value = erase ? WHITE : color
    setPixels((p) => {
      if (p[i] === value) return p
      const next = [...p]
      next[i] = value
      return next
    })
    setDirty(true)
  }

  const onPointerDown = (e: PointerEvent) => {
    const i = cellAt(e)
    if (i < 0) return
    e.preventDefault()
    const erase = e.button === 2 || tool === 'eraser'
    if (tool === 'picker') {
      setColor(pixels[i] || WHITE)
      setTool('pen')
      return
    }
    record()
    if (tool === 'fill') {
      setPixels((p) => floodFill(p, i, erase ? WHITE : color))
      setDirty(true)
      return
    }
    ;(e.target as Element).setPointerCapture(e.pointerId)
    painting.current = { erase }
    paintAt(i, erase)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (painting.current) paintAt(cellAt(e), painting.current.erase)
  }
  const onPointerUp = () => {
    painting.current = null
  }

  const undo = useCallback(() => {
    const prev = history.current.pop()
    if (!prev) return
    setPixels((p) => {
      future.current.push(p)
      return prev.length === p.length ? prev : p
    })
  }, [])
  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    setPixels((p) => {
      history.current.push(p)
      return next.length === p.length ? next : p
    })
  }, [])

  const resizeTile = (w: number, h: number) => {
    w = Math.max(1, Math.min(256, Math.round(w) || 1))
    h = Math.max(1, Math.min(256, Math.round(h) || 1))
    // Keep what is already drawn (top-left aligned); new cells are white.
    const next = blankTile(w, h)
    for (let y = 0; y < Math.min(h, tileH); y++)
      for (let x = 0; x < Math.min(w, tileW); x++) next[y * w + x] = pixels[y * tileW + x]
    history.current = []
    future.current = []
    setTileW(w)
    setTileH(h)
    setSizeW(w)
    setSizeH(h)
    setPixels(next)
    setDirty(true)
  }

  const shift = (dx: number, dy: number) => {
    record()
    setPixels((p) => p.map((_, i) => p[mod(Math.floor(i / tileW) - dy, tileH) * tileW + mod((i % tileW) - dx, tileW)]))
    setDirty(true)
  }

  const loadTile = (s: PatternSpec) => {
    history.current = []
    future.current = []
    setTileW(s.w)
    setTileH(s.h)
    setSizeW(s.w)
    setSizeH(s.h)
    setPixels(s.pixels.map((p) => p || WHITE))
    setDirty(true)
  }

  // ---- save / navigate ----------------------------------------------------
  const save = async (quiet = false) => {
    if (!item || !outW || !outH) return false
    setSaving(true)
    try {
      const r = await api.savePattern(dataset, item.path, { w: tileW, h: tileH, pixels, out_w: outW, out_h: outH })
      const extra = r.written.length - 1
      if (!quiet) toast(`'${r.dataset}' 에 저장됨${extra ? ` (+ flip 거울 패턴 ${extra}개)` : ''}`, 'success')
      setDirty(false)
      setHasExisting(true)
      onSaved()
      return true
    } catch (e) {
      toast(errorText(e), 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  const go = async (delta: number) => {
    const next = index + delta
    if (next < 0 || next >= items.length || saving) return
    // Unsaved changes are saved before moving on.
    if (dirty) {
      if (!(await save(true))) return
      toast(`'${item.path}' 저장됨`, 'success')
    }
    setIndex(next)
  }

  const remove = async () => {
    const ok = await confirm({
      title: '패턴 삭제',
      message: `${patterns?.dataset ?? ''} 에서 '${item.path}' 의 패턴 이미지를 삭제합니다 (flip 거울 패턴 포함).`,
      confirmText: '삭제',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deletePattern(dataset, item.path)
      toast('패턴을 삭제했습니다.', 'success')
      setHasExisting(false)
      setDirty(false)
      onSaved()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const close = async () => {
    if (dirty && !(await confirm({ title: '저장하지 않고 닫을까요?', confirmText: '닫기', danger: true }))) return
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if ((e.ctrlKey || e.metaKey) && k === 'y') {
        e.preventDefault()
        redo()
      } else if ((e.ctrlKey || e.metaKey) && k === 's') {
        e.preventDefault()
        save()
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (k === 'b') setTool('pen')
        if (k === 'e') setTool('eraser')
        if (k === 'g') setTool('fill')
        if (k === 'i') setTool('picker')
        const n = Number(e.key)
        if (n >= 1 && n <= PRESET_COLORS.length) {
          setColor(PRESET_COLORS[n - 1])
          setTool('pen')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!item) return null
  const unique = patterns?.unique ?? []

  return (
    <Modal onClose={close} wide>
      <div className="pattern-editor">
        <div className="pe-head">
          <h3>패턴 · {item.path}</h3>
          <span className="muted small">
            → <code>{patterns?.dataset ?? `${dataset}_pattern`}</code>/{item.path.replace(/\.[^/.]+$/, '')}.png
          </span>
          {dirty && <span className="badge warn">저장 안 됨</span>}
          {!dirty && hasExisting && <span className="badge ok">저장됨</span>}
          {target?.mirrored && !target.spec && (
            <span className="badge warn">원본 패턴의 거울 이미지 · 저장하면 이 항목만 바뀝니다</span>
          )}
          <div className="spacer" />
          <span className="muted small">
            {index + 1} / {items.length}
          </span>
          <button onClick={() => go(-1)} disabled={index === 0 || saving} title="이전 데이터 (변경사항은 저장 후 이동)">
            ‹ 이전
          </button>
          <button
            className="primary"
            onClick={() => go(1)}
            disabled={index >= items.length - 1 || saving}
            title="다음 데이터 (변경사항은 저장 후 이동)"
          >
            {dirty ? '저장 후 다음 ›' : '다음 ›'}
          </button>
          <button className="ghost" onClick={close}>
            ✕
          </button>
        </div>

        {unique.length > 0 && (
          <div className="pe-unique">
            <span className="muted small">기존 패턴에서 가져오기 ({unique.length}종):</span>
            <div className="pe-unique-list">
              {unique.map((u) => (
                <button
                  key={u.digest}
                  className="pe-unique-item"
                  title={`${u.spec.w}×${u.spec.h} · ${u.count}개 사용\n${u.keys.join('\n')}`}
                  onClick={() => loadTile(u.spec)}
                >
                  <TileThumb spec={u.spec} />
                  <span className="small">
                    {u.spec.w}×{u.spec.h} · {u.count}개
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="pe-body">
          <div className="pe-tools">
            <div className="pe-group">
              <span className="pe-label">캔버스(타일) 크기</span>
              <div className="row">
                <input type="number" min={1} max={256} value={sizeW} onChange={(e) => setSizeW(+e.target.value)} />
                ×
                <input type="number" min={1} max={256} value={sizeH} onChange={(e) => setSizeH(+e.target.value)} />
                <button onClick={() => resizeTile(sizeW, sizeH)} disabled={sizeW === tileW && sizeH === tileH}>
                  적용
                </button>
              </div>
              <div className="row wrap">
                {SIZE_PRESETS.map(([w, h]) => (
                  <button key={`${w}x${h}`} className="chip" onClick={() => resizeTile(w, h)}>
                    {w}×{h}
                  </button>
                ))}
              </div>
            </div>
            <div className="pe-group">
              <span className="pe-label">저장 크기 (타일을 꽉 차게 늘림)</span>
              <div className="row">
                <input type="number" min={1} max={8192} value={outW ?? ''} onChange={(e) => setOut(+e.target.value, outH ?? 1)} />
                ×
                <input type="number" min={1} max={8192} value={outH ?? ''} onChange={(e) => setOut(outW ?? 1, +e.target.value)} />
                px
              </div>
              {target && (
                <button
                  className="chip"
                  onClick={() => setOut(target.width, target.height)}
                  disabled={outW === target.width && outH === target.height}
                >
                  원본 크기 {target.width}×{target.height}
                </button>
              )}
              <span className="muted small">이 데이터셋의 다른 데이터에도 같은 크기가 기본으로 쓰입니다.</span>
            </div>
            <div className="pe-group">
              <span className="pe-label">도구</span>
              <div className="segmented">
                {(
                  [
                    ['pen', '✏ 펜 (B)'],
                    ['eraser', '⌫ 지우개 (E)'],
                    ['fill', '🪣 채우기 (G)'],
                    ['picker', '💧 스포이드 (I)'],
                  ] as [Tool, string][]
                ).map(([t, label]) => (
                  <button key={t} className={tool === t ? 'active' : ''} onClick={() => setTool(t)}>
                    {label}
                  </button>
                ))}
              </div>
              <span className="muted small">우클릭 = 지우기(흰색) · Ctrl+Z 되돌리기 · Ctrl+S 저장</span>
            </div>
            <div className="pe-group">
              <span className="pe-label">색 (단축키 1~5)</span>
              <div className="pe-palette">
                {PRESET_COLORS.map((c, i) => (
                  <button
                    key={c}
                    className={`swatch ${c === color ? 'active' : ''}`}
                    style={{ background: c }}
                    title={`${c} (${i + 1})`}
                    onClick={() => {
                      setColor(c)
                      if (tool === 'eraser' || tool === 'picker') setTool('pen')
                    }}
                  />
                ))}
                <code className="small">{color}</code>
              </div>
            </div>
            <div className="pe-group">
              <span className="pe-label">타일 편집</span>
              <div className="row wrap">
                <button onClick={() => shift(-1, 0)} title="왼쪽으로 1칸 (순환)">
                  ←
                </button>
                <button onClick={() => shift(1, 0)} title="오른쪽으로 1칸">
                  →
                </button>
                <button onClick={() => shift(0, -1)} title="위로 1칸">
                  ↑
                </button>
                <button onClick={() => shift(0, 1)} title="아래로 1칸">
                  ↓
                </button>
                <button onClick={undo}>되돌리기</button>
                <button
                  className="danger ghost"
                  onClick={() => {
                    record()
                    setPixels(blankTile(tileW, tileH))
                    setDirty(true)
                  }}
                >
                  전체 지우기
                </button>
              </div>
            </div>
          </div>

          <div className="pe-grid">
            <canvas
              ref={gridRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onContextMenu={(e) => e.preventDefault()}
              style={{ cursor: tool === 'picker' ? 'copy' : 'crosshair' }}
            />
            <span className="muted small">
              {tileW}×{tileH} 타일 → {outW ?? '?'}×{outH ?? '?'} px 로 늘려서 저장
            </span>
          </div>

          <div className="pe-preview">
            <span className="pe-label">원본 보기</span>
            <div className="pe-original" ref={zoom.containerRef}>
              {target ? (
                <ZoomPane zoom={zoom}>
                  <img src={fileUrl(dataset, item)} alt={item.name} draggable={false} />
                </ZoomPane>
              ) : (
                <Spinner />
              )}
              <ZoomBadge zoom={zoom} hint="휠로 확대 · 드래그 이동" />
            </div>
            {target && (
              <span className="muted small">
                {target.width}×{target.height} · 더블클릭 또는 0 키로 원래 크기
              </span>
            )}
          </div>
        </div>

        <div className="pe-foot">
          {hasExisting && (
            <button className="danger ghost" onClick={remove}>
              패턴 삭제
            </button>
          )}
          <div className="spacer" />
          <button onClick={close}>닫기</button>
          <button className="primary" onClick={() => save()} disabled={saving || !target || !outW || !outH}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
