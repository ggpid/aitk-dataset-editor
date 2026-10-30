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

export interface MaskParams {
  diff_threshold: number
  alpha_threshold: number
  open_px: number
  close_px: number
  dilate_px: number
  no_control: 'alpha' | 'skip'
}

export interface MaskInfo {
  targets: number
  pairs: number
  only_target: string[]
  only_control: string[]
  sample_keys: string[]
}

export interface MaskResult {
  name: string
  preview: string | null
  made: number
  only_target: string[]
  only_control: string[]
  no_control: 'alpha' | 'skip'
  warnings: { key: string; notes: string[] }[]
}

export interface AlphaMaskInfo {
  images: number
  flips: number
  sample_paths: string[]
}

export interface AlphaMaskResult {
  name: string
  preview: string | null
  made: number
  no_alpha: string[]
  empty: string[]
}

export interface PatternSpec {
  w: number
  h: number
  pixels: string[] // w*h "#rrggbb", row-major
  out_w: number // saved size: the tile is stretched to fill it
  out_h: number
}

export interface PatternList {
  dataset: string
  exists: boolean
  items: Record<string, string> // item key -> pattern digest ("" = not editable)
  unique: { digest: string; spec: PatternSpec; count: number; keys: string[] }[]
  common_size: [number, number] | null
}

export interface PatternTarget {
  width: number
  height: number
  spec: PatternSpec | null
  mirrored: boolean
}

export interface RenamePlan {
  renames: { from: string; to: string; linked: boolean }[]
  total: number
  linked: number
  captions: number
  patterns: number
  conflicts: string[]
}

export type MergeStrategy = 'prefix_conflicts' | 'prefix_all' | 'skip'

export interface MergePlan {
  items: number
  per_source: Record<string, number>
  conflicts: string[]
  conflict_count: number
  skipped: number
  clashes: string[]
}

type MaskSource = { target: string; control: string } & CompareOptions

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
  mergeDatasets: <D extends boolean>(body: {
    sources: string[]
    name: string
    strategy: MergeStrategy
    include_flips: boolean
    dry_run: D
  }) =>
    request<D extends true ? MergePlan : { job: JobInfo<{ name: string; items: number; captions: number; conflicts: number; skipped: number }> }>(
      'POST',
      '/api/datasets-merge',
      body,
    ),
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

  saveOverlay: (body: {
    a: string
    b: string
    name: string
    opacity: number
    stretch: boolean
    captions: 'a' | 'b' | 'none'
    keys: string[]
  } & CompareOptions): JobStart<{ name: string; written: number; skipped_non_image: number }> =>
    request('POST', '/api/compare/save-overlay', body),

  masksInfo: (body: MaskSource) => request<MaskInfo>('POST', '/api/compare/masks/info', body),
  masksPreview: async (body: MaskSource & { key: string; params: MaskParams }, signal?: AbortSignal) => {
    const res = await fetch('/api/compare/masks/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`
      try {
        msg = (await res.json()).detail ?? msg
      } catch {
        /* not json */
      }
      throw new ApiError(msg, res.status)
    }
    return {
      url: URL.createObjectURL(await res.blob()),
      cover: Number(res.headers.get('X-Mask-Cover') ?? 0),
      resized: res.headers.get('X-Mask-Resized') === '1',
    }
  },
  makeMasks: (body: MaskSource & { name: string; preview_name: string | null; params: MaskParams }): JobStart<MaskResult> =>
    request('POST', '/api/compare/masks', body),

  renameItems: <D extends boolean>(
    name: string,
    body: {
      paths: string[]
      prefix: string
      suffix: string
      include_linked: boolean
      include_patterns: boolean
      dry_run: D
    },
  ) =>
    request<D extends true ? RenamePlan : { renamed: number; linked: number; captions: number; patterns: number }>(
      'POST',
      `${ds(name)}/rename-items`,
      body,
    ),

  listPatterns: (name: string) => request<PatternList>('GET', `${ds(name)}/patterns`),
  patternTarget: (name: string, path: string) =>
    request<PatternTarget>('GET', `${ds(name)}/patterns/target?${qs({ path })}`),
  savePattern: (name: string, path: string, spec: PatternSpec) =>
    request<{ dataset: string; written: string[] }>('PUT', `${ds(name)}/patterns`, { path, spec }),
  deletePattern: (name: string, path: string) =>
    request<{ removed: string[] }>('DELETE', `${ds(name)}/patterns?${qs({ path })}`),

  alphaMaskInfo: (name: string) => request<AlphaMaskInfo>('GET', `${ds(name)}/alpha-mask/info`),
  alphaMaskPreview: async (
    name: string,
    body: { path: string; threshold: number; grow_px: number },
    signal?: AbortSignal,
  ) => {
    const res = await fetch(`${ds(name)}/alpha-mask/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`
      try {
        msg = (await res.json()).detail ?? msg
      } catch {
        /* not json */
      }
      throw new ApiError(msg, res.status)
    }
    return {
      url: URL.createObjectURL(await res.blob()),
      cover: Number(res.headers.get('X-Mask-Cover') ?? 0),
      hasAlpha: res.headers.get('X-Mask-Has-Alpha') === '1',
    }
  },
  makeAlphaMasks: (
    name: string,
    body: { name: string; preview_name: string | null; threshold: number; grow_px: number; include_flips: boolean },
  ): JobStart<AlphaMaskResult> => request('POST', `${ds(name)}/alpha-mask`, body),

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
