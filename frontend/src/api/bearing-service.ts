import { listRows, readJson, removeKey, resetRows, saveRows, writeJson } from '@/data/local-store'
import { canRunAction, canWriteModule } from '@/data/roles'
import type { RoleKey } from '@/data/roles'
import type {
  BearingBatchItem,
  BearingBatchResult,
  BearingConclusion,
  BearingGrade,
  BearingVersion,
  EntryRow,
} from '@/data/types'

// 导轴承结论台账：列表页、检修待办、备件待办、导出清单的唯一事实源。
// 条目本身仍存在通用条目仓里（bearing），结论与版本台账单独存；
// 导轴承的任何写操作都走本文件，保证两边一次事务一起改，不会再出现各入口对不上。
const LEDGER_KEY = 'hydropower-plant-om:bearing-ledger:v1'
const MODULE_KEY = 'bearing'

// 沿用原有的等级划分，阈值只用于历史回填时给「没有在册结论」的记录定级。
const HIGH_TEMP_THRESHOLD = 50
const TERMINAL_GRADE: BearingGrade = '已检修'
const TODO_GRADE: BearingGrade = '待检修'

type Ledger = {
  conclusions: BearingConclusion[]
  versions: BearingVersion[]
  batches: BearingBatchResult[]
}

function nowText(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

function emptyLedger(): Ledger {
  return { conclusions: [], versions: [], batches: [] }
}

function gradeOf(row: EntryRow): BearingGrade {
  const status = String(row.status)
  if (status === '温度偏高' || status === '待检修' || status === '已检修') {
    return status
  }
  return '正常'
}

function missingFieldsOf(row: EntryRow): string[] {
  const missing: string[] = []
  if (String(row['下导温度'] ?? '').trim() === '') {
    missing.push('下导温度')
  }
  return missing
}

// pending/abnormal 标志由等级唯一推导，看板、页脚、导出对账口径一致。
function normalizeFlags(row: EntryRow): EntryRow {
  const grade = gradeOf(row)
  return {
    ...row,
    status: grade,
    pending: grade === '温度偏高' || grade === TODO_GRADE,
    abnormal: grade === '温度偏高' || grade === TODO_GRADE,
  }
}

function registerConclusions(rows: EntryRow[]): BearingConclusion[] {
  // 首次建账：只登记业务上已经做出的在册结论（温度偏高/待检修/已检修）。
  // 状态为正常的是等回填定级的历史检测记录，不算既有结论，回填时按检测日期定级。
  // 后续任何一版回填都不改写这里登记的在册结论。
  return rows
    .filter((row) => gradeOf(row) !== '正常')
    .map((row) => {
      const missing = missingFieldsOf(row)
      return {
        bearingId: Number(row.id),
        bearingCode: String(row['轴承编号'] ?? `BEAR-${row.id}`),
        unit: String(row['所属机组'] ?? ''),
        grade: gradeOf(row),
        sourceVersion: 0,
        source: 'register' as const,
        missingFields: missing,
        note:
          missing.length > 0
            ? `在册档案缺${missing.join('、')}，结论按在册状态保留`
            : '在册结论',
        registeredAt: nowText(),
      }
    })
}

function loadLedger(): Ledger {
  const ledger = readJson<Ledger>(LEDGER_KEY, emptyLedger())
  const rows = listRows(MODULE_KEY)
  if (ledger.conclusions.length === 0 && rows.length > 0) {
    ledger.conclusions = registerConclusions(rows)
    persistLedger(ledger)
  }
  return ledger
}

function persistLedger(ledger: Ledger): void {
  writeJson(LEDGER_KEY, ledger)
}

function persistBearingRows(rows: EntryRow[]): void {
  saveRows(MODULE_KEY, rows.map(normalizeFlags))
}

export function bearingRows(): EntryRow[] {
  // 统一入口：顺手把标志位按等级归一，避免旧数据口径不一致。
  const rows = listRows(MODULE_KEY).map(normalizeFlags)
  return rows
}

export function bearingConclusions(): BearingConclusion[] {
  return loadLedger().conclusions
}

export function activeBackfillVersion(): BearingVersion | null {
  const versions = loadLedger().versions
  return versions.find((item) => item.active) ?? versions[versions.length - 1] ?? null
}

export function backfillHistory(): BearingVersion[] {
  return loadLedger().versions
}

export type BearingSummary = {
  total: number
  counts: Record<BearingGrade, number>
  pendingCount: number
}

// 对账口径：页脚、统计卡、导出汇总、待办数量都从这里算，明细清单同源。
export function bearingSummary(): BearingSummary {
  const counts: Record<BearingGrade, number> = {
    正常: 0,
    温度偏高: 0,
    待检修: 0,
    已检修: 0,
  }
  for (const row of bearingRows()) {
    counts[gradeOf(row)] += 1
  }
  return { total: bearingRows().length, counts, pendingCount: counts[TODO_GRADE] }
}

export type RepairTodo = {
  bearingId: number
  bearingCode: string
  unit: string
  grade: BearingGrade
  inspectDate: string
  source: BearingConclusion['source']
  note: string
}

// 检修待办：检修班组页和备品备件页都调这一个函数，保证读到同一份。
export function listRepairTodos(): RepairTodo[] {
  const ledger = loadLedger()
  const byId = new Map(bearingRows().map((row) => [Number(row.id), row]))
  return ledger.conclusions
    .filter((item) => item.grade === TODO_GRADE)
    .map((item) => {
      const row = byId.get(item.bearingId)
      return {
        bearingId: item.bearingId,
        bearingCode: item.bearingCode,
        unit: item.unit,
        grade: item.grade,
        inspectDate: String(row?.['检测日期'] ?? ''),
        source: item.source,
        note: item.note,
      }
    })
    .sort((a, b) => a.inspectDate.localeCompare(b.inspectDate))
}

export function recentBatches(limit = 10): BearingBatchResult[] {
  return loadLedger()
    .batches.slice(-limit)
    .reverse()
}

function upsertConclusion(
  ledger: Ledger,
  row: EntryRow,
  grade: BearingGrade,
  source: BearingConclusion['source'],
  sourceVersion: number,
  note: string,
): void {
  const index = ledger.conclusions.findIndex((item) => item.bearingId === Number(row.id))
  const next: BearingConclusion = {
    bearingId: Number(row.id),
    bearingCode: String(row['轴承编号'] ?? `BEAR-${row.id}`),
    unit: String(row['所属机组'] ?? ''),
    grade,
    sourceVersion,
    source,
    missingFields: missingFieldsOf(row),
    note,
    registeredAt: nowText(),
  }
  if (index >= 0) {
    // 新版回填不改写在册结论；只有页面上的明确动作允许更新等级。
    ledger.conclusions[index] = next
  } else {
    ledger.conclusions.push(next)
  }
}

function applyGrade(rows: EntryRow[], id: number, grade: BearingGrade): EntryRow[] {
  return rows.map((row) => (Number(row.id) === id ? normalizeFlags({ ...row, status: grade }) : row))
}

export type GradeOutcome = {
  ok: boolean
  skipped?: boolean
  message: string
  grade?: BearingGrade
}

function deniedOutcome(action: string): GradeOutcome {
  return { ok: false, message: `当前岗位无权执行「${action}」，本页只可查看` }
}

// 单台「标记偏高」：正常/温度偏高 → 待检修；已待检修跳过只算一次；已检修是在册终态，拒绝改写。
export function markBearingHigh(id: number, role: RoleKey, operator: string): GradeOutcome {
  if (!canRunAction(role, MODULE_KEY, '标记偏高')) {
    return deniedOutcome('标记偏高')
  }
  const rows = bearingRows()
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的导轴承` }
  }
  const ledger = loadLedger()
  const current = gradeOf(row)
  if (current === TERMINAL_GRADE) {
    return { ok: false, message: `${row['轴承编号']} 已有「已检修」在册结论，不能再标记偏高` }
  }
  if (current === TODO_GRADE) {
    return {
      ok: true,
      skipped: true,
      grade: TODO_GRADE,
      message: `${row['轴承编号']} 已在待检修清单中，重复标记只算一次，台数不重复增加`,
    }
  }
  persistBearingRows(applyGrade(rows, id, TODO_GRADE))
  upsertConclusion(
    ledger,
    row,
    TODO_GRADE,
    'action',
    activeBackfillVersion()?.version ?? 0,
    `${operator} 批量/单台标记偏高，转入待检修`,
  )
  persistLedger(ledger)
  return { ok: true, grade: TODO_GRADE, message: `${row['轴承编号']} 已标记偏高并进入待检修清单` }
}

export function confirmBearingRepair(id: number, role: RoleKey, operator: string): GradeOutcome {
  if (!canRunAction(role, MODULE_KEY, '确认检修')) {
    return deniedOutcome('确认检修')
  }
  const rows = bearingRows()
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的导轴承` }
  }
  const ledger = loadLedger()
  const current = gradeOf(row)
  if (current === TERMINAL_GRADE) {
    return { ok: true, skipped: true, grade: TERMINAL_GRADE, message: `${row['轴承编号']} 已检修，无需重复确认` }
  }
  persistBearingRows(applyGrade(rows, id, TERMINAL_GRADE))
  upsertConclusion(
    ledger,
    row,
    TERMINAL_GRADE,
    'action',
    activeBackfillVersion()?.version ?? 0,
    `${operator} 确认检修完成，结论定为已检修`,
  )
  persistLedger(ledger)
  return { ok: true, grade: TERMINAL_GRADE, message: `${row['轴承编号']} 已确认检修，转已检修` }
}

