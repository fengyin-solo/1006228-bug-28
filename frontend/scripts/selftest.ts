/* 不进浏览器，直接用内存 localStorage 跑真实的本地数据服务，校验批量标记、幂等、
   待办同源、历史回填、越权拒绝、导出对账这几条。
   运行：node scripts/run-selftest.mjs（esbuild 会把本文件与业务模块一起打包）。 */
import assert from 'node:assert'

import * as bearingService from '@/api/bearing-service'
import * as localService from '@/api/local-service'

export async function run(): Promise<void> {
  const admin = 'admin'
  const ops = 'operations'
  const crew = 'crew'
  const spareRole = 'spare'
  const viewer = 'viewer'
  const adminName = '值班管理员'

  // 初始：9 台，待检修 1（BEAR-0005 在册），温度偏高 1（BEAR-0004）。
  let summary = bearingService.bearingSummary()
  assert.equal(summary.total, 9, '初始应有 9 台导轴承')
  assert.equal(summary.counts.待检修, 1, '初始待检修 1 台（在册 BEAR-0005）')
  assert.equal(summary.counts.温度偏高, 1, '初始温度偏高 1 台')
  assert.equal(summary.counts.已检修, 1, '初始已检修 1 台')

  let todos = bearingService.listRepairTodos()
  assert.deepEqual(
    todos.map((t) => t.bearingCode),
    ['BEAR-0005'],
    '待检修待办初始只有在册的 BEAR-0005',
  )

  // 1) 大负荷后批量勾选多台（含重复勾选、已待检修、已检修、不存在的 id），整组提交。
  const ids = [7, 8, 9, 7 /* 重复勾选 */, 5 /* 已待检修 */, 6 /* 已检修 */, 999 /* 不存在 */]
  const batch1 = bearingService.batchMarkHigh(ids, ops, '运行值班员')
  assert.equal(batch1.requested, 6, '同一次提交重复勾选只算一次：7,8,9,5,6,999')
  assert.equal(batch1.successCount, 3, '7/8/9 三台成功进待检修')
  assert.equal(batch1.skippedCount, 1, 'BEAR-0005 已待检修 → 跳过')
  assert.equal(batch1.failedCount, 2, '已检修与不存在 → 失败并带原因')
  assert.equal(batch1.items.find((i) => i.bearingCode === 'BEAR-0006').outcome, 'failed')
  assert.match(
    batch1.items.find((i) => i.bearingCode === 'BEAR-0006').reason,
    /在册结论/,
    '已检修失败原因要写明在册结论不改写',
  )
  assert.equal(batch1.items.find((i) => i.bearingId === 999).outcome, 'failed')
  const successCodes = batch1.items.filter((i) => i.outcome === 'success').map((i) => i.bearingCode)
  assert.deepEqual(successCodes.sort(), ['BEAR-0007', 'BEAR-0008', 'BEAR-0009'])

  summary = bearingService.bearingSummary()
  assert.equal(summary.pendingCount, 4, '待检修从 1 增加到 4，且每台只算一次')
  todos = bearingService.listRepairTodos()
  assert.equal(todos.length, 4, '检修待办同步为 4 台')
  assert.deepEqual(
    todos.map((t) => t.bearingCode).sort(),
    ['BEAR-0005', 'BEAR-0007', 'BEAR-0008', 'BEAR-0009'],
    '成功的都进待检修清单',
  )

  // 2) 整组重复提交第二次：全部跳过/失败，台数不再增加。
  const batch2 = bearingService.batchMarkHigh([7, 8, 9, 5], ops, '运行值班员')
  assert.equal(batch2.successCount, 0, '第二次提交没有新成功')
  assert.equal(batch2.skippedCount, 4, '4 台都已在清单 → 跳过')
  assert.equal(bearingService.bearingSummary().pendingCount, 4, '待检修台数不重复增加')

  // 单台重复标记同样幂等。
  const again = bearingService.markBearingHigh(8, ops, '运行值班员')
  assert.equal(again.skipped, true, '单台重复标记返回 skipped')
  assert.equal(bearingService.bearingSummary().pendingCount, 4)

  // 3) 列表、检修待办、备件待办同源：spare 页和 crew 页都调 listRepairTodos。
  //    这里直接断言同一函数；页面层两处引用在构建里覆盖。
  assert.equal(
    bearingService.listRepairTodos().length,
    bearingService.bearingSummary().counts.待检修,
    '待办数量与列表待检修等级数量一致',
  )

  // 4) 检修班组确认一台后，待办减少、等级变已检修，备件页看到的同步减少。
  const fixed = bearingService.confirmBearingRepair(7, crew, '检修班组')
  assert.equal(fixed.ok, true)
  assert.equal(bearingService.listRepairTodos().length, 3, '确认检修后待办剩 3 台')
  assert.equal(bearingService.bearingSummary().counts.已检修, 2)
  // 已检修的再标记偏高必须失败。
  const reHigh = bearingService.batchMarkHigh([7], ops, '运行值班员')
  assert.equal(reHigh.items[0].outcome, 'failed')

  // 5) 越权：备件管理员、只读账号不能批量标记；运行值班员不能确认检修；只读账号任何写都拒。
  const deniedSpare = bearingService.batchMarkHigh([8], spareRole, '备件管理员')
  assert.equal(deniedSpare.failedCount, 1)
  assert.match(deniedSpare.items[0].reason, /无权/)
  const deniedViewer = bearingService.batchMarkHigh([8], viewer, '其他人员')
  assert.equal(deniedViewer.failedCount, 1)
  assert.equal(
    bearingService.confirmBearingRepair(8, ops, '运行值班员').ok,
    false,
    '运行值班员不能确认检修（检修归属岗位）',
  )
  const genericDenied = localService.runAction('spare', 1, '办理验收', crew)
  assert.equal(genericDenied.ok, false, '检修岗位不能改备件台账')
  const viewerGeneric = localService.runAction('unit', 1, '开机并网', viewer)
  assert.equal(viewerGeneric.ok, false)

  // 6) 历史回填：按检测日期，BEAR-0001/0002 缺下导温度 → 未测量补登 + 单列说明；在册结论保留。
  const backfill = bearingService.runBackfill(admin, adminName)
  assert.equal(backfill.ok, true)
  const v1 = backfill.version
  assert.equal(v1.covered + v1.keptExisting, 9, '回填覆盖全部 9 台')
  // 在册结论：0004(温度偏高) 0005(待检修) 0006(已检修)，加上批量标记的 0008/0009
  // 与检修确认后的 0007(已检修) 共 6 条；0001/0002/0003 由本版首次定级。
  assert.equal(v1.keptExisting, 6, '6 条在册/已操作结论原样保留')
  assert.equal(v1.covered, 3, '0001/0002/0003 三条历史记录本版首次定级')
  assert.equal(v1.missingFieldCount, 2, '0001/0002 两条早期记录缺下导温度')
  const missingNotes = v1.records.filter((r) => r.missingFields.length > 0)
  assert.deepEqual(missingNotes.map((r) => r.bearingCode).sort(), ['BEAR-0001', 'BEAR-0002'])
  assert.match(missingNotes[0].note, /未测量/)

  // 页面上的下导温度空值按未测量展示，且不影响在册等级（0001/0002 上导 41/43 < 50 → 正常）。
  const rows = bearingService.bearingRows()
  assert.equal(rows.find((r) => r.id === 1).status, '正常')
  assert.equal(String(rows.find((r) => r.id === 1)['下导温度']), '', '原始字段保持空白，由展示层显示未测量')

  // 再跑一版回填：所有结论都在册，不改写；旧版转只读，新版为唯一生效版。
  const backfill2 = bearingService.runBackfill(admin, adminName)
  assert.equal(backfill2.version.version, 2)
  assert.equal(backfill2.version.covered, 0, '第二版没有新定级')
  assert.equal(backfill2.version.keptExisting, 9)
  const versions = bearingService.backfillHistory()
  assert.equal(versions.filter((v) => v.active).length, 1, '只有一版生效')
  assert.equal(bearingService.activeBackfillVersion().version, 2, '各入口只读最新生效版')
  // 非管理员不能回填。
  assert.equal(bearingService.runBackfill(ops, '运行值班员').ok, false)

  // 7) 导出对账：明细 + 汇总 + 缺字段说明同源同批生成，数字必须与页面一致。
  const csv = bearingService.exportBearingCsv().content
  summary = bearingService.bearingSummary()
  assert.match(csv, new RegExp(`对账汇总,总数,${summary.total}`))
  assert.match(csv, /对账汇总,待检修轴承,3/)
  assert.match(csv, /对账汇总,温度偏高轴承,1/)
  assert.match(csv, /对账汇总,已检修轴承,2/)
  assert.match(csv, /BEAR-0001[\s\S]*?早期档案说明,BEAR-0001/, '导出含早期缺字段说明行')
  assert.match(csv, /结论版本,v2/)
  // 明细行数（9）与总数一致。
  const detailLines = csv.split('\n').filter((line) => /^\d+,BEAR-/.test(line))
  assert.equal(detailLines.length, 9)

  // 8) 重置：条目与台账一起回到初始，两边不会错位。
  localService.resetModule('bearing')
  assert.equal(bearingService.bearingSummary().total, 9)
  assert.equal(bearingService.bearingSummary().counts.待检修, 1)
  assert.equal(bearingService.listRepairTodos().length, 1)
  assert.equal(bearingService.backfillHistory().length, 0, '重置清掉版本台账')

  console.log('selftest passed: 批量标记/幂等/待办同源/越权/回填/导出对账/重置 全部通过')
}
