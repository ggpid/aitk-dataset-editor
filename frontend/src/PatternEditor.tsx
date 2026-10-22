import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { api, fileUrl, type Item, type PatternList, type PatternSpec, type PatternTarget } from './api'
import { errorText, Modal, Spinner, useUi } from './ui'

type Tool = 'pen' | 'eraser' | 'fill' | 'picker'

const SIZE_PRESETS: [number, number][] = [
  [8, 8],
  [16, 16],
  [32, 32],
  [1, 16],
  [16, 1],
  [8, 32],
]
const BASE_COLORS = ['#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#808080']
const RECENT_KEY = 'aitk-editor.pattern.recent'

export const emptySpec = (w = 16, h = 16): PatternSpec => ({
  w,
  h,
  cell: 8,
  pixels: Array(w * h).fill(''),
  anchor: 'bbox',
  offset_x: 0,
  offset_y: 0,
  clip: 'none',
  background: '',
})

const hexRgba = (hex: string): [number, number, number, number] =>
  hex ? [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255] : [0, 0, 0, 0]

const mod = (a: number, n: number) => ((a % n) + n) % n

/**
 * Render a spec at an image's size: same formula as backend pattern.render
 * (tile index = floor((x - origin) / cell) mod w).
 */
export function renderGuide(spec: PatternSpec, t: PatternTarget, alpha: Uint8ClampedArray | null): ImageData {
  const { width, height } = t
  const img = new ImageData(width, height)
  const tile = spec.pixels.map((p) => (p ? hexRgba(p) : spec.background ? hexRgba(spec.background) : hexRgba('')))
  const ax = spec.anchor === 'bbox' && t.bbox ? t.bbox[0] : 0
  const ay = spec.anchor === 'bbox' && t.bbox ? t.bbox[1] : 0
  const ox = ax + spec.offset_x
  const oy = ay + spec.offset_y
  const cols = new Int32Array(width)
  for (let x = 0; x < width; x++) cols[x] = mod(Math.floor((x - ox) / spec.cell), spec.w)
  const d = img.data
  for (let y = 0; y < height; y++) {
    const row = mod(Math.floor((y - oy) / spec.cell), spec.h) * spec.w
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (spec.clip === 'opaque' && alpha && alpha[y * width + x] <= 16) continue
      const c = tile[row + cols[x]]
      d[i] = c[0]
      d[i + 1] = c[1]
      d[i + 2] = c[2]
      d[i + 3] = c[3]
    }
  }
  return img
}

/** Small picture of a tile (for the "existing patterns" list). */
export function TileThumb({ spec, size = 56 }: { spec: PatternSpec; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = spec.w
    c.height = spec.h
    const ctx = c.getContext('2d')!
    const img = ctx.createImageData(spec.w, spec.h)
    spec.pixels.forEach((p, i) => img.data.set(hexRgba(p || spec.background), i * 4))
    ctx.putImageData(img, 0, 0)
  }, [spec])
  const scale = size / Math.max(spec.w, spec.h)
  return (
    <canvas
      ref={ref}
      className="tile-thumb checker"
      style={{ width: spec.w * scale, height: spec.h * scale, imageRendering: 'pixelated' }}
    />
  )
}

