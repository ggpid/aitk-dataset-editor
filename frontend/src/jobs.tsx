import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, uploadWithProgress, type JobInfo, type JobStart } from './api'
import { formatBytes } from './ui'

/** Thrown by runJob / runUpload when the user cancelled the task. */
export class CancelledError extends Error {
  constructor() {
    super('작업이 취소되었습니다.')
  }
}

type Status = 'running' | 'done' | 'error' | 'cancelled'

interface Task {
  key: string
  title: string
  status: Status
  unit: 'files' | 'bytes'
  total: number
  done: number
  current: string
  extra?: string
  started: number
  finished?: number
  error?: string
  cancelling?: boolean
  cancel?: () => void
}

interface JobsContextValue {
  /** Track a server job until it finishes; resolves with its result. */
  runJob: <T>(start: () => JobStart<T>) => Promise<T>
  /** Upload files with byte progress; resolves with the saved file names. */
  runUpload: (dataset: string, files: File[]) => Promise<string[]>
  /** Names of datasets that currently have a running job. */
  busyDatasets: Set<string>
}

const JobsContext = createContext<JobsContextValue | null>(null)
const POLL_MS = 300

export function JobsProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [busyDatasets, setBusy] = useState<Set<string>>(new Set())
  const tracked = useRef(new Set<string>())

  const upsert = useCallback((key: string, patch: Partial<Task>) => {
    setTasks((ts) => {
      const i = ts.findIndex((t) => t.key === key)
      if (i < 0) return [...ts, { key, title: '', status: 'running', unit: 'files', total: 0, done: 0, current: '', started: Date.now(), ...patch }]
      const next = ts.slice()
      next[i] = { ...next[i], ...patch }
      return next
    })
  }, [])

  const dismiss = useCallback((key: string) => setTasks((ts) => ts.filter((t) => t.key !== key)), [])

  const finish = useCallback(
    (key: string, patch: Partial<Task>) => {
      upsert(key, { ...patch, finished: Date.now(), cancel: undefined })
      // Successful tasks fade out on their own; errors stay until closed.
      if (patch.status !== 'error') setTimeout(() => dismiss(key), 5000)
    },
    [upsert, dismiss],
  )

  const follow = useCallback(
    <T,>(job: JobInfo<T>): Promise<T> => {
      const key = `job:${job.id}`
      tracked.current.add(job.id)
      const sync = (j: JobInfo<T>) =>
        upsert(key, {
          title: j.title,
          total: j.total,
          done: j.done,
          current: j.current,
          started: j.started * 1000,
          cancelling: j.cancel_requested,
          cancel: () => {
            upsert(key, { cancelling: true })
            api.cancelJob(j.id).catch(() => undefined)
          },
        })
      sync(job)
      setBusy((b) => new Set([...b, ...job.datasets]))
      const release = () =>
        setBusy((b) => {
          const n = new Set(b)
          job.datasets.forEach((d) => n.delete(d))
          return n
        })

      return new Promise<T>((resolve, reject) => {
        const tick = async () => {
          let j: JobInfo<T>
          try {
            j = await api.getJob<T>(job.id)
          } catch {
            setTimeout(tick, POLL_MS * 3)
            return
          }
          sync(j)
          if (j.status === 'running') {
            setTimeout(tick, POLL_MS)
            return
          }
          release()
          tracked.current.delete(job.id)
          if (j.status === 'done') {
            finish(key, { status: 'done', done: j.total || j.done, current: '' })
            resolve(j.result as T)
          } else if (j.status === 'cancelled') {
            finish(key, { status: 'cancelled' })
            reject(new CancelledError())
          } else {
            finish(key, { status: 'error', error: j.error ?? '알 수 없는 오류' })
            reject(new Error(j.error ?? '작업 실패'))
          }
        }
        setTimeout(tick, POLL_MS)
      })
    },
    [upsert, finish],
  )

  const runJob = useCallback(
    async <T,>(start: () => JobStart<T>): Promise<T> => {
      const { job } = await start()
      return follow(job)
    },
    [follow],
  )

  const runUpload = useCallback(
    async (dataset: string, files: File[]) => {
      const key = `upload:${Date.now()}:${Math.random()}`
      const ctrl = new AbortController()
      const totalBytes = files.reduce((n, f) => n + f.size, 0)
      upsert(key, {
        title: `'${dataset}' 에 ${files.length}개 파일 업로드`,
        unit: 'bytes',
        total: totalBytes,
        done: 0,
        extra: `0 / ${files.length} 파일`,
        cancel: () => {
          upsert(key, { cancelling: true })
          ctrl.abort()
        },
      })
      try {
        const saved = await uploadWithProgress(
          dataset,
          files,
          (p) => upsert(key, { done: p.loaded, current: p.current, extra: `${p.filesDone} / ${p.filesTotal} 파일` }),
          ctrl.signal,
        )
        finish(key, { status: 'done', done: totalBytes, current: '', extra: `${files.length} / ${files.length} 파일` })
        return saved
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          finish(key, { status: 'cancelled' })
          throw new CancelledError()
        }
        finish(key, { status: 'error', error: e instanceof Error ? e.message : String(e) })
        throw e
      }
    },
    [upsert, finish],
  )

  // Pick up jobs that are still running on the server (e.g. after a page reload).
  useEffect(() => {
    api
      .listJobs(true)
      .then((list) => list.filter((j) => !tracked.current.has(j.id)).forEach((j) => follow(j).catch(() => undefined)))
      .catch(() => undefined)
  }, [follow])

  return (
    <JobsContext.Provider value={{ runJob, runUpload, busyDatasets }}>
      {children}
      <JobPanel tasks={tasks} onDismiss={dismiss} />
    </JobsContext.Provider>
  )
}