export function submitBearingInspection(id: number, role: RoleKey, operator: string): GradeOutcome {
  if (!canRunAction(role, MODULE_KEY, '提交检测')) {
    return deniedOutcome('提交检测')
  }
  const rows = bearingRows()
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的导轴承` }
  }
  const current = gradeOf(row)
  if (current === TERMINAL_GRADE) {
    return { ok: false, message: `${row['轴承编号']} 已检修，在册结论不再改写` }
  }
  if (current === TODO_GRADE) {
    return { ok: false, message: `${row['轴承编号']} 已是待检修，请走检修确认` }
  }
  if (current === '温度偏高') {
    return { ok: true, skipped: true, grade: '温度偏高', message: `${row['轴承编号']} 已是温度偏高，无需重复提交` }
  }
  const ledger = loadLedger()
  persistBearingRows(applyGrade(rows, id, '温度偏高'))
  upsertConclusion(
    ledger,
    row,
    '温度偏高',
    'action',
    activeBackfillVersion()?.version ?? 0,
    `${operator} 提交检测，判定温度偏高`,
  )
  persistLedger(ledger)
  return { ok: true, grade: '温度偏高', message: `${row['轴承编号']} 提交检测，判定温度偏高` }
}

// 批量标记偏高：勾选多台整组提交，逐台给出结果。
// 同一次提交里重复勾选同一台只处理一次；整批再交一次也全部跳过，不重复加台数。
export function batchMarkHigh(ids: number[], role: RoleKey, operator: string): BearingBatchResult {
  if (!canRunAction(role, MODULE_KEY, '标记偏高')) {
    return batchDenied(ids, operator, '当前岗位无权执行「批量标记偏高」，本页只可查看')
  }
  const uniqueIds = [...new Set(ids.map(Number))]
  const rows = bearingRows()
  const ledger = loadLedger()
  const items: BearingBatchItem[] = []
  const touched: EntryRow[] = []
  let nextRows = rows

  for (const id of uniqueIds) {
    const row = rows.find((item) => Number(item.id) === id)
    if (!row) {
      items.push({ bearingId: id, bearingCode: `#${id}`, outcome: 'failed', reason: '没有找到该导轴承' })
      continue
    }
    const code = String(row['轴承编号'] ?? `BEAR-${id}`)
    const current = gradeOf(row)
    if (current === TERMINAL_GRADE) {
      items.push({
        bearingId: id,
        bearingCode: code,
        outcome: 'failed',
        grade: current,
        reason: '已有「已检修」在册结论，新版操作不改写在册结论',
      })
      continue
    }
    if (current === TODO_GRADE) {
      items.push({
        bearingId: id,
        bearingCode: code,
        outcome: 'skipped',
        grade: TODO_GRADE,
        reason: '已在待检修清单中，重复提交只算一次，台数不重复增加',
      })
      continue
    }
    nextRows = applyGrade(nextRows, id, TODO_GRADE)
    touched.push(row)
    items.push({ bearingId: id, bearingCode: code, outcome: 'success', grade: TODO_GRADE })
  }

  const result: BearingBatchResult = {
    batchId: `BATCH-${Date.now()}`,
    operator,
    submittedAt: nowText(),
    requested: uniqueIds.length,
    successCount: items.filter((item) => item.outcome === 'success').length,
    skippedCount: items.filter((item) => item.outcome === 'skipped').length,
    failedCount: items.filter((item) => item.outcome === 'failed').length,
    items,
  }

  if (touched.length > 0) {
    persistBearingRows(nextRows)
    const version = activeBackfillVersion()?.version ?? 0
    for (const row of touched) {
      upsertConclusion(
        ledger,
        row,
        TODO_GRADE,
        'action',
        version,
        `批次 ${result.batchId}：${operator} 标记偏高，转入待检修`,
      )
    }
  }
  ledger.batches.push(result)
  persistLedger(ledger)
  return result
}

