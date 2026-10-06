import { MODULE_BY_KEY } from '@/data/modules'
import { canWrite, denyReason, roleLabel } from '@/data/permissions'
import {
  allRows,
  listBearingBatches,
  listRows,
  resetRows,
  saveBearingBatches,
  saveRows,
} from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type {
  ActionResult,
  BatchItemResult,
  BatchSubmitResult,
  BearingBatch,
  BearingReconciliation,
  BearingSpareDemand,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RoleKey,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const BEARING_KEY = 'bearing'
const BEARING_STATUSES = ['正常', '温度偏高', '待检修', '已检修'] as const
// 导轴承动作归属：标记偏高是运行值班员的职责，接收/确认检修归检修班组。
const BEARING_ACTION_ROLE: Record<string, RoleKey> = {
  提交检测: 'operator',
  标记偏高: 'operator',
  确认检修: 'maintenance',
}

function currentRole(): RoleKey {
  try {
    return useSessionStore().role
  } catch {
    return 'readonly'
  }
}

function nowLabel(): string {
  const d = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 导轴承 pending/abnormal 标志与等级口径绑定，页面卡片、看板、待办全部按这份算。 */
function bearingFlags(status: string): { pending: boolean; abnormal: boolean } {
  if (status === '温度偏高' || status === '待检修') {
    return { pending: true, abnormal: true }
  }
  return { pending: false, abnormal: false }
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 页面按钮显隐用：与服务层写接口同一套归属规则，避免点了才被拒。 */
export function actionAllowed(key: string, action: string, role: RoleKey): boolean {
  if (key === BEARING_KEY) {
    return BEARING_ACTION_ROLE[action] === role
  }
  return canWrite(key, role)
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const role = currentRole()

  if (key === BEARING_KEY) {
    const owner = BEARING_ACTION_ROLE[action]
    if (!owner) {
      return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
    }
    if (owner !== role) {
      return { ok: false, message: denyReason(`${meta.name}·${action}`, role) }
    }
  } else if (!canWrite(key, role)) {
    return { ok: false, message: denyReason(meta.name, role) }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const currentOrder = meta.statuses.indexOf(current)
  const targetOrder = meta.statuses.indexOf(target)
  // 等级链只准顺向走，不回退、不跳级改写在册结论。
  if (currentOrder >= 0 && targetOrder >= 0 && targetOrder < currentOrder) {
    return { ok: false, message: `${meta.entity}当前为「${current}」，不能回退到「${target}」` }
  }

  const flags = key === BEARING_KEY ? bearingFlags(target) : null
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: flags ? flags.pending : target !== lastStatus,
    abnormal: flags
      ? flags.abnormal
      : NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/* ---------------------------------- 导轴承：批量标记 ---------------------------------- */

export function listBatches(): BearingBatch[] {
  // 批次按时间顺序保存，序号最大的即当前生效结论版本。
  return [...listBearingBatches()].sort((a, b) => a.seq - b.seq)
}

/**
 * 批量标记偏高，逐台给出结果：
 * - 成功：仅「正常」轴承转为「温度偏高」，进入检修待办；
 * - 跳过：已是温度偏高的在册结论，不重复计数；
 * - 失败：待检修/已检修在册结论不可改写，或记录查不到，逐条写明原因。
 * 同一 idempotencyKey 的重复提交只回放首次结果，绝不再加一遍台数。
 */
export function submitBearingBatch(
  ids: number[],
  idempotencyKey: string,
  actor: { name: string; role: RoleKey },
): BatchSubmitResult {
  if (actor.role !== 'operator') {
    throw new Error(denyReason('导轴承·批量标记偏高', actor.role))
  }
  const batches = listBatches()
  const existing = batches.find((batch) => batch.idempotencyKey === idempotencyKey)
  if (existing) {
    return { replayed: true, batch: existing }
  }

  const seq = batches.length + 1
  const version = `V${seq}`
  const rows = listRows(BEARING_KEY)
  const nextRows = [...rows]
  const uniqueIds = [...new Set(ids.map(Number))]
  const results: BatchItemResult[] = []

  for (const id of uniqueIds) {
    const index = nextRows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      results.push({
        id,
        code: `#${id}`,
        unit: '—',
        result: 'failed',
        fromStatus: '—',
        reason: '没有找到该轴承记录，可能已被删除或编号有误',
      })
      continue
    }
    const row = nextRows[index]
    const code = String(row['轴承编号'] ?? `#${id}`)
    const unit = String(row['所属机组'] ?? '—')
    const fromStatus = String(row.status)
    if (fromStatus === '正常') {
      const flags = bearingFlags('温度偏高')
      nextRows[index] = {
        ...row,
        status: '温度偏高',
        pending: flags.pending,
        abnormal: flags.abnormal,
        结论版本: version,
      }
      results.push({
        id,
        code,
        unit,
        result: 'success',
        fromStatus,
        toStatus: '温度偏高',
        reason: '大负荷后温度偏高，已转入检修待办',
      })
    } else if (fromStatus === '温度偏高') {
      results.push({
        id,
        code,
        unit,
        result: 'skipped',
        fromStatus,
        toStatus: fromStatus,
        reason: '已是「温度偏高」在册结论，本次不重复标记、不重复计数',
      })
    } else if (fromStatus === '待检修') {
      results.push({
        id,
        code,
        unit,
        result: 'failed',
        fromStatus,
        reason: '已在册为「待检修」，沿用既有等级划分，新批次不改写',
      })
    } else {
      results.push({
        id,
        code,
        unit,
        result: 'failed',
        fromStatus,
        reason: '已检修归档的结论不可改写',
      })
    }
  }

  const batch: BearingBatch = {
    seq,
    idempotencyKey,
    createdAt: nowLabel(),
    operator: actor.name || roleLabel(actor.role),
    role: roleLabel(actor.role),
    requestedIds: uniqueIds,
    results,
    successCount: results.filter((item) => item.result === 'success').length,
    skipCount: results.filter((item) => item.result === 'skipped').length,
    failCount: results.filter((item) => item.result === 'failed').length,
    note: `第 ${seq} 批大负荷后标记，本批为当前生效结论版本 ${version}；成功 ${results.filter((i) => i.result === 'success').length} 台，跳过 ${results.filter((i) => i.result === 'skipped').length} 台，失败 ${results.filter((i) => i.result === 'failed').length} 台`,
  }

  saveRows(BEARING_KEY, nextRows)
  saveBearingBatches([...batches, batch])
  return { replayed: false, batch }
}

/* ---------------------------------- 导轴承：对账口径（唯一一份） ---------------------------------- */

/**
 * 对账口径：导轴承列表、检修班组待办、备品备件待办、导出清单全部读这里的结果，
 * 任何入口都不再各算各的。
 */
export function bearingReconciliation(): BearingReconciliation {
  const rows = listRows(BEARING_KEY)
  const countOf = (status: string) => rows.filter((row) => String(row.status) === status).length
  const high = countOf('温度偏高')
  const todo = countOf('待检修')
  const batches = listBatches()
  const latest = batches[batches.length - 1]

  const missingLowerGuide = rows
    .filter((row) => {
      const value = row['下导温度']
      return value === undefined || String(value).trim() === ''
    })
    .map((row) => ({
      id: Number(row.id),
      code: String(row['轴承编号'] ?? `#${row.id}`),
      unit: String(row['所属机组'] ?? '—'),
      detectedAt: String(row['检测日期'] ?? '—'),
      note: String(row['备注'] ?? '下导温度未记录（早期缺项）'),
    }))

  return {
    versionLabel: latest ? `V${latest.seq}` : '初始台账',
    total: rows.length,
    normal: countOf('正常'),
    high,
    pending: todo,
    repaired: countOf('已检修'),
    // 检修待办口径：温度偏高（待班组接收）＋待检修（已接收未完工）。
    maintenanceTodo: high + todo,
    // 备件待办与检修待办同口径，保证两处数字一致。
    spareTodo: high + todo,
    levels: BEARING_STATUSES.map((status) => ({ status, count: countOf(status) })),
    missingLowerGuide,
  }
}

/* ---------------------------------- 检修班组：从同一份导轴承结论读待办 ---------------------------------- */

export function maintenanceTodoRows(): EntryRow[] {
  return listRows(BEARING_KEY).filter(
    (row) => row.status === '温度偏高' || row.status === '待检修',
  )
}

/** 检修班组接收：温度偏高 → 待检修；只有检修班组能执行。 */
export function receiveForOverhaul(id: number, actor: { role: RoleKey }): ActionResult {
  if (actor.role !== 'maintenance') {
    return { ok: false, message: denyReason('导轴承·接收检修', actor.role) }
  }
  const rows = listRows(BEARING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的导轴承` }
  }
  const current = String(rows[index].status)
  if (current === '待检修') {
    return { ok: false, message: '该轴承已在检修待办中，不用重复接收' }
  }
  if (current !== '温度偏高') {
    return { ok: false, message: `只有「温度偏高」的轴承能接收检修，当前为「${current}」` }
  }
  const flags = bearingFlags('待检修')
  const next = [...rows]
  next[index] = { ...rows[index], status: '待检修', pending: flags.pending, abnormal: flags.abnormal }
  saveRows(BEARING_KEY, next)
  return { ok: true, message: '已接收并转入「待检修」，备品备件待办同步保留' }
}

/** 检修班组办理完工：待检修 → 已检修；完工后自动从检修待办与备件待办移出。 */
export function finishOverhaul(id: number, actor: { role: RoleKey }): ActionResult {
  if (actor.role !== 'maintenance') {
    return { ok: false, message: denyReason('导轴承·办理完工', actor.role) }
  }
  const rows = listRows(BEARING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的导轴承` }
  }
  const current = String(rows[index].status)
  if (current === '已检修') {
    return { ok: false, message: '该轴承已检修归档，不用重复完工' }
  }
  if (current !== '待检修') {
    return { ok: false, message: `只有「待检修」的轴承能办理完工，当前为「${current}」` }
  }
  const flags = bearingFlags('已检修')
  const next = [...rows]
  next[index] = { ...rows[index], status: '已检修', pending: flags.pending, abnormal: flags.abnormal }
  saveRows(BEARING_KEY, next)
  return { ok: true, message: '已办理完工并归档，同步移出检修待办与备品备件待办' }
}

/* ---------------------------------- 备品备件：待办是导轴承结论的只读投影 ---------------------------------- */

/**
 * 备品备件待办不另存副本，直接从导轴承记录实时派生；
 * 导轴承那边标记、接收、完工，这里立刻跟着变，别的入口打开也是这一份。
 */
export function bearingSpareDemands(): BearingSpareDemand[] {
  return maintenanceTodoRows().map((row) => {
    const status = String(row.status)
    const lower = row['下导温度']
    return {
      bearingId: Number(row.id),
      code: String(row['轴承编号'] ?? `#${row.id}`),
      unit: String(row['所属机组'] ?? '—'),
      upperTemp: String(row['上导温度'] ?? '未记录'),
      lowerTemp: lower === undefined || String(lower).trim() === '' ? '未记录（早期缺项）' : String(lower),
      detectedAt: String(row['检测日期'] ?? '—'),
      registeredAt: String(row['登记时间'] ?? row['检测日期'] ?? '—'),
      status,
      version: String(row['结论版本'] ?? '初始台账'),
      advice:
        status === '待检修'
          ? '检修待领用：按工单备齐导轴承轴瓦、密封件与润滑油'
          : '备件预警：提前备好轴瓦/密封件，待检修班组接收后领用',
      demandStatus: '待补充',
    }
  })
}

/* ---------------------------------- 重置 / 导出 / 概览 ---------------------------------- */

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  if (key === BEARING_KEY) {
    return exportBearingCsv(meta)
  }
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of listRows(key)) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field]), row.status].map(csvCell).join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

