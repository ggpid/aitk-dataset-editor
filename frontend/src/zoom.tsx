import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

const MIN = 1
const MAX = 32

interface View {
  s: number
  x: number
  y: number
}

export interface Zoom {
  view: View
  reset: () => void
  /** Attach to the element that receives wheel / drag events. */
  containerRef: (el: HTMLElement | null) => void
  /** True while Space is held (Space+drag pans in every mode). */
  spaceHeld: () => boolean
  panning: boolean
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable)
}

/**
 * Wheel-zoom around the cursor + drag-to-pan.
 * Panes (elements with class "zoom-pane") inside the container all share one
 * transform, so side-by-side panes zoom in sync.
 *
 * leftPan: whether a plain left-button drag pans (middle-drag and Space+drag always pan).
 */
export function useZoom(resetKey: unknown, leftPan = true): Zoom {
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [el, setEl] = useState<HTMLElement | null>(null)
  const space = useRef(false)
  const leftPanRef = useRef(leftPan)
  leftPanRef.current = leftPan
  const [panning, setPanning] = useState(false)

  const reset = useCallback(() => setView({ s: 1, x: 0, y: 0 }), [])
  useEffect(reset, [resetKey, reset])

  // Keep the scaled content covering its pane.
  const clamp = (v: View, w: number, h: number): View => {
    if (v.s <= MIN) return { s: MIN, x: 0, y: 0 }
    return {
      s: v.s,
      x: Math.min(0, Math.max(w - v.s * w, v.x)),
      y: Math.min(0, Math.max(h - v.s * h, v.y)),
    }
  }

  const paneOf = useCallback(
    (target: EventTarget | null) =>
      ((target as Element | null)?.closest?.('.zoom-pane') as HTMLElement | null) ??
      (el?.querySelector('.zoom-pane') as HTMLElement | null),
    [el],
  )

  useEffect(() => {
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (isTyping(e.target)) return
      const pane = paneOf(e.target)
      if (!pane) return
      e.preventDefault()
      const r = pane.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      const delta = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY
      const v = viewRef.current
      const s = Math.min(MAX, Math.max(MIN, v.s * Math.exp(-delta * 0.0015)))
      // Keep the point under the cursor fixed.
      const k = s / v.s
      setView(clamp({ s, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, r.width, r.height))
    }

    let drag: { id: number; sx: number; sy: number; v: View; w: number; h: number } | null = null
    const onDown = (e: PointerEvent) => {
      if (viewRef.current.s <= 1) return
      const ok = e.button === 1 || (e.button === 0 && (space.current || leftPanRef.current))
      if (!ok) return
      const pane = paneOf(e.target)
      if (!pane) return
      e.preventDefault()
      e.stopPropagation()
      const r = pane.getBoundingClientRect()
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, v: viewRef.current, w: r.width, h: r.height }
      el.setPointerCapture(e.pointerId)
      setPanning(true)
    }
    const onMove = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      const { v, w, h } = drag
      setView(clamp({ s: v.s, x: v.x + e.clientX - drag.sx, y: v.y + e.clientY - drag.sy }, w, h))
    }
    const onUp = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return
      drag = null
      setPanning(false)
    }
    const onDbl = (e: MouseEvent) => {
      if (!isTyping(e.target) && paneOf(e.target)) reset()
    }
    // Capture phase so panning wins over other mousedown handlers (e.g. swipe line).
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerdown', onDown, true)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('dblclick', onDbl)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onDown, true)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('dblclick', onDbl)
    }
  }, [el, paneOf, reset])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.code === 'Space') {
        space.current = true
        e.preventDefault()
      }
      if (e.key === '0') reset()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') space.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [reset])

  return { view, reset, containerRef: setEl, spaceHeld: () => space.current, panning }
}

/** A clipped area whose content follows the shared zoom transform. */
/** Show hard pixel edges only once one source pixel covers this many screen pixels. */
const PIXELATE_AT = 2

export function ZoomPane({ zoom, children, className }: { zoom: Zoom; children: ReactNode; className?: string }) {
  const { s, x, y } = zoom.view
  const zoomed = s > 1
  const content = useRef<HTMLDivElement>(null)

  // The CSS zoom level alone says nothing about how big a source pixel is on screen:
  // a 2000px image fitted into 400px is still downscaled at 400%. Decide per image from
  // its real magnification so large images keep smooth (not nearest-neighbour) sampling.
  const updateSampling = useCallback(() => {
    content.current?.querySelectorAll('img').forEach((img) => {
      const mag = img.naturalWidth ? (s * img.clientWidth) / img.naturalWidth : 0
      img.style.imageRendering = mag >= PIXELATE_AT ? 'pixelated' : ''
    })
  }, [s])
  useLayoutEffect(updateSampling)

  return (
    <div className={`zoom-pane ${zoomed ? 'zoomed' : ''} ${zoom.panning ? 'panning' : ''} ${className ?? ''}`}>
      <div
        ref={content}
        onLoadCapture={updateSampling}
        className="zoom-content"
        style={
          {
            transform: zoomed ? `translate(${x}px, ${y}px) scale(${s})` : undefined,
            '--zs': s,
          } as CSSProperties
        }
      >
        {children}
      </div>
    </div>
  )
}

export function ZoomBadge({ zoom, hint }: { zoom: Zoom; hint?: string }) {
  const pct = Math.round(zoom.view.s * 100)
  return (
    <button
      className={`zoom-badge ${pct > 100 ? 'on' : ''}`}
      onClick={zoom.reset}
      title="클릭/더블클릭/0 키: 원래 크기"
    >
      🔍 {pct}%{pct > 100 ? ' · 초기화' : hint ? ` · ${hint}` : ''}
    </button>
  )
}
