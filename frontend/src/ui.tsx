import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

// ---- toasts --------------------------------------------------------------
type ToastKind = 'info' | 'success' | 'error'
interface Toast {
  id: number
  kind: ToastKind
  text: string
}

interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmText?: string
  danger?: boolean
}

interface UiContextValue {
  toast: (text: string, kind?: ToastKind) => void
  confirm: (opts: ConfirmOptions) => Promise<boolean>
}

const UiContext = createContext<UiContextValue | null>(null)

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const nextId = useRef(1)

  const toast = useCallback((text: string, kind: ToastKind = 'info') => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000)
  }, [])

  const confirm = useCallback(
    (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setDialog({ ...opts, resolve })),
    [],
  )

  const close = (v: boolean) => {
    dialog?.resolve(v)
    setDialog(null)
  }

  return (
    <UiContext.Provider value={{ toast, confirm }}>
      {children}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      {dialog && (
        <Modal onClose={() => close(false)}>
          <div className="dialog">
            <h3>{dialog.title}</h3>
            {dialog.message && <div className="dialog-msg">{dialog.message}</div>}
            <div className="row end">
              <button onClick={() => close(false)}>취소</button>
              <button autoFocus className={dialog.danger ? 'danger' : 'primary'} onClick={() => close(true)}>
                {dialog.confirmText ?? '확인'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </UiContext.Provider>
  )
}

export function useUi() {
  const ctx = useContext(UiContext)
  if (!ctx) throw new Error('UiProvider missing')
  return ctx
}

// ---- modal ---------------------------------------------------------------
export function Modal({
  children,
  onClose,
  wide,
}: {
  children: ReactNode
  onClose: () => void
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal modal-wide' : 'modal'}>{children}</div>
    </div>
  )
}

// ---- misc ----------------------------------------------------------------
export function Spinner() {
  return <span className="spinner" aria-label="loading" />
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

/** Render a growing slice of a long list as the user scrolls. */
export function useIncremental<T>(items: T[], step = 120) {
  const [limit, setLimit] = useState(step)
  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => setLimit(step), [items.length, step])
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + step)
      },
      { rootMargin: '800px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [step, limit, items.length])
  return {
    visible: items.slice(0, limit),
    sentinel: limit < items.length ? <div ref={sentinel} className="sentinel" /> : null,
  }
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}
