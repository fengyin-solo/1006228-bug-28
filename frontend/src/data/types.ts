/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 登记时间：历史台账缺登记时间时按检测日期回填。 */
  登记时间?: string
  /** 结论版本：初始台账或批量标记批次（V1、V2…），在册结论不被新版本改写。 */
  结论版本?: string
  /** 备注：早期缺字段等情况在此说明，不臆造数据。 */
  备注?: string
  [field: string]: string | number | boolean | undefined
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

/** 岗位角色：写权限按模块归属校验，归属之外的岗位一律拒绝写入。 */
export type RoleKey = 'operator' | 'maintenance' | 'warehouse' | 'readonly'

/** 批量标记逐台结果：成功 / 跳过（不重复计数）/ 失败（在册结论不可改写等）。 */
export type BatchItemStatus = 'success' | 'skipped' | 'failed'

export type BatchItemResult = {
  id: number
  code: string
  unit: string
  result: BatchItemStatus
  fromStatus: string
  toStatus?: string
  reason: string
}

/** 一次批量提交就是一个不可变结论版本；重复提交同一幂等键只回放，不再计数。 */
export type BearingBatch = {
  seq: number
  idempotencyKey: string
  createdAt: string
  operator: string
  role: string
  requestedIds: number[]
  results: BatchItemResult[]
  successCount: number
  skipCount: number
  failCount: number
  note: string
}

export type BatchSubmitResult = {
  /** true 表示这次请求命中了此前同一批次的提交，返回的是首次结果，未再写数据。 */
  replayed: boolean
  batch: BearingBatch
}

/** 对账口径：页面卡片、检修待办、备件待办、导出清单全部取这同一份数字。 */
export type BearingReconciliation = {
  versionLabel: string
  total: number
  normal: number
  high: number
  pending: number
  repaired: number
  /** 检修待办口径 = 温度偏高 + 待检修。 */
  maintenanceTodo: number
  /** 备件待办与检修待办同口径：未完工的偏高轴承都需要备件兜底。 */
  spareTodo: number
  levels: { status: string; count: number }[]
  missingLowerGuide: { id: number; code: string; unit: string; detectedAt: string; note: string }[]
}

/** 备品备件待办里由导轴承结论派生出来的需求项（只读投影，不另存副本）。 */
export type BearingSpareDemand = {
  bearingId: number
  code: string
  unit: string
  upperTemp: string
  lowerTemp: string
  detectedAt: string
  registeredAt: string
  status: string
  version: string
  advice: string
  demandStatus: '待补充'
}