// 批量权限被拒：不写任何数据，逐台给出相同的越权原因，仍然逐条反馈。
export function batchDenied(ids: number[], operator: string, reason: string): BearingBatchResult {
  const uniqueIds = [...new Set(ids.map(Number))]
  const rows = bearingRows()
  const items: BearingBatchItem[] = uniqueIds.map((id) => {
    const row = rows.find((item) => Number(item.id) === id)
    return {
      bearingId: id,
      bearingCode: String(row?.['轴承编号'] ?? `#${id}`),
      outcome: 'failed',
      grade: row ? gradeOf(row) : undefined,
      reason,
    }
  })
  return {
    batchId: `BATCH-DENIED-${Date.now()}`,
    operator,
    submittedAt: nowText(),
    requested: uniqueIds.length,
    successCount: 0,
    skippedCount: 0,
    failedCount: uniqueIds.length,
    items,
  }
}

function gradeFromTemps(row: EntryRow): { grade: BearingGrade; missing: string[] } {
  const missing = missingFieldsOf(row)
  const upper = Number.parseFloat(String(row['上导温度'] ?? ''))
  const lowerText = String(row['下导温度'] ?? '').trim()
  // 早期只记了上导温度：下导温度按「未测量」补登，只按上导温度判定，并单列说明。
  const lower = lowerText === '' ? Number.NaN : Number.parseFloat(lowerText)
  const temps = [upper, lower].filter((value) => Number.isFinite(value))
  const high = temps.some((value) => value >= HIGH_TEMP_THRESHOLD)
  return { grade: high ? '温度偏高' : '正常', missing }
}