/** 导轴承清单导出：明细与对账口径一起导出，另存的偏高台数必须与页面一致。 */
function exportBearingCsv(meta: ModuleMeta): { filename: string; content: string } {
  const rows = [...listRows(BEARING_KEY)].sort((a, b) =>
    String(a['检测日期'] ?? '').localeCompare(String(b['检测日期'] ?? '')),
  )
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    lines.push(
      [row.id, ...meta.fields.map((field) => row[field]), row.status].map(csvCell).join(','),
    )
  }

  const recon = bearingReconciliation()
  lines.push('')
  lines.push(['对账口径（与页面、检修待办、备件待办一致）'].map(csvCell).join(','))
  for (const level of recon.levels) {
    lines.push([`${level.status}台数`, level.count].map(csvCell).join(','))
  }
  lines.push(['在册合计', recon.total].map(csvCell).join(','))
  lines.push(['检修待办（温度偏高+待检修）', recon.maintenanceTodo].map(csvCell).join(','))
  lines.push(['备品备件待办（同口径）', recon.spareTodo].map(csvCell).join(','))
  lines.push(['当前生效结论版本', recon.versionLabel].map(csvCell).join(','))

  if (recon.missingLowerGuide.length > 0) {
    lines.push('')
    lines.push(['早期缺项说明（下导温度未记录，未臆造补值）'].map(csvCell).join(','))
    lines.push(['编号', '轴承编号', '所属机组', '检测日期', '说明'].map(csvCell).join(','))
    for (const item of recon.missingLowerGuide) {
      lines.push(
        [item.id, item.code, item.unit, item.detectedAt, item.note].map(csvCell).join(','),
      )
    }
  }

  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((metaItem) => {
    const entries = rows[metaItem.key] ?? []
    return {
      name: metaItem.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
