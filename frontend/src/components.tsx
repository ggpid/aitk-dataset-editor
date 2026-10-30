import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { api, fileUrl, thumbUrl, type Item } from './api'
import { errorText, useUi } from './ui'

export function Media({
  dataset,
  item,
  full,
  size = 384,
  style,
  className,
}: {
  dataset: string
  item: Item
  full?: boolean
  size?: number
  style?: CSSProperties
  className?: string
}) {
  if (item.kind === 'video') {
    return (
      <video
        className={className}
        style={style}
        src={fileUrl(dataset, item)}
        muted
        loop
        playsInline
        controls={full}
        autoPlay={full}
        preload="metadata"
      />
    )
  }
  if (item.kind === 'audio') {
    return full ? (
      <audio src={fileUrl(dataset, item)} controls style={style} />
    ) : (
      <div className={`media-placeholder ${className ?? ''}`} style={style}>
        ♪ {item.ext}
      </div>
    )
  }
  return (
    <img
      className={className}
      style={style}
      src={full ? fileUrl(dataset, item) : thumbUrl(dataset, item, size)}
      loading="lazy"
      decoding="async"
      draggable={false}
      alt={item.name}
    />
  )
}

/** Caption textarea that saves on blur / Ctrl+Enter. */
export function CaptionEditor({
  dataset,
  item,
  onSaved,
  rows = 3,
  autoFocus,
}: {
  dataset: string
  item: Item
  onSaved: (caption: string) => void
  rows?: number
  autoFocus?: boolean
}) {
  const { toast } = useUi()
  const [value, setValue] = useState(item.caption ?? '')
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const original = useRef(item.caption ?? '')

  useEffect(() => {
    original.current = item.caption ?? ''
    setValue(item.caption ?? '')
  }, [item.path, item.caption])

  const dirty = value !== original.current

  const save = async () => {
    if (!dirty) return
    setState('saving')
    try {
      await api.setCaption(dataset, item.path, value)
      original.current = value
      setState('saved')
      onSaved(value)
      setTimeout(() => setState('idle'), 1200)
    } catch (e) {
      setState('idle')
      toast(`캡션 저장 실패: ${errorText(e)}`, 'error')
    }
  }

  return (
    <div className="caption-editor">
      <textarea
        rows={rows}
        value={value}
        autoFocus={autoFocus}
        placeholder={item.caption === null ? '(캡션 없음)' : ''}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            save()
          }
          e.stopPropagation()
        }}
        className={dirty ? 'dirty' : ''}
      />
      <span className={`caption-state ${state}`}>
        {state === 'saving' ? '저장 중…' : state === 'saved' ? '저장됨' : dirty ? '수정됨' : ''}
      </span>
    </div>
  )
}

export function useArrowKeys(onPrev: () => void, onNext: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') return
      if (e.key === 'ArrowLeft') onPrev()
      if (e.key === 'ArrowRight') onNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPrev, onNext])
}

/** 🔍 button in a thumbnail's bottom-right corner that opens the detail view
 * (clicking the thumbnail itself only toggles its checkbox). */
export function OpenDetailButton({ onOpen, title = '크게 보기' }: { onOpen: () => void; title?: string }) {
  return (
    <button
      type="button"
      className="open-detail"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpen()
      }}
    >
      🔍
    </button>
  )
}
