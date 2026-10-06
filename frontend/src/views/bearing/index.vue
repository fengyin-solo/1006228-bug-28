<template>
  <section class="page" data-module="bearing">
    <header class="page-head">
      <div>
        <h2>导轴承管理</h2>
        <p class="page-desc">大负荷后批量标记温度偏高：整组勾选一次提交，逐台反馈结果，成功的进检修待办，在册结论不改写、不重复计数。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记导轴承</button>
        <button class="btn" type="button" @click="exportRows">导出导轴承清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in recon.levels" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item version">当前生效结论版本：{{ recon.versionLabel }}</span>
    </p>

    <div v-if="!canBatchMark" class="role-tip warn">
      当前岗位「{{ store.roleLabel }}」无权标记偏高，批量入口已锁定；只有运行值班员能提交标记。
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="batch-bar">
      <label class="select-all">
        <input type="checkbox" :checked="allChecked" :indeterminate.prop="someChecked" @change="toggleAll" />
        全选当前筛选结果
      </label>
      <button
        class="btn primary"
        type="button"
        :disabled="!canBatchMark || selectedIds.length === 0"
        @click="submitBatch"
      >
        批量标记偏高（已选 {{ selectedIds.length }} 台）
      </button>
      <button class="btn ghost" type="button" :disabled="!selectedIds.length" @click="clearSelection">
        清空勾选
      </button>
      <span class="batch-hint">同一次勾选重复提交只算一次（幂等），台数不会加两遍</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>结论版本</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="col-check">
            <input type="checkbox" :value="Number(row.id)" v-model="selectedIds" />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="['status-pill', statusClass(String(row.status))]">{{ row.status }}</span>
          </td>
          <td>{{ row['结论版本'] ?? '初始台账' }}</td>
          <td class="row-actions">
            <template v-for="action in actions" :key="action">
              <button
                v-if="actionAllowed(meta.key, action, store.role)"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-if="!anyRowActionAllowed" class="lock-text">仅查看</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无导轴承数据，可先登记导轴承</td>
        </tr>
      </tbody>
    </table>

    <section v-if="lastBatch" class="result-panel">
      <h3>
        批量结果 · 第 {{ lastBatch.seq }} 批（{{ lastBatch.createdAt }}，{{ lastBatch.operator }}）
        <span v-if="lastSubmitReplayed" class="replay-tag">重复提交，回放首次结果，未再计数</span>
      </h3>
      <p class="result-summary">
        成功 <strong class="ok">{{ lastBatch.successCount }}</strong> 台 ·
        跳过 <strong class="skip">{{ lastBatch.skipCount }}</strong> 台 ·
        失败 <strong class="fail">{{ lastBatch.failCount }}</strong> 台
      </p>
      <table class="data-table result-table">
        <thead>
          <tr><th>轴承编号</th><th>所属机组</th><th>结果</th><th>原状态</th><th>现状态</th><th>原因</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in lastBatch.results" :key="item.id">
            <td>{{ item.code }}</td>
            <td>{{ item.unit }}</td>
            <td><span :class="['result-tag', item.result]">{{ resultLabel(item.result) }}</span></td>
            <td>{{ item.fromStatus }}</td>
            <td>{{ item.toStatus ?? '—' }}</td>
            <td>{{ item.reason }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="recon.missingLowerGuide.length" class="note-panel">
      <h3>早期缺项说明（按检测日期回填，共 {{ recon.missingLowerGuide.length }} 台）</h3>
      <p class="note-text">
        历史记录已按检测日期整体回填登记时间；早期只记了上导温度、没记下导温度的，保留空值并在此另列一行说明，不臆造补值。
      </p>
      <table class="data-table">
        <thead>
          <tr><th>轴承编号</th><th>所属机组</th><th>检测日期</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in recon.missingLowerGuide" :key="item.id">
            <td>{{ item.code }}</td>
            <td>{{ item.unit }}</td>
            <td>{{ item.detectedAt }}</td>
            <td>{{ item.note }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="batches.length" class="version-panel">
      <h3>结论版本（最新一版为当前生效结论，历史版本只读）</h3>
      <ul class="version-list">
        <li
          v-for="batch in [...batches].reverse()"
          :key="batch.seq"
          :class="{ active: batch.seq === Number(recon.versionLabel.slice(1)) || false }"
        >
          <button class="link" type="button" @click="viewBatch(batch)">
            V{{ batch.seq }} · {{ batch.createdAt }} · {{ batch.operator }}
            · 成功 {{ batch.successCount }} / 跳过 {{ batch.skipCount }} / 失败 {{ batch.failCount }}
          </button>
          <span v-if="batch.seq === batches.length" class="current-tag">当前生效</span>
        </li>
      </ul>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条导轴承记录 · 检修待办 {{ recon.maintenanceTodo }} 台（温度偏高＋待检修）· 备件待办 {{ recon.spareTodo }} 台（同口径）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  actionAllowed,
  bearingReconciliation,
  downloadEntries,
  listBatches,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  submitBearingBatch,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { BearingBatch, BatchItemStatus, EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('bearing')
// 沿用原有等级划分：正常 → 温度偏高 → 待检修 → 已检修。
const columns = ['轴承编号', '所属机组', '上导温度', '下导温度', '油位高度', '振动数值', '检测日期', '登记时间', '备注']
const actions = ['提交检测', '标记偏高', '确认检修']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const selectedIds = ref<number[]>([])
const batches = ref<BearingBatch[]>([])
const lastBatch = ref<BearingBatch | null>(null)
const lastSubmitReplayed = ref(false)
// 同一份勾选对应的幂等键：选择不变就沿用，重复点提交只回放；勾选变化才生成新批次键。
let batchKey = ''
let batchKeySignature = ''

const recon = ref(bearingReconciliation())
const statCards = computed(() => [
  { label: '正常轴承', value: recon.value.normal },
  { label: '温度偏高轴承', value: recon.value.high },
  { label: '待检修轴承', value: recon.value.pending },
  { label: '检修待办合计', value: recon.value.maintenanceTodo },
])

const canBatchMark = computed(() => actionAllowed(meta.key, '标记偏高', store.role))
const anyRowActionAllowed = computed(() =>
  actions.some((action) => actionAllowed(meta.key, action, store.role)),
)
const allChecked = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))),
)
const someChecked = computed(
  () => selectedIds.value.length > 0 && !allChecked.value,
)