export type BackfillResult = { ok: boolean; message: string; version?: BearingVersion }

// 历史轴承记录按检测日期整体回填，生成新版本；新版本不改写已经在册的结论，只保留只读。
// 回填属于数据归属方的维护动作，这里限定值班管理员。
export function runBackfill(role: RoleKey, operator: string): BackfillResult {
  if (!canWriteModule(role, MODULE_KEY) || role !== 'admin') {
    return { ok: false, message: '历史回填由值班管理员执行，当前岗位无权操作' }
  }
  const rows = [...bearingRows()].sort((a, b) =>
    String(a['检测日期'] ?? '').localeCompare(String(b['检测日期'] ?? '')),
  )
  const ledger = loadLedger()
  const version: BearingVersion = {
    version: ledger.versions.length + 1,
    createdAt: nowText(),
    operator,
    active: true,
    covered: 0,
    keptExisting: 0,
    missingFieldCount: 0,
    records: [],
  }

  for (const row of rows) {
    const id = Number(row.id)
    const existing = ledger.conclusions.find((item) => item.bearingId === id)
    if (existing) {
      // 已经在册的结论（含此前版本与页面操作产生的）一律保留，不改写。
      version.records.push({
        bearingId: id,
        bearingCode: existing.bearingCode,
        inspectDate: String(row['检测日期'] ?? ''),
        grade: existing.grade,
        keptExisting: true,
        missingFields: existing.missingFields,
        note: existing.note,
      })
      version.keptExisting += 1
      continue
    }
    const { grade, missing } = gradeFromTemps(row)
    const note =
      missing.length > 0
        ? `历史回填：早期档案只登记上导温度，${missing.join('、')}按「未测量」补登，仅按上导温度判定为${grade}`
        : `历史回填：按上下导温度判定为${grade}`
    upsertConclusion(ledger, row, grade, 'backfill', version.version, note)
    version.records.push({
      bearingId: id,
      bearingCode: String(row['轴承编号'] ?? `BEAR-${id}`),
      inspectDate: String(row['检测日期'] ?? ''),
      grade,
      keptExisting: false,
      missingFields: missing,
      note,
    })
    version.covered += 1
    if (missing.length > 0) {
      version.missingFieldCount += 1
    }
  }

  ledger.versions.forEach((item) => {
    item.active = false
  })
  ledger.versions.push(version)
  persistLedger(ledger)
  // 回填新定级的记录把等级同步到条目（在册结论未改写，等级不变），标志位一并归一。
  const gradeById = new Map(ledger.conclusions.map((item) => [item.bearingId, item.grade]))
  const syncedRows = bearingRows().map((row) =>
    normalizeFlags({ ...row, status: gradeById.get(Number(row.id)) ?? gradeOf(row) }),
  )
  persistBearingRows(syncedRows)
  return { ok: true, message: `v${version.version} 回填完成`, version }
}

