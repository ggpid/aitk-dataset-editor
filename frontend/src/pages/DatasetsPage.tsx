import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type DatasetStats, type DatasetSummary } from '../api'
import DuplicateDialog from '../DuplicateDialog'
import { CancelledError, useJobs } from '../jobs'
import RenameDialog from '../RenameDialog'
import { errorText, Spinner, useUi } from '../ui'

export default function DatasetsPage() {
  const { toast, confirm } = useUi()
  const navigate = useNavigate()
  const { runJob, busyDatasets } = useJobs()
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [filter, setFilter] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [duplicating, setDuplicating] = useState<DatasetSummary | null>(null)

  const [stats, setStats] = useState<Record<string, DatasetStats | 'error'>>({})
  const generation = useRef(0)

  // Names come back instantly; counts are filled in afterwards, a few datasets at a time,
  // so a large or slow (network) datasets folder never blocks the list.
  const loadStats = useCallback(async (names: string[]) => {
    const gen = ++generation.current
    const queue = [...names]
    const worker = async () => {
      while (queue.length && gen === generation.current) {
        const n = queue.shift()!
        let st: DatasetStats | 'error'
        try {
          st = await api.datasetStats(n)
        } catch {
          st = 'error'
        }
        if (gen === generation.current) setStats((m) => ({ ...m, [n]: st }))
      }
    }
    await Promise.all([worker(), worker(), worker()])
  }, [])

  const load = useCallback(async () => {
    try {
      const list = await api.listDatasets()
      setDatasets(list)
      setError(null)
      setStats({})
      loadStats(list.map((d) => d.name))
    } catch (e) {
      setError(errorText(e))
    }
  }, [loadStats])

  useEffect(() => () => void generation.current++, [])

  useEffect(() => {
    load()
  }, [load])

  const create = async () => {
    if (!newName.trim()) return
    try {
      const { name } = await api.createDataset(newName)
      setNewName('')
      toast(`데이터셋 '${name}' 생성됨`, 'success')
      navigate(`/datasets/${encodeURIComponent(name)}`)
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const remove = async (d: DatasetSummary) => {
    const st = stats[d.name]
    const ok = await confirm({
      title: `'${d.name}' 데이터셋 삭제`,
      message: `폴더와 ${st && st !== 'error' ? `파일 ${st.count}개가` : '안의 모든 파일이'} 영구 삭제됩니다. 되돌릴 수 없습니다.`,
      confirmText: '삭제',
      danger: true,
    })
    if (!ok) return
    try {
      await runJob(() => api.deleteDataset(d.name))
      toast(`'${d.name}' 삭제됨`, 'success')
    } catch (e) {
      if (e instanceof CancelledError) toast('삭제를 취소했습니다. 이미 지워진 파일은 복구되지 않습니다.', 'info')
      else toast(errorText(e), 'error')
    } finally {
      load()
    }
  }


  if (error)
    return (
      <div className="page narrow">
        <div className="card error-card">
          <p>{error}</p>
          <Link to="/settings" className="button primary">
            설정으로 이동
          </Link>
        </div>
      </div>
    )
  if (!datasets) return <Spinner />

  const shown = datasets.filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="page">
      <div className="page-head">
        <h1>데이터셋</h1>
        <div className="row">
          <input placeholder="검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <input
            placeholder="새 데이터셋 이름"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          <button className="primary" onClick={create} disabled={!newName.trim()}>
            + 생성
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="empty">데이터셋이 없습니다.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>이름</th>
              <th className="num">파일</th>
              <th className="num">캡션</th>
              <th className="num">flip</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.name}>
                <td>
                  <Link to={`/datasets/${encodeURIComponent(d.name)}`}>{d.name}</Link>
                </td>
                <StatCells st={stats[d.name]} />
                <td className="actions">
                  <button onClick={() => setRenaming(d.name)} disabled={busyDatasets.has(d.name)}>
                    이름 변경
                  </button>
                  <button onClick={() => setDuplicating(d)} disabled={busyDatasets.has(d.name)}>
                    복제
                  </button>
                  <button className="danger ghost" onClick={() => remove(d)}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {duplicating && (
        <DuplicateDialog
          name={duplicating.name}
          hasFlips={(() => {
            const st = stats[duplicating.name]
            return !st || st === 'error' || st.flip_count > 0
          })()}
          onClose={() => setDuplicating(null)}
          onDuplicated={() => {
            setDuplicating(null)
            load()
          }}
        />
      )}
      {renaming && (
        <RenameDialog
          name={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null)
            load()
          }}
        />
      )}
    </div>
  )
}

function StatCells({ st }: { st: DatasetStats | 'error' | undefined }) {
  if (!st || st === 'error') {
    const t = st ? '!' : '…'
    return (
      <>
        <td className="num muted" title={st ? '개수를 읽지 못했습니다' : '세는 중'}>
          {t}
        </td>
        <td className="num muted">{t}</td>
        <td className="num muted">{t}</td>
      </>
    )
  }
  return (
    <>
      <td className="num">{st.count}</td>
      <td className="num">
        {st.caption_count}
        {st.caption_count < st.count && <span className="muted"> / {st.count}</span>}
      </td>
      <td className="num">{st.flip_count || '-'}</td>
    </>
  )
}
