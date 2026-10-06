import { SEED_ROWS } from './seed'
import type { BearingBatch, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：拆出批量批次记录，导轴承历史数据整体回填（登记时间 / 早期缺项说明）。
const STORAGE_KEY = 'hydropower-plant-om:entries:v2'
const LEGACY_STORAGE_KEY = 'hydropower-plant-om:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export type EntriesDb = {
  rows: Record<string, EntryRow[]>
  bearingBatches: BearingBatch[]
}

/** 历史导轴承记录整体回填：按检测日期排序，登记时间缺失就用检测日期补；早期缺下导温度另列说明，不臆造数值。 */
function backfillBearingHistory(rows: EntryRow[]): EntryRow[] {
  const ordered = [...rows].sort((a, b) =>
    String(a['检测日期'] ?? '').localeCompare(String(b['检测日期'] ?? '')),
  )
  return ordered.map((row) => {
    const next: EntryRow = { ...row }
    const detectedAt = String(next['检测日期'] ?? '')
    if (!next['登记时间'] && detectedAt) {
      next['登记时间'] = detectedAt
    }
    const note = String(next['备注'] ?? '')
    const hasLower = next['下导温度'] !== undefined && String(next['下导温度']).trim() !== ''
    if (!hasLower && !note.includes('下导温度')) {
      next['备注'] = note
        ? `${note}；下导温度未记录（早期缺项）`
        : '早期台账只记录上导温度，下导温度未记录（早期缺项）'
    }
    if (!next['结论版本']) {
      next['结论版本'] = '初始台账'
    }
    return next
  })
}

function seedDb(): EntriesDb {
  const rows = clone(SEED_ROWS)
  if (rows.bearing) {
    rows.bearing = backfillBearingHistory(rows.bearing)
  }
  return { rows, bearingBatches: [] }
}

/**
 * 旧版本（v1）数据迁移：保留各模块在浏览器里的改动，只对导轴承整体回填，
 * 已经在册（温度偏高/待检修/已检修）的结论一律不改写。
 */
function migrateLegacy(raw: string): EntriesDb {
  const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  const db = seedDb()
  db.rows = { ...db.rows, ...clone(parsed) }
  db.rows.bearing = backfillBearingHistory(db.rows.bearing ?? [])
  return db
}

function readStorage(): EntriesDb {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedDb()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as EntriesDb
      return {
        rows: { ...clone(SEED_ROWS), ...(parsed.rows ?? {}) },
        bearingBatches: parsed.bearingBatches ?? [],
      }
    } catch {
      // v2 数据损坏时落到迁移/播种逻辑，不让页面白屏。
    }
  }
  const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  const db = legacy ? migrateLegacy(legacy) : seedDb()
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  return db
}

let cache: EntriesDb | null = null

export function db(): EntriesDb {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return db().rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next: EntriesDb = {
    rows: { ...allRows(), [key]: rows },
    bearingBatches: db().bearingBatches,
  }
  cache = next
  persist()
}

export function listBearingBatches(): BearingBatch[] {
  return db().bearingBatches
}

export function saveBearingBatches(batches: BearingBatch[]): void {
  cache = { rows: allRows(), bearingBatches: batches }
  persist()
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  const resetRowsBackfilled = key === 'bearing' ? backfillBearingHistory(rows) : rows
  saveRows(key, resetRowsBackfilled)
  if (key === 'bearing') {
    saveBearingBatches([])
  }
  return resetRowsBackfilled
}

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}

export { backfillBearingHistory }