function statusClass(status: string): string {
  if (status === '温度偏高') return 'st-high'
  if (status === '待检修') return 'st-pending'
  if (status === '已检修') return 'st-done'
  return 'st-normal'
}

function resultLabel(result: BatchItemStatus): string {
  return result === 'success' ? '成功' : result === 'skipped' ? '跳过' : '失败'
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? rows.value.map((row) => Number(row.id)) : []
}

function clearSelection() {
  selectedIds.value = []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '导轴承登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function submitBatch() {
  errorMessage.value = ''
  if (!selectedIds.value.length) {
    return
  }
  const signature = [...selectedIds.value].sort((a, b) => a - b).join(',')
  if (signature !== batchKeySignature) {
    batchKeySignature = signature
    batchKey = `bearing-batch-${Date.now()}-${signature}`
  }
  try {
    const outcome = submitBearingBatch(selectedIds.value, batchKey, {
      name: store.operator,
      role: store.role,
    })
    lastBatch.value = outcome.batch
    lastSubmitReplayed.value = outcome.replayed
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '批量标记提交失败'
  }
}

function viewBatch(batch: BearingBatch) {
  lastBatch.value = batch
  lastSubmitReplayed.value = batch.idempotencyKey === batchKey
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    recon.value = bearingReconciliation()
    batches.value = listBatches()
    // 过滤掉已经不在当前筛选结果里的勾选项。
    const visibleIds = new Set(rows.value.map((row) => Number(row.id)))
    selectedIds.value = selectedIds.value.filter((id) => visibleIds.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导轴承列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.col-check { width: 44px; text-align: center; }
.batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
}
.select-all { font-size: 13px; display: flex; align-items: center; gap: 6px; }
.batch-hint { color: var(--muted); font-size: 12px; }
.role-tip { border-radius: 8px; padding: 8px 12px; font-size: 13px; margin-bottom: 10px; }
.role-tip.warn { background: #fff4e5; border: 1px solid #f5c18b; color: #8a4b08; }
.status-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.st-normal { background: #e8f3ea; color: #287a3d; }
.st-high { background: #fdeceb; color: #b42318; }
.st-pending { background: #fff4e5; color: #8a4b08; }
.st-done { background: #eef2f7; color: #475569; }
.legend-item.version { background: #e7f0ff; color: #1f6feb; }
.result-panel,
.note-panel,
.version-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 14px;
}
.result-panel h3,
.note-panel h3,
.version-panel h3 { margin: 0 0 8px; font-size: 14px; }
.result-summary { font-size: 13px; margin: 0 0 8px; }
.result-summary .ok { color: #287a3d; }
.result-summary .skip { color: #8a4b08; }
.result-summary .fail { color: #b42318; }
.result-tag { border-radius: 4px; padding: 1px 8px; font-size: 12px; }
.result-tag.success { background: #e8f3ea; color: #287a3d; }
.result-tag.skipped { background: #fff4e5; color: #8a4b08; }
.result-tag.failed { background: #fdeceb; color: #b42318; }
.replay-tag {
  margin-left: 8px;
  font-size: 12px;
  font-weight: normal;
  background: #e7f0ff;
  color: #1f6feb;
  border-radius: 4px;
  padding: 1px 8px;
}
.note-text { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
.version-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.version-list li { font-size: 13px; display: flex; align-items: center; gap: 8px; }
.version-list li.active .link { font-weight: 600; }
.current-tag { background: #e8f3ea; color: #287a3d; border-radius: 4px; padding: 1px 8px; font-size: 12px; }
.lock-text { color: var(--muted); font-size: 12px; }
</style>
