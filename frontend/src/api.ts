export interface Settings {
  aitk_path: string
  datasets_override: string
  datasets_root: string | null
  datasets_root_exists: boolean
  source: 'override' | 'aitk_db' | 'default' | 'unset'
  aitk_valid: boolean
  error: string | null
}

export interface DatasetSummary {
  name: string
  count: number
  flip_count: number
  caption_count: number
  mtime: number
}

export interface Item {
  path: string
  key: string
  name: string
  ext: string
  kind: 'image' | 'video' | 'audio' | 'other'
  size: number
  mtime: number
  caption: string | null
  is_flip: boolean
}

export interface Pair {
  key: string
  a: Item
  b: Item
}

export interface CompareResult {
  paired: Pair[]
  only_a: Item[]
  only_b: Item[]
}

export interface CompareOptions {
  ignore_case: boolean
  ignore_folders: boolean
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body instanceof FormData) {
    init.body = body
  } else if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'Content-Type': 'application/json' }
  }
  const res = await fetch(url, init)
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const data = await res.json()
      if (typeof data.detail === 'string') message = data.detail
      else if (data.detail) message = JSON.stringify(data.detail)
    } catch {
      /* not json */
    }
    throw new ApiError(message, res.status)
  }
  return res.json() as Promise<T>
}

const ds = (name: string) => `/api/datasets/${encodeURIComponent(name)}`
const qs = (params: Record<string, string | number | boolean>) =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()

export const api = {
  getSettings: () => request<Settings>('GET', '/api/settings'),
  saveSettings: (s: { aitk_path: string; datasets_override: string }) =>
    request<Settings>('PUT', '/api/settings', s),

  listDatasets: () => request<DatasetSummary[]>('GET', '/api/datasets'),
  createDataset: (name: string) => request<{ name: string }>('POST', '/api/datasets', { name }),
  deleteDataset: (name: string) => request<{ ok: boolean }>('DELETE', ds(name)),
  renameDataset: (name: string, newName: string) =>
    request<{ name: string }>('PATCH', ds(name), { name: newName }),

  listItems: (name: string) => request<Item[]>('GET', `${ds(name)}/items`),
  upload: (name: string, files: File[]) => {
    const form = new FormData()
    files.forEach((f) => form.append('files', f, f.name))
    return request<{ files: string[] }>('POST', `${ds(name)}/upload`, form)
  },
  setCaption: (name: string, path: string, caption: string) =>
    request<{ ok: boolean }>('PUT', `${ds(name)}/caption`, { path, caption }),
  deleteItems: (name: string, paths: string[], withFlips = false) =>
    request<{ deleted: number; flips_deleted: number }>('POST', `${ds(name)}/delete-items`, {
      paths,
      with_flips: withFlips,
    }),
  addFlips: (name: string) =>
    request<{ created: string[]; skipped: string[]; unsupported: string[] }>('POST', `${ds(name)}/flip`),
  removeFlips: (name: string) => request<{ removed: string[] }>('DELETE', `${ds(name)}/flip`),

  compare: (a: string, b: string, opts: CompareOptions) =>
    request<CompareResult>('GET', `/api/compare?${qs({ a, b, ...opts })}`),
  deleteUnpaired: (body: {
    a: string
    b: string
    side: 'a' | 'b' | 'both'
    paths_a?: string[]
    paths_b?: string[]
  } & CompareOptions) => request<{ deleted: { a: number; b: number }; flips_deleted: { a: number; b: number } }>(
      'POST',
      '/api/compare/delete-unpaired',
      body,
    ),
}

export const fileUrl = (dataset: string, item: Item) =>
  `${ds(dataset)}/file?${qs({ path: item.path, v: item.mtime })}`

export const thumbUrl = (dataset: string, item: Item, size = 384) =>
  `${ds(dataset)}/thumb?${qs({ path: item.path, size, v: item.mtime })}`
