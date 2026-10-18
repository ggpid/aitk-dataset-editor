import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { fileUrl, type Item, type Pair } from './api'
import { CaptionEditor, useArrowKeys } from './components'
import { Modal } from './ui'
import { useZoom, ZoomBadge, ZoomPane } from './zoom'

type Mode = 'side' | 'overlay' | 'swipe' | 'diff' | 'blink' | 'a' | 'b'
type Fit = 'stretch' | 'contain'

const MODES: [Mode, string][] = [
  ['side', '나란히'],
  ['overlay', '겹치기(투명도)'],
  ['swipe', '슬라이더'],
  ['diff', '차이'],
  ['blink', '깜빡임'],
  ['a', 'A만'],
  ['b', 'B만'],
]

const MODE_KEY = 'aitk-editor.overlay'

function loadPrefs(): { mode: Mode; opacity: number; fit: Fit } {
  try {
    const v = JSON.parse(localStorage.getItem(MODE_KEY) ?? '{}')
    return { mode: v.mode ?? 'overlay', opacity: v.opacity ?? 50, fit: v.fit ?? 'stretch' }
  } catch {
    return { mode: 'overlay', opacity: 50, fit: 'stretch' }
  }
}

export default function OverlayViewer({
  a,
  b,
  pairs,
  index,
  setIndex,
  onClose,
  onCaption,
  onDelete,
}: {
  a: string
  b: string
  pairs: Pair[]
  index: number
  setIndex: (i: number) => void
  onClose: () => void
  onCaption: (side: 'a' | 'b', path: string, caption: string) => void
  onDelete: (side: 'a' | 'b' | 'both') => void
}) {
  const pair = pairs[index]
  const prefs = useRef(loadPrefs()).current
  const [mode, setMode] = useState<Mode>(prefs.mode)
  const [opacity, setOpacity] = useState(prefs.opacity)
  const [fit, setFit] = useState<Fit>(prefs.fit)
  const [swipe, setSwipe] = useState(50)
  const [blinkB, setBlinkB] = useState(false)
  const [blinkMs, setBlinkMs] = useState(600)
  const [sizes, setSizes] = useState<{ a?: [number, number]; b?: [number, number] }>({})
  const dragging = useRef(false)
  const stage = useRef<HTMLDivElement>(null)
  // In swipe mode a plain left-drag moves the divider; pan with Space+drag or middle-drag.
  const zoom = useZoom(pair.key, mode !== 'swipe')

  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, JSON.stringify({ mode, opacity, fit }))
    } catch {
      /* ignore */
    }
  }, [mode, opacity, fit])

  useEffect(() => setSizes({}), [pair.key])

  useEffect(() => {
    if (mode !== 'blink') return
    const t = setInterval(() => setBlinkB((v) => !v), blinkMs)
    return () => clearInterval(t)
  }, [mode, blinkMs])

  const prev = useCallback(() => setIndex(Math.max(0, index - 1)), [index, setIndex])
  const next = useCallback(() => setIndex(Math.min(pairs.length - 1, index + 1)), [index, pairs.length, setIndex])
  useArrowKeys(prev, next)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      const n = Number(e.key)
      if (n >= 1 && n <= MODES.length) setMode(MODES[n - 1][0])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const moveSwipe = (clientX: number) => {
    const rect = stage.current?.getBoundingClientRect()
    if (!rect) return
    setSwipe(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)))
  }

  const sizeMismatch =
    sizes.a && sizes.b && (sizes.a[0] !== sizes.b[0] || sizes.a[1] !== sizes.b[1])

  const topStyle: CSSProperties = { objectFit: fit === 'stretch' ? 'fill' : 'contain' }
  if (mode === 'overlay') topStyle.opacity = opacity / 100
  if (mode === 'swipe') topStyle.clipPath = `inset(0 0 0 ${swipe}%)`
  if (mode === 'diff') topStyle.mixBlendMode = 'difference'
  if (mode === 'blink') topStyle.opacity = blinkB ? 1 : 0
  if (mode === 'a') topStyle.opacity = 0
  // B만: hide A so nothing shows through B's letterbox when not stretched.
  const baseStyle: CSSProperties | undefined = mode === 'b' ? { visibility: 'hidden' } : undefined
  const showing = mode === 'a' ? 'a' : mode === 'b' ? 'b' : mode === 'blink' ? (blinkB ? 'b' : 'a') : null

  return (
    <Modal onClose={onClose} wide>
      <div className="overlay-viewer">
        <div className="ov-toolbar">
          <div className="segmented">
            {MODES.map(([m, label], i) => (
              <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)} title={`단축키 ${i + 1}`}>
                {label}
              </button>
            ))}
          </div>
          {mode === 'overlay' && (
            <label className="slider">
              B 투명도
              <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(+e.target.value)} />
              <span className="num">{opacity}%</span>
            </label>
          )}
          {mode === 'swipe' && (
            <label className="slider">
              위치
              <input type="range" min={0} max={100} value={swipe} onChange={(e) => setSwipe(+e.target.value)} />
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
                value={blinkMs}
                onChange={(e) => setBlinkMs(+e.target.value)}
              />
              <span className="num">{blinkMs}ms</span>
            </label>
          )}
          {mode !== 'side' && (
            <label className="check">
              <input
                type="checkbox"
                checked={fit === 'stretch'}
                onChange={(e) => setFit(e.target.checked ? 'stretch' : 'contain')}
              />
              B를 A 크기에 맞춤
            </label>
          )}
          <div className="spacer" />
          <span className="muted small">
            {index + 1} / {pairs.length}
          </span>
          <button className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="ov-main" ref={zoom.containerRef}>
          <button className="nav prev" onClick={prev} disabled={index === 0}>
            ‹
          </button>
          {mode === 'side' ? (
            <div className="ov-side">
              {(['a', 'b'] as const).map((side) => (
                <figure key={side}>
                  <ZoomPane zoom={zoom}>
                    <FullMedia
                      dataset={side === 'a' ? a : b}
                      item={pair[side]}
                      onSize={(s) => setSizes((v) => ({ ...v, [side]: s }))}
                    />
                  </ZoomPane>
                  <figcaption>
                    <span className={`side-badge side-${side}`}>{side.toUpperCase()}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <ZoomPane zoom={zoom}>
            <div
              ref={stage}
              className={`ov-stage ${mode === 'swipe' ? 'swiping' : ''}`}
              onMouseDown={(e) => {
                if (mode !== 'swipe' || e.button !== 0 || zoom.spaceHeld()) return
                dragging.current = true
                moveSwipe(e.clientX)
              }}
              onMouseMove={(e) => dragging.current && moveSwipe(e.clientX)}
              onMouseUp={() => (dragging.current = false)}
              onMouseLeave={() => (dragging.current = false)}
            >
              <FullMedia
                dataset={a}
                item={pair.a}
                className="ov-base"
                style={baseStyle}
                onSize={(s) => setSizes((v) => ({ ...v, a: s }))}
              />
              <FullMedia
                dataset={b}
                item={pair.b}
                className="ov-top"
                style={topStyle}
                onSize={(s) => setSizes((v) => ({ ...v, b: s }))}
              />
              {mode === 'swipe' && (
                <>
                  <div className="swipe-line" style={{ left: `${swipe}%` }} />
                  <span className="side-badge side-a floating left">A</span>
                  <span className="side-badge side-b floating right">B</span>
                </>
              )}
              {showing && <span className={`side-badge side-${showing} floating`}>{showing.toUpperCase()}</span>}
            </div>
            </ZoomPane>
          )}
          <ZoomBadge zoom={zoom} hint={mode === 'swipe' ? '휠 확대 · Space+드래그 이동' : '휠로 확대'} />
          <button className="nav next" onClick={next} disabled={index === pairs.length - 1}>
            ›
          </button>
        </div>

        <div className="ov-info">
          <div className="row">
            <strong className="break">{pair.key}</strong>
            {sizes.a && (
              <span className="muted small">
                A {sizes.a[0]}×{sizes.a[1]}
                {sizes.b && ` · B ${sizes.b[0]}×${sizes.b[1]}`}
              </span>
            )}
            {sizeMismatch && <span className="badge warn">해상도 다름</span>}
          </div>
          <div className="ov-captions">
            {(['a', 'b'] as const).map((side) => (
              <div key={side}>
                <div className="small">
                  <span className={`side-badge side-${side}`}>{side.toUpperCase()}</span>{' '}
                  <span className="muted">{side === 'a' ? a : b}/{pair[side].path}</span>
                </div>
                <CaptionEditor
                  dataset={side === 'a' ? a : b}
                  item={pair[side]}
                  rows={3}
                  onSaved={(c) => onCaption(side, pair[side].path, c)}
                />
              </div>
            ))}
          </div>
          <div className="row">
            <small className="muted">←/→ 이동 · 1~7 보기 모드 · 휠 확대/축소, 드래그 이동, 더블클릭·0 원래 크기 · Esc 닫기</small>
            <div className="spacer" />
            <span className="muted small">이 짝 삭제:</span>
            <button className="danger ghost" onClick={() => onDelete('a')}>
              A만
            </button>
            <button className="danger ghost" onClick={() => onDelete('b')}>
              B만
            </button>
            <button className="danger" onClick={() => onDelete('both')}>
              둘다
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function FullMedia({
  dataset,
  item,
  className,
  style,
  onSize,
}: {
  dataset: string
  item: Item
  className?: string
  style?: CSSProperties
  onSize: (s: [number, number]) => void
}) {
  if (item.kind === 'video') {
    return (
      <video
        className={className}
        style={style}
        src={fileUrl(dataset, item)}
        autoPlay
        muted
        loop
        playsInline
        onLoadedMetadata={(e) => onSize([e.currentTarget.videoWidth, e.currentTarget.videoHeight])}
      />
    )
  }
  return (
    <img
      className={className}
      style={style}
      src={fileUrl(dataset, item)}
      draggable={false}
      alt={item.name}
      onLoad={(e) => onSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
    />
  )
}
