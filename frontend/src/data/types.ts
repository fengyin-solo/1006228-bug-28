/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 导轴承沿用原有四级划分，等级结论只取这四个值。
export type BearingGrade = '正常' | '温度偏高' | '待检修' | '已检修'

/** 同一条导轴承的在册结论：所有入口（轴承列表、检修待办、备件待办、导出）都读这一份。 */
export type BearingConclusion = {
  bearingId: number
  bearingCode: string
  unit: string
  grade: BearingGrade
  /** 结论首次登记的版本，后续版本不再改写在册结论。 */
  sourceVersion: number
  /** 结论来源：登记（首版在册）/ 回填（历史回填）/ 操作（页面上的标记与检修动作）。 */
  source: 'register' | 'backfill' | 'action'
  /** 早期档案缺下导温度时，这里写明缺哪一项，导出与回填说明行与结论同源。 */
  missingFields: string[]
  note: string
  registeredAt: string
}

/** 历史回填的逐台结果：回填报告、说明行都用它。 */
export type BearingBackfillRecord = {
  bearingId: number
  bearingCode: string
  inspectDate: string
  grade: BearingGrade
  keptExisting: boolean
  missingFields: string[]
  note: string
}

export type BearingVersion = {
  version: number
  createdAt: string
  operator: string
  /** 只有最新一版是生效版，其余只读留存，别的入口永远读 activeVersion。 */
  active: boolean
  covered: number
  keptExisting: number
  missingFieldCount: number
  records: BearingBackfillRecord[]
}

/** 批量标记逐台结果。skipped 表示同一批或在册结论已经是待检修，只算一次、不重复加台数。 */
export type BearingBatchItem = {
  bearingId: number
  bearingCode: string
  outcome: 'success' | 'skipped' | 'failed'
  grade?: BearingGrade
  reason?: string
}

export type BearingBatchResult = {
  batchId: string
  operator: string
  submittedAt: string
  requested: number
  successCount: number
  skippedCount: number
  failedCount: number
  items: BearingBatchItem[]
}