// 导轴承导出：明细、汇总、缺字段说明同一份数据一次生成，导出数字与页面必然对齐。
export function exportBearingCsv(): { filename: string; content: string } {
  const rows = bearingRows()
  const summary = bearingSummary()
  const ledger = loadLedger()
  const fields = ['轴承编号', '所属机组', '上导温度', '下导温度', '油位高度', '振动数值', '检测日期', '轴承状态']

  const escape = (value: unknown): string => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }

  const lines: string[] = [['编号', ...fields, '当前状态'].join(',')]
  for (const row of rows) {
    lines.push([row.id, ...fields.map((field) => row[field] ?? ''), gradeOf(row)].map(escape).join(','))
  }

  lines.push('')
  lines.push(`对账汇总,总数,${summary.total}`)
  lines.push(`对账汇总,正常轴承,${summary.counts.正常}`)
  lines.push(`对账汇总,温度偏高轴承,${summary.counts.温度偏高}`)
  lines.push(`对账汇总,待检修轴承,${summary.counts.待检修}`)
  lines.push(`对账汇总,已检修轴承,${summary.counts.已检修}`)

  // 早期缺字段记录另列说明行，与台账里的 missingFields 同源。
  const missingRows = [...ledger.conclusions]
    .filter((item) => item.missingFields.length > 0)
    .sort((a, b) => a.bearingCode.localeCompare(b.bearingCode))
  for (const item of missingRows) {
    const row = rows.find((r) => Number(r.id) === item.bearingId)
    lines.push(
      [
        '早期档案说明',
        item.bearingCode,
        row?.['检测日期'] ?? '',
        `缺${item.missingFields.join('、')}`,
        '按「未测量」补登，在册结论不改动',
      ]
        .map(escape)
        .join(','),
    )
  }

  const active = activeBackfillVersion()
  if (active) {
    lines.push('')
    lines.push(`结论版本,v${active.version},${active.createdAt},${active.operator},生效版`)
  }

  return { filename: '导轴承-清单.csv', content: `﻿${lines.join('\n')}` }
}

export function resetBearingData(): void {
  resetRows(MODULE_KEY)
  removeKey(LEDGER_KEY)
  // 重置后按新种子重新建账。
  const rows = bearingRows()
  const ledger = emptyLedger()
  ledger.conclusions = registerConclusions(rows)
  persistLedger(ledger)
  persistBearingRows(rows)
}
