export interface Settings {
  aitk_path: string
  datasets_override: string
  datasets_root: string | null
  datasets_root_exists: boolean
  source: 'override' | 'aitk_db' | 'default' | 'unset'
  aitk_valid: boolean
  error: string | null
}

/** The dataset list only carries names (fast); counts come from datasetStats. */
export interface DatasetSummary {
  name: string
}

export interface DatasetStats {
  name: string
  count: number
  flip_count: number
  caption_count: number
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

export interface JobInfo<T = unknown> {
  id: string
  kind: string
  title: string
  datasets: string[]
  total: number
  done: number
  current: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  result: T | null
  error: string | null
  started: number
  finished: number | null
  elapsed: number
  cancel_requested: boolean
}

export type JobStart<T> = Promise<{ job: JobInfo<T> }>

export interface SamOptions {
  image_dataset: string
  mask_dataset: string | null
  image_dir: string
  mask_dir: string
  output: string
  threshold: number
  split: boolean
  min_area: number
  to_jpg: boolean
  skip_empty: boolean
}

export interface SamPreview {
  images: number
  masks: number
  pairs: number
  images_without_mask: number
  masks_without_image: number
  examples: string[]
  suggested_output: string
}

export interface SamResult {
  name: string
  written: number
  annotations: number
  empty_skipped: number
  resized_masks: number
  converted_to_jpg: number
  images_without_mask: number
  masks_without_image: number
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
  datasetStats: (name: string) => request<DatasetStats>('GET', `${ds(name)}/stats`),
  createDataset: (name: string) => request<{ name: string }>('POST', '/api/datasets', { name }),
  deleteDataset: (name: string): JobStart<null> => request('DELETE', ds(name)),
  suggestDuplicateName: (name: string) => request<{ name: string }>('GET', `${ds(name)}/duplicate-name`),
  duplicateDataset: (
    name: string,
    newName: string,
    includeFlips: boolean,
  ): JobStart<{ name: string; count: number; skipped_flips: number }> =>
    request('POST', `${ds(name)}/duplicate`, {
      name: newName,
      include_flips: includeFlips,
    }),
  renameDataset: (name: string, newName: string) =>
    request<{ name: string }>('PATCH', ds(name), { name: newName }),

  listItems: (name: string) => request<Item[]>('GET', `${ds(name)}/items`),
  setCaption: (name: string, path: string, caption: string) =>
    request<{ ok: boolean }>('PUT', `${ds(name)}/caption`, { path, caption }),
  deleteItems: (name: string, paths: string[], withFlips = false): JobStart<{ deleted: number; flips_deleted: number }> =>
    request('POST', `${ds(name)}/delete-items`, {
      paths,
      with_flips: withFlips,
    }),
  addFlips: (name: string): JobStart<{ created: string[]; skipped: string[]; unsupported: string[] }> =>
    request('POST', `${ds(name)}/flip`),
  removeFlips: (name: string): JobStart<{ removed: string[] }> => request('DELETE', `${ds(name)}/flip`),

  compare: (a: string, b: string, opts: CompareOptions) =>
    request<CompareResult>('GET', `/api/compare?${qs({ a, b, ...opts })}`),
  deleteUnpaired: (body: {
    a: string
    b: string
    side: 'a' | 'b' | 'both'
    paths_a?: string[]
    paths_b?: string[]
  } & CompareOptions): JobStart<{ deleted: { a: number; b: number }; flips_deleted: { a: number; b: number } }> =>
    request('POST', '/api/compare/delete-unpaired', body),

  samPreview: (o: SamOptions) => request<SamPreview>('POST', '/api/convert/sam/preview', o),
  samConvert: (o: SamOptions): JobStart<SamResult> => request('POST', '/api/convert/sam', o),

  getJob: <T,>(id: string) => request<JobInfo<T>>('GET', `/api/jobs/${id}`),
  listJobs: (active = true) => request<JobInfo[]>('GET', `/api/jobs?active=${active}`),
  cancelJob: (id: string) => request<JobInfo>('POST', `/api/jobs/${id}/cancel`),
}

export interface UploadProgress {
  loaded: number
  total: number
  filesDone: number
  filesTotal: number
  current: string
}

/**
 * Upload in batches (so huge selections don't become one giant request) and report
 * byte-level progress via XMLHttpRequest. Abort with the returned controller's signal.
 */
export async function uploadWithProgress(
  name: string,
  files: File[],
  onProgress: (p: UploadProgress) => void,
  signal: AbortSignal,
): Promise<string[]> {
  const MAX_BATCH_BYTES = 64 * 1024 ** 2
  const MAX_BATCH_FILES = 100
  const batches: File[][] = []
  let cur: File[] = []
  let curBytes = 0
  for (const f of files) {
    if (cur.length && (curBytes + f.size > MAX_BATCH_BYTES || cur.length >= MAX_BATCH_FILES)) {
      batches.push(cur)
      cur = []
      curBytes = 0
    }
    cur.push(f)
    curBytes += f.size
  }
  if (cur.length) batches.push(cur)

  const total = files.reduce((n, f) => n + f.size, 0)
  let sentBefore = 0
  let filesDone = 0
  const saved: string[] = []
  for (const batch of batches) {
    const batchBytes = batch.reduce((n, f) => n + f.size, 0)
    const label = batch.length === 1 ? batch[0].name : `${batch[0].name} 외 ${batch.length - 1}개`
    const res = await new Promise<{ files: string[] }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      const form = new FormData()
      batch.forEach((f) => form.append('files', f, f.name))
      xhr.open('POST', `${ds(name)}/upload`)
      xhr.upload.onprogress = (e) => {
        const loaded = sentBefore + Math.min(batchBytes, e.lengthComputable ? (e.loaded / e.total) * batchBytes : 0)
        onProgress({ loaded, total, filesDone, filesTotal: files.length, current: label })
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText))
        else {
          let msg = `${xhr.status} ${xhr.statusText}`
          try {
            msg = JSON.parse(xhr.responseText).detail ?? msg
          } catch {
            /* not json */
          }
          reject(new ApiError(msg, xhr.status))
        }
      }
      xhr.onerror = () => reject(new ApiError('네트워크 오류로 업로드에 실패했습니다.', 0))
      xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
      xhr.send(form)
    })
    saved.push(...res.files)
    sentBefore += batchBytes
    filesDone += batch.length
    onProgress({ loaded: sentBefore, total, filesDone, filesTotal: files.length, current: label })
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  }
  return saved
}

export const fileUrl = (dataset: string, item: Item) =>
  `${ds(dataset)}/file?${qs({ path: item.path, v: item.mtime })}`

export const thumbUrl = (dataset: string, item: Item, size = 384) =>
  `${ds(dataset)}/thumb?${qs({ path: item.path, size, v: item.mtime })}`
