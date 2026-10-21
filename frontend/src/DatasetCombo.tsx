import { useEffect, useMemo, useRef, useState } from 'react'
import type { DatasetSummary } from './api'

/** Every whitespace-separated token must appear in the name (case-insensitive). */
function matches(name: string, query: string) {
  const n = name.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => n.includes(t))
}

function Highlight({ text, query }: { text: string; query: string }) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return <>{text}</>
  // Mark every character covered by any token match.
  const marked = new Array(text.length).fill(false)
  const lower = text.toLowerCase()
  for (const t of tokens) {
    let i = lower.indexOf(t)
    while (i >= 0) {
      for (let j = i; j < i + t.length; j++) marked[j] = true
      i = lower.indexOf(t, i + t.length)
    }
  }
  const parts: { s: string; m: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1]
    if (last && last.m === marked[i]) last.s += text[i]
    else parts.push({ s: text[i], m: marked[i] })
  }
  return (
    <>
      {parts.map((p, i) => (p.m ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}
    </>
  )
}

export default function DatasetCombo({
  value,
  datasets,
  onChange,
  placeholder = '데이터셋 검색…',
}: {
  value: string
  datasets: DatasetSummary[]
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const options = useMemo(() => {
    const q = query.trim().toLowerCase()
    // Exact match first, then names starting with the query, then other matches (stable order).
    const rank = (name: string) => {
      const n = name.toLowerCase()
      return n === q ? 0 : n.startsWith(q) ? 1 : 2
    }
    return datasets
      .filter((d) => matches(d.name, query))
      .map((d, i) => ({ d, i, r: q ? rank(d.name) : 0 }))
      .sort((x, y) => x.r - y.r || x.i - y.i)
      .map((x) => x.d)
  }, [datasets, query])

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    if (!open) return
    const el = list.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = (name: string) => {
    onChange(name)
    setOpen(false)
    setQuery('')
    input.current?.blur()
  }

  const openList = () => {
    setQuery('')
    setOpen(true)
    // Start on the current selection so Enter keeps it.
    const i = datasets.findIndex((d) => d.name === value)
    setTimeout(() => setActive(i >= 0 ? i : 0))
  }

  const current = datasets.find((d) => d.name === value)

  return (
    <div className={`combo ${open ? 'open' : ''}`}>
      <input
        ref={input}
        value={open ? query : (current?.name ?? value)}
        placeholder={open && value ? value : placeholder}
        onFocus={openList}
        onClick={() => !open && openList()}
        onBlur={() => {
          setOpen(false)
          setQuery('')
        }}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (!open) openList()
            else setActive((i) => Math.min(options.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            if (open && options[active]) choose(options[active].name)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setOpen(false)
            setQuery('')
            input.current?.blur()
          }
        }}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
      />
      {value && !open && (
        <button
          className="combo-clear ghost"
          title="선택 해제"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange('')}
        >
          ✕
        </button>
      )}
      {open && (
        <ul ref={list} className="combo-list" role="listbox">
          {options.length === 0 ? (
            <li className="combo-empty">일치하는 데이터셋이 없습니다</li>
          ) : (
            options.map((d, i) => (
              <li
                key={d.name}
                role="option"
                aria-selected={i === active}
                className={`${i === active ? 'active' : ''} ${d.name === value ? 'current' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(d.name)}
              >
                <span className="combo-name">
                  <Highlight text={d.name} query={query} />
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
