import { useEffect, useState } from 'react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { api, type Settings } from './api'
import ComparePage from './pages/ComparePage'
import ConvertPage from './pages/ConvertPage'
import DatasetPage from './pages/DatasetPage'
import DatasetsPage from './pages/DatasetsPage'
import SettingsPage from './pages/SettingsPage'
import { Spinner } from './ui'

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    api.getSettings().then(setSettings).catch(() => setFailed(true))
  }, [])

  const configured = !!settings?.datasets_root

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" /> AITK Dataset Editor
        </div>
        <nav>
          <NavLink to="/" end>
            데이터셋
          </NavLink>
          <NavLink to="/compare">비교</NavLink>
          <NavLink to="/convert">변환</NavLink>
          <NavLink to="/settings">설정</NavLink>
        </nav>
        <div className="spacer" />
        {settings?.datasets_root && (
          <code className="root-path" title="데이터셋 폴더">
            {settings.datasets_root}
          </code>
        )}
      </header>
      <main>
        {failed ? (
          <div className="page narrow">
            <div className="card error-card">백엔드 서버에 연결할 수 없습니다.</div>
          </div>
        ) : !settings ? (
          <Spinner />
        ) : (
          <Routes>
            <Route path="/settings" element={<SettingsPage onSaved={setSettings} />} />
            <Route path="/" element={configured ? <DatasetsPage /> : <Navigate to="/settings" replace />} />
            <Route
              path="/datasets/:name"
              element={configured ? <DatasetPage /> : <Navigate to="/settings" replace />}
            />
            <Route path="/compare" element={configured ? <ComparePage /> : <Navigate to="/settings" replace />} />
            <Route path="/convert" element={configured ? <ConvertPage /> : <Navigate to="/settings" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  )
}
