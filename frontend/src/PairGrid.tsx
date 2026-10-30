import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { CompareOptions, Pair } from './api'
import { Media, OpenDetailButton } from './components'
import SaveOverlayDialog from './SaveOverlayDialog'
import { useIncremental } from './ui'

type Mode = 'overlay' | 'swipe' | 'diff' | 'blink' | 'a' | 'b'

const MODES: [Mode, string][] = [
  ['overlay', '겹치기'],
  ['swipe', '슬라이더'],
  ['diff', '차이'],
  ['blink', '깜빡임'],
  ['a', 'A만'],
  ['b', 'B만'],
]

const PREFS_KEY = 'aitk-editor.pairgrid'

interface Prefs {
  mode: Mode
  opacity: number
  swipe: number
  stretch: boolean
  size: number
  blinkMs: number
}

function loadPrefs(): Prefs {
  const d: Prefs = { mode: 'overlay', opacity: 50, swipe: 50, stretch: true, size: 220, blinkMs: 700 }
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return d
  }
}

/** All paired items as overlaid thumbnails, driven by one shared set of controls. */
export default function PairGrid({
  a,
  b,
  pairs,
  onOpen,
  selected,
  onToggle,
  opts,
  onDatasetCreated,
}: {
  a: string
  b: string
  pairs: Pair[]
  onOpen: (i: number) => void
  selected: Set<string>
  onToggle: (key: string, shift: boolean) => void
  opts: CompareOptions
  onDatasetCreated: (name: string) => void
}) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [saving, setSaving] = useState(false)
  const [blinkB, setBlinkB] = useState(false)
  const set = (p: Partial<Prefs>) => setPrefs((v) => ({ ...v, ...p }))
  const { visible, sentinel } = useIncremental(pairs, 80)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }, [prefs])

  useEffect(() => {
    if (prefs.mode !== 'blink') return
    const t = setInterval(() => setBlinkB((v) => !v), prefs.blinkMs)
    return () => clearInterval(t)
  }, [prefs.mode, prefs.blinkMs])

  if (!pairs.length) return <div className="empty">짝있는 데이터가 없습니다.</div>

  const { mode } = prefs
  const topStyle: CSSProperties = { objectFit: prefs.stretch ? 'fill' : 'contain' }
  if (mode === 'overlay') topStyle.opacity = prefs.opacity / 100
  if (mode === 'diff') topStyle.mixBlendMode = 'difference'
  if (mode === 'blink') topStyle.opacity = blinkB ? 1 : 0
  if (mode === 'a') topStyle.opacity = 0
  if (mode === 'b') topStyle.opacity = 1

  return (
    <>
      <div className="toolbar sub">
        <div className="segmented">
          {MODES.map(([m, label]) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => set({ mode: m })}>
              {label}
            </button>
          ))}
        </div>
        {mode === 'overlay' && (
          <label className="slider">
            B 투명도
            <input type="range" min={0} max={100} value={prefs.opacity} onChange={(e) => set({ opacity: +e.target.value })} />
            <span className="num">{prefs.opacity}%</span>
          </label>
        )}
        {mode === 'swipe' && (
          <label className="slider">
            위치
            <input type="range" min={0} max={100} value={prefs.swipe} onChange={(e) => set({ swipe: +e.target.value })} />
            <span className="muted small">(타일 위에 마우스를 올리면 개별 조절)</span>
          </label>
        )}
        {mode === 'blink' && (
          <label className="slider">
            간격
            <input
              type="range"
              min={150}
              max={2000}
              step={50}
              value={prefs.blinkMs}
              onChange={(e) => set({ blinkMs: +e.target.value })}
            />
            <span className="num">{prefs.blinkMs}ms</span>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={prefs.stretch} onChange={(e) => set({ stretch: e.target.checked })} />
          B를 A 크기에 맞춤
        </label>
        {mode === 'overlay' && (
          <button
            className="primary"
            title="지금 보이는 겹친 모습 그대로(원본 해상도) 새 데이터셋으로 저장"
            onClick={() => setSaving(true)}
          >
            💾 보이는 대로 새 데이터셋 저장{selected.size ? ` (선택 ${selected.size}쌍)` : ''}
          </button>
        )}
        <div className="spacer" />
        <label className="slider">
          크기
          <input type="range" min={120} max={480} value={prefs.size} onChange={(e) => set({ size: +e.target.value })} />
        </label>
      </div>
      <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${prefs.size}px, 1fr))` }}>
        {visible.map((p, i) => (
          <PairTile
            key={p.key}
            a={a}
            b={b}
            pair={p}
            mode={mode}
            swipe={prefs.swipe}
            topStyle={topStyle}
            blinkB={blinkB}
            thumbSize={prefs.size > 300 ? 768 : 384}
            onOpen={() => onOpen(i)}
            selected={selected.has(p.key)}
            onToggle={(shift) => onToggle(p.key, shift)}
          />
        ))}
      </div>
      {sentinel}
      {saving && (
        <SaveOverlayDialog
          a={a}
          b={b}
          keys={selected.size ? [...selected] : pairs.map((p) => p.key)}
          scopeLabel={selected.size ? `선택한 ${selected.size}쌍` : `보이는 짝 전체 ${pairs.length}쌍`}
          opacity={prefs.opacity}
          stretch={prefs.stretch}
          opts={opts}
          onClose={() => setSaving(false)}
          onSaved={onDatasetCreated}
        />
      )}
    </>
  )
}

function PairTile({
  a,
  b,
  pair,
  mode,
  swipe,
  topStyle,
  blinkB,
  thumbSize,
  onOpen,
  selected,
  onToggle,
}: {
  a: string
  b: string
  pair: Pair
  mode: Mode
  swipe: number
  topStyle: CSSProperties
  blinkB: boolean
  thumbSize: number
  onOpen: () => void
  selected: boolean
  onToggle: (shift: boolean) => void
}) {
  // A's aspect ratio sizes the stage so both layers share exactly the same box.
  const [ratio, setRatio] = useState(1)
  const [hoverSwipe, setHoverSwipe] = useState<number | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const pos = hoverSwipe ?? swipe

  const stageStyle: CSSProperties = {
    aspectRatio: String(ratio),
    width: ratio >= 1 ? '100%' : 'auto',
    height: ratio >= 1 ? 'auto' : '100%',
  }
  const style: CSSProperties = mode === 'swipe' ? { ...topStyle, clipPath: `inset(0 0 0 ${pos}%)` } : topStyle
  const showing = mode === 'a' ? 'A' : mode === 'b' ? 'B' : mode === 'blink' ? (blinkB ? 'B' : 'A') : null
  // Each region shows only its own image, even where that image is transparent:
  // while only B is shown A is hidden, and in 슬라이더 A is clipped to the left of the divider.
  const baseStyle: CSSProperties | undefined =
    showing === 'B'
      ? { visibility: 'hidden' }
      : mode === 'swipe'
        ? { clipPath: `inset(0 ${100 - pos}% 0 0)` }
        : undefined

  return (
    <div className={`tile ${selected ? 'selected' : ''}`}>
      <div className="tile-media" onClick={(e) => onToggle(e.shiftKey)}>
        <div
          ref={stage}
          className="pg-stage"
          style={stageStyle}
          onMouseMove={(e) => {
            if (mode !== 'swipe') return
            const r = stage.current!.getBoundingClientRect()
            setHoverSwipe(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)))
          }}
          onMouseLeave={() => setHoverSwipe(null)}
        >
          <ThumbLayer
            dataset={a}
            pair={pair}
            side="a"
            size={thumbSize}
            style={baseStyle}
            onRatio={setRatio}
          />
          <ThumbLayer dataset={b} pair={pair} side="b" size={thumbSize} style={style} />
          {mode === 'swipe' && <div className="swipe-line" style={{ left: `${pos}%` }} />}
        </div>
        <input
          type="checkbox"
          className="tile-check"
          checked={selected}
          onClick={(e) => {
            e.stopPropagation()
            onToggle(e.shiftKey)
          }}
          readOnly
        />
        {showing && <span className={`side-badge side-${showing.toLowerCase()} floating right`}>{showing}</span>}
        <OpenDetailButton onOpen={onOpen} title="겹쳐보기 (크게 보기)" />
      </div>
      <div className="tile-body">
        <div className="tile-name" title={pair.key} onClick={(e) => onToggle(e.shiftKey)} style={{ cursor: 'pointer' }}>
          {pair.key}
        </div>
      </div>
    </div>
  )
}

function ThumbLayer({
  dataset,
  pair,
  side,
  size,
  style,
  onRatio,
}: {
  dataset: string
  pair: Pair
  side: 'a' | 'b'
  size: number
  style?: CSSProperties
  onRatio?: (r: number) => void
}) {
  const item = pair[side]
  return (
    <div
      className="pg-layer"
      onLoadCapture={(e) => {
        const img = e.target as HTMLImageElement
        if (onRatio && img.naturalWidth) onRatio(img.naturalWidth / img.naturalHeight)
      }}
    >
      <Media
        dataset={dataset}
        item={item}
        size={size}
        style={side === 'a' ? { objectFit: item.kind === 'image' ? 'fill' : 'contain', ...style } : style}
      />
    </div>
  )
}
