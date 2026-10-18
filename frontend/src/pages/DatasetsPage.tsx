import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type DatasetSummary } from '../api'
import { errorText, Spinner, useUi } from '../ui'

export default function DatasetsPage() {
  const { toast, confirm } = useUi()
  const navigate = useNavigate()
  const [datasets, setDatasets] = useState<DatasetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [filter, setFilter] = useState('')

  const load = useCallback(async () => {
    try {
      setDatasets(await api.listDatasets())
      setError(null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

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
    const ok = await confirm({
      title: `'${d.name}' 데이터셋 삭제`,
      message: `폴더와 파일 ${d.count}개가 영구 삭제됩니다. 되돌릴 수 없습니다.`,
      confirmText: '삭제',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteDataset(d.name)
      toast(`'${d.name}' 삭제됨`, 'success')
      load()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }

  const rename = async (d: DatasetSummary) => {
    const next = window.prompt('새 이름 (소문자/숫자/_ 로 정리됩니다)', d.name)
    if (!next || next === d.name) return
    try {
      const { name } = await api.renameDataset(d.name, next)
      toast(`'${d.name}' → '${name}'`, 'success')
      load()
    } catch (e) {
      toast(errorText(e), 'error')
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
                <td className="num">{d.count}</td>
                <td className="num">
                  {d.caption_count}
                  {d.caption_count < d.count && <span className="muted"> / {d.count}</span>}
                </td>
                <td className="num">{d.flip_count || '-'}</td>
                <td className="actions">
                  <button onClick={() => rename(d)}>이름 변경</button>
                  <button className="danger ghost" onClick={() => remove(d)}>
                    삭제
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