export default function PatternEditor({
  dataset,
  item,
  patterns,
  onClose,
  onSaved,
}: {
  dataset: string
  item: Item
  patterns: PatternList | null
  onClose: () => void
  onSaved: () => void
}) {
  const { toast, confirm } = useUi()
  const [target, setTarget] = useState<PatternTarget | null>(null)
  const [spec, setSpec] = useState<PatternSpec>(emptySpec())
  const [hasExisting, setHasExisting] = useState(false)
  const [sizeW, setSizeW] = useState(16)
  const [sizeH, setSizeH] = useState(16)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState('#ffffff')
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    } catch {
      return []
    }
  })
  const [overlay, setOverlay] = useState(60)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const history = useRef<string[][]>([])
  const future = useRef<string[][]>([])
  const painting = useRef<{ erase: boolean } | null>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const alphaRef = useRef<Uint8ClampedArray | null>(null)
  const [imgReady, setImgReady] = useState(false)
  const imgRef = useRef<HTMLImageElement | null>(null)

  // Load the image's geometry and its existing pattern (if any).
  useEffect(() => {
    api
      .patternTarget(dataset, item.path)
      .then((t) => {
        setTarget(t)
        if (t.spec) {
          setSpec(t.spec)
          setSizeW(t.spec.w)
          setSizeH(t.spec.h)
          setHasExisting(true)
        } else if (t.mirrored) {
          setHasExisting(true)
        }
      })
      .catch((e) => toast(errorText(e), 'error'))
  }, [dataset, item.path, toast])

  // Source image (for the preview underlay and the opaque-area clip).
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      imgRef.current = img
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      const a = new Uint8ClampedArray(c.width * c.height)
      for (let i = 0; i < a.length; i++) a[i] = data[i * 4 + 3]
      alphaRef.current = a
      setImgReady(true)
    }
    img.src = fileUrl(dataset, item)
  }, [dataset, item])

  const update = useCallback((next: Partial<PatternSpec>, record = true) => {
    setSpec((s) => {
      if (record && next.pixels) {
        history.current.push(s.pixels)
        if (history.current.length > 200) history.current.shift()
        future.current = []
      }
      return { ...s, ...next }
    })
    setDirty(true)
  }, [])

  const pickColor = (c: string) => {
    setColor(c)
    if (!c) return
    setRecent((r) => {
      const next = [c, ...r.filter((x) => x !== c)].slice(0, 12)
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  // ---- grid editor --------------------------------------------------------
  const zoom = Math.max(4, Math.floor(Math.min(420 / spec.w, 420 / spec.h)))
  useEffect(() => {
    const c = gridRef.current
    if (!c) return
    c.width = spec.w * zoom
    c.height = spec.h * zoom
    const ctx = c.getContext('2d')!
    // checkerboard for transparency
    for (let y = 0; y < spec.h; y++)
      for (let x = 0; x < spec.w; x++) {
        const p = spec.pixels[y * spec.w + x]
        if (p) ctx.fillStyle = p
        else ctx.fillStyle = (x + y) % 2 ? '#3a3f4b' : '#2b2f38'
        ctx.fillRect(x * zoom, y * zoom, zoom, zoom)
      }
    if (zoom >= 8) {
      ctx.strokeStyle = 'rgba(128,128,128,0.35)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x <= spec.w; x++) {
        ctx.moveTo(x * zoom + 0.5, 0)
        ctx.lineTo(x * zoom + 0.5, spec.h * zoom)
      }
      for (let y = 0; y <= spec.h; y++) {
        ctx.moveTo(0, y * zoom + 0.5)
        ctx.lineTo(spec.w * zoom, y * zoom + 0.5)
      }
      ctx.stroke()
    }
  }, [spec.w, spec.h, spec.pixels, zoom])

  const cellAt = (e: PointerEvent) => {
    const r = gridRef.current!.getBoundingClientRect()
    const x = Math.floor(((e.clientX - r.left) / r.width) * spec.w)
    const y = Math.floor(((e.clientY - r.top) / r.height) * spec.h)
    return x >= 0 && y >= 0 && x < spec.w && y < spec.h ? y * spec.w + x : -1
  }

  const floodFill = (pixels: string[], start: number, value: string) => {
    const from = pixels[start]
    if (from === value) return pixels
    const out = [...pixels]
    const stack = [start]
    while (stack.length) {
      const i = stack.pop()!
      if (out[i] !== from) continue
      out[i] = value
      const x = i % spec.w
      const y = Math.floor(i / spec.w)
      if (x > 0) stack.push(i - 1)
      if (x < spec.w - 1) stack.push(i + 1)
      if (y > 0) stack.push(i - spec.w)
      if (y < spec.h - 1) stack.push(i + spec.w)
    }
    return out
  }

  // Functional update so fast strokes never drop cells between renders.
  const paintAt = (i: number, erase: boolean) => {
    if (i < 0) return
    const value = erase ? '' : color
    setSpec((s) => {
      if (s.pixels[i] === value) return s
      const pixels = [...s.pixels]
      pixels[i] = value
      return { ...s, pixels }
    })
    setDirty(true)
  }

  const onPointerDown = (e: PointerEvent) => {
    const i = cellAt(e)
    if (i < 0) return
    e.preventDefault()
    const erase = e.button === 2 || tool === 'eraser'
    if (tool === 'picker') {
      const c = spec.pixels[i]
      if (c) pickColor(c)
      setTool('pen')
      return
    }
    if (tool === 'fill') {
      update({ pixels: floodFill(spec.pixels, i, erase ? '' : color) })
      return
    }
    ;(e.target as Element).setPointerCapture(e.pointerId)
    painting.current = { erase }
    // One undo step per stroke: record before the first cell only.
    history.current.push(spec.pixels)
    future.current = []
    paintAt(i, erase)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (painting.current) paintAt(cellAt(e), painting.current.erase)
  }
  const onPointerUp = () => {
    painting.current = null
    if (tool === 'pen' || tool === 'eraser') pickColor(color)
  }

  const undo = useCallback(() => {
    const prev = history.current.pop()
    if (!prev) return
    setSpec((s) => {
      future.current.push(s.pixels)
      return prev.length === s.w * s.h ? { ...s, pixels: prev } : s
    })
  }, [])
  const redo = useCallback(() => {
    const next = future.current.pop()
    if (!next) return
    setSpec((s) => {
      history.current.push(s.pixels)
      return next.length === s.w * s.h ? { ...s, pixels: next } : s
    })
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      } else if (!e.ctrlKey && !e.metaKey) {
        const k = e.key.toLowerCase()
        if (k === 'b') setTool('pen')
        if (k === 'e') setTool('eraser')
        if (k === 'g') setTool('fill')
        if (k === 'i') setTool('picker')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const resize = (w: number, h: number) => {
    w = Math.max(1, Math.min(256, Math.round(w) || 1))
    h = Math.max(1, Math.min(256, Math.round(h) || 1))
    // Keep what is already drawn (top-left aligned).
    const pixels = Array(w * h).fill('')
    for (let y = 0; y < Math.min(h, spec.h); y++)
      for (let x = 0; x < Math.min(w, spec.w); x++) pixels[y * w + x] = spec.pixels[y * spec.w + x]
    history.current = []
    future.current = []
    setSizeW(w)
    setSizeH(h)
    update({ w, h, pixels }, false)
  }

  const shift = (dx: number, dy: number) => {
    const pixels = spec.pixels.map((_, i) => {
      const x = i % spec.w
      const y = Math.floor(i / spec.w)
      return spec.pixels[mod(y - dy, spec.h) * spec.w + mod(x - dx, spec.w)]
    })
    update({ pixels })
  }

  const loadSpec = (s: PatternSpec) => {
    history.current.push(spec.pixels)
    setSpec(s)
    setSizeW(s.w)
    setSizeH(s.h)
    setDirty(true)
  }

  // ---- full-size preview --------------------------------------------------
  const guide = useMemo(
    () => (target && imgReady ? renderGuide(spec, target, alphaRef.current) : null),
    [spec, target, imgReady],
  )
  useEffect(() => {
    const c = previewRef.current
    if (!c || !guide || !target) return
    c.width = target.width
    c.height = target.height
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    if (imgRef.current && overlay < 100) ctx.drawImage(imgRef.current, 0, 0, target.width, target.height)
    const g = document.createElement('canvas')
    g.width = target.width
    g.height = target.height
    g.getContext('2d')!.putImageData(guide, 0, 0)
    ctx.globalAlpha = overlay / 100
    ctx.drawImage(g, 0, 0)
    ctx.globalAlpha = 1
    if (target.bbox && spec.anchor === 'bbox') {
      ctx.strokeStyle = '#ff4dff'
      ctx.lineWidth = Math.max(1, target.width / 400)
      ctx.setLineDash([6, 4])
      const [x0, y0, x1, y1] = target.bbox
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
    }
  }, [guide, overlay, target, spec.anchor])

  const save = async () => {
    setSaving(true)
    try {
      const r = await api.savePattern(dataset, item.path, spec)
      const extra = r.written.length - 1
      toast(`'${r.dataset}' 에 저장됨${extra ? ` (+ flip 거울 패턴 ${extra}개)` : ''}`, 'success')
      setDirty(false)
      onSaved()
      onClose()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setSaving(false)
    }
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
      onSaved()
      onClose()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const close = async () => {
    if (dirty && !(await confirm({ title: '저장하지 않고 닫을까요?', confirmText: '닫기', danger: true }))) return
    onClose()
  }

  const unique = patterns?.unique ?? []
  const palette = [...new Set([...recent, ...BASE_COLORS])].slice(0, 18)

  return (
    <Modal onClose={close} wide>
      <div className="pattern-editor">
        <div className="pe-head">
          <h3>패턴 · {item.path}</h3>
          <span className="muted small">
            → <code>{patterns?.dataset ?? `${dataset}_pattern`}</code>/{item.path.replace(/\.[^/.]+$/, '')}.png
            {target && ` · ${target.width}×${target.height}`}
          </span>
          {target?.mirrored && !target.spec && (
            <span className="badge warn">지금은 원본 패턴의 거울 이미지입니다. 저장하면 이 항목만 따로 바뀝니다.</span>
          )}
          <div className="spacer" />
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
                  title={`${u.spec.w}×${u.spec.h} · 셀 ${u.spec.cell}px · ${u.count}개 사용\n${u.keys.join('\n')}`}
                  onClick={() => loadSpec(u.spec)}
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
                <button onClick={() => resize(sizeW, sizeH)} disabled={sizeW === spec.w && sizeH === spec.h}>
                  적용
                </button>
              </div>
              <div className="row wrap">
                {SIZE_PRESETS.map(([w, h]) => (
                  <button key={`${w}x${h}`} className="chip" onClick={() => resize(w, h)}>
                    {w}×{h}
                  </button>
                ))}
              </div>
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
              <span className="muted small">우클릭 = 지우기 · Ctrl+Z / Ctrl+Shift+Z</span>
            </div>
            <div className="pe-group">
              <span className="pe-label">색</span>
              <div className="row">
                <input type="color" value={color || '#ffffff'} onChange={(e) => setColor(e.target.value)} />
                <code>{color}</code>
              </div>
              <div className="pe-palette">
                {palette.map((c) => (
                  <button
                    key={c}
                    className={`swatch ${c === color ? 'active' : ''}`}
                    style={{ background: c }}
                    title={c}
                    onClick={() => {
                      pickColor(c)
                      if (tool === 'eraser' || tool === 'picker') setTool('pen')
                    }}
                  />
                ))}
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
                <button className="danger ghost" onClick={() => update({ pixels: Array(spec.w * spec.h).fill('') })}>
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
              {spec.w}×{spec.h} 타일 · 한 칸 = 출력 {spec.cell}px
            </span>
          </div>

          <div className="pe-preview">
            <div className="pe-group">
              <span className="pe-label">출력 설정</span>
              <label className="row small">
                한 칸 크기(px)
                <input
                  type="number"
                  min={1}
                  max={512}
                  value={spec.cell}
                  onChange={(e) => update({ cell: Math.max(1, Math.min(512, Math.round(+e.target.value) || 1)) })}
                />
              </label>
              <div className="row small">
                기준점
                <div className="segmented">
                  <button className={spec.anchor === 'bbox' ? 'active' : ''} onClick={() => update({ anchor: 'bbox' })}>
                    건물(불투명 영역) 좌상단
                  </button>
                  <button className={spec.anchor === 'image' ? 'active' : ''} onClick={() => update({ anchor: 'image' })}>
                    이미지 좌상단
                  </button>
                </div>
              </div>
              <label className="row small">
                오프셋 X
                <input type="number" value={spec.offset_x} onChange={(e) => update({ offset_x: Math.round(+e.target.value) || 0 })} />
                Y
                <input type="number" value={spec.offset_y} onChange={(e) => update({ offset_y: Math.round(+e.target.value) || 0 })} />
              </label>
              <div className="row small">
                그릴 영역
                <div className="segmented">
                  <button className={spec.clip === 'none' ? 'active' : ''} onClick={() => update({ clip: 'none' })}>
                    캔버스 전체
                  </button>
                  <button className={spec.clip === 'opaque' ? 'active' : ''} onClick={() => update({ clip: 'opaque' })}>
                    불투명 영역만
                  </button>
                </div>
              </div>
              <label className="row small">
                빈 칸 배경
                <select value={spec.background ? 'color' : ''} onChange={(e) => update({ background: e.target.value ? '#000000' : '' })}>
                  <option value="">투명</option>
                  <option value="color">색 채우기</option>
                </select>
                {spec.background && (
                  <input type="color" value={spec.background} onChange={(e) => update({ background: e.target.value })} />
                )}
              </label>
            </div>
            <div className="row small">
              미리보기 · 원본 위 가이드 불투명도
              <input type="range" min={0} max={100} value={overlay} onChange={(e) => setOverlay(+e.target.value)} />
              <span className="num">{overlay}%</span>
            </div>
            <div className="pe-preview-canvas checker">
              {guide ? <canvas ref={previewRef} /> : <Spinner />}
            </div>
            {target && !target.bbox && spec.anchor === 'bbox' && (
              <span className="badge warn">불투명 영역이 없어 이미지 좌상단 기준으로 그립니다</span>
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
          <button onClick={close}>취소</button>
          <button className="primary" onClick={save} disabled={saving || !target}>
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
