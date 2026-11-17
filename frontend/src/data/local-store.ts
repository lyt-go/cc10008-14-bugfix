import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'behavior-event-trace-hub:entries'
// 路径链路归因台账：记录每条事件链路首份归因落到哪个路径模型，刷新后仍要挡住重复回执。
const LEDGER_KEY = 'behavior-event-trace-hub:attributions'

export type AttributionRecord = { pathId: number; firstWrite: boolean }
export type AttributionLedgerData = Record<number, AttributionRecord>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function loadAttributionLedger(): AttributionLedgerData {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw) as AttributionLedgerData
  } catch {
    return {}
  }
}

export function saveAttributionLedger(ledger: AttributionLedgerData): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger))
  }
}

export function resetAttributionStorage(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(LEDGER_KEY)
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