export function useJobs() {
  const ctx = useContext(JobsContext)
  if (!ctx) throw new Error('JobsProvider missing')
  return ctx
}

// ---- panel -----------------------------------------------------------------
function fmtTime(sec: number) {
  if (!isFinite(sec) || sec < 0) return '-'
  sec = Math.round(sec)
  if (sec < 60) return `${sec}초`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}분 ${sec % 60}초`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [active])
  return now
}

function JobPanel({ tasks, onDismiss }: { tasks: Task[]; onDismiss: (key: string) => void }) {
  const now = useNow(tasks.some((t) => t.status === 'running'))
  if (!tasks.length) return null
  return (
    <div className="job-panel" role="status" aria-live="polite">
      {tasks.map((t) => {
        const elapsed = ((t.finished ?? now) - t.started) / 1000
        const frac = t.total > 0 ? Math.min(1, t.done / t.total) : t.status === 'done' ? 1 : 0
        const eta = t.status === 'running' && frac > 0.02 ? (elapsed / frac) * (1 - frac) : NaN
        const amount =
          t.unit === 'bytes' ? `${formatBytes(t.done)} / ${formatBytes(t.total)}` : t.total ? `${t.done} / ${t.total}` : ''
        return (
          <div key={t.key} className={`job job-${t.status}`}>
            <div className="job-head">
              <span className="job-icon">
                {t.status === 'running' ? '⏳' : t.status === 'done' ? '✓' : t.status === 'cancelled' ? '⦸' : '⚠'}
              </span>
              <strong className="job-title">{t.title || '작업 준비 중…'}</strong>
              {t.status === 'running' && t.cancel ? (
                <button className="ghost small-btn" onClick={t.cancel} disabled={t.cancelling}>
                  {t.cancelling ? '취소 중…' : '취소'}
                </button>
              ) : t.status !== 'running' ? (
                <button className="ghost small-btn" onClick={() => onDismiss(t.key)} title="닫기">
                  ✕
                </button>
              ) : null}
            </div>
            <div className={`job-bar ${t.status === 'running' && t.total === 0 ? 'indeterminate' : ''}`}>
              <div style={{ width: `${frac * 100}%` }} />
            </div>
            <div className="job-meta">
              <span>
                {t.status === 'running' && t.total === 0 ? '준비 중…' : `${Math.floor(frac * 100)}%`}
                {amount && ` · ${amount}`}
                {t.extra && ` · ${t.extra}`}
              </span>
              <span>
                {t.status === 'running'
                  ? `${fmtTime(elapsed)} 경과${isFinite(eta) ? ` · 약 ${fmtTime(eta)} 남음` : ''}`
                  : t.status === 'done'
                    ? `완료 (${fmtTime(elapsed)})`
                    : t.status === 'cancelled'
                      ? '취소됨'
                      : '실패'}
              </span>
            </div>
            {t.status === 'running' && t.current && (
              <div className="job-current" title={t.current}>
                {t.current}
              </div>
            )}
            {t.error && <div className="job-errmsg">{t.error}</div>}
          </div>
        )
      })}
    </div>
  )
}
