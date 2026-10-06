<template>
  <section class="page" data-module="bearing">
    <header class="page-head">
      <div>
        <h2>导轴承管理</h2>
        <p class="page-desc">
          大负荷后勾选多台导轴承，整组批量标记偏高：成功的逐台进入待检修清单，重复提交只算一次，失败逐条列出原因。
          列表、检修待办、备件待办与导出清单同读一份结论台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出导轴承清单</button>
      </div>
    </header>

    <p v-if="!canMark" class="role-banner readonly">当前岗位（{{ roleText }}）在本页只读，标记与检修动作请由归属岗位执行。</p>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">待检修待办：{{ todoCount }} 台（与检修班组、备件待办同源）</span>
      <span v-if="activeVersion" class="legend-item">
        生效结论：v{{ activeVersion.version }}（{{ activeVersion.createdAt }}）
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="bulk-bar">
      <label class="select-all">
        <input type="checkbox" :checked="allChecked" :indeterminate.prop="someChecked" @change="toggleAll" />
        全选当前筛选结果
      </label>
      <button class="btn primary" type="button" :disabled="!canMark || selectedIds.length === 0" @click="submitBatch">
        批量标记偏高（已选 {{ selectedIds.length }} 台）
      </button>
      <span class="bulk-hint">同一次提交重复勾选或重复整组提交，同一台只算一次，台数不重复增加。</span>
    </div>

    <div v-if="batchResult" class="batch-panel">
      <header class="batch-head">
        <strong>批次 {{ batchResult.batchId }} 结果</strong>
        <span>提交 {{ batchResult.requested }} 台 ·
          成功 {{ batchResult.successCount }} ·
          重复跳过 {{ batchResult.skippedCount }} ·
          失败 {{ batchResult.failedCount }}</span>
        <button class="link" type="button" @click="batchResult = null">关闭</button>
      </header>
      <table class="data-table batch-table">
        <thead>
          <tr><th>轴承编号</th><th>结果</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in batchResult.items" :key="item.bearingId">
            <td>{{ item.bearingCode }}</td>
            <td>
              <span :class="['outcome', item.outcome]">{{ outcomeText[item.outcome] }}</span>
            </td>
            <td>
              <template v-if="item.outcome === 'success'">已进入待检修清单，当前等级「{{ item.grade }}」</template>
              <template v-else>{{ item.reason }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td>
            <input
              type="checkbox"
              :value="Number(row.id)"
              v-model="selectedIds"
              :disabled="!canMark"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="canAction('提交检测')"
              class="link"
              type="button"
              @click="runSingle('提交检测', row)"
            >提交检测</button>
            <button
              v-if="canAction('标记偏高')"
              class="link"
              type="button"
              @click="runSingle('标记偏高', row)"
            >标记偏高</button>
            <button
              v-if="canAction('确认检修')"
              class="link"
              type="button"
              @click="runSingle('确认检修', row)"
            >确认检修</button>
            <span v-if="!canAnyAction" class="muted-text">只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无导轴承数据</td>
        </tr>
      </tbody>
    </table>

    <section class="ledger-block">
      <header class="ledger-head">
        <h3>历史记录回填与结论版本</h3>
        <button
          v-if="store.role === 'admin'"
          class="btn"
          type="button"
          @click="doBackfill"
        >按检测日期整版回填</button>
      </header>
      <p class="ledger-hint">
        历史轴承记录按检测日期整体回填；早期只记了上导温度、缺下导温度的，下导温度按「未测量」补登，
        只按上导温度判定，并在清单与导出里另列一行说明。新版回填不改写已经在册的结论；
        仅保留最新一版为生效版，旧版本只读留存，其他入口只读生效版这一份。
      </p>
      <table v-if="versions.length" class="data-table">
        <thead>
          <tr><th>版本</th><th>回填时间</th><th>操作人</th><th>新定级</th><th>保留在册</th><th>缺字段说明</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="ver in [...versions].reverse()" :key="ver.version">
            <td>v{{ ver.version }}</td>
            <td>{{ ver.createdAt }}</td>
            <td>{{ ver.operator }}</td>
            <td>{{ ver.covered }}</td>
            <td>{{ ver.keptExisting }}</td>
            <td>{{ ver.missingFieldCount }}</td>
            <td>{{ ver.active ? '生效版（各入口读这一份）' : '只读留存' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted-text">尚未回填过历史记录。</p>
    </section>

    <section v-if="lastBatches.length" class="ledger-block">
      <header class="ledger-head">
        <h3>批量标记提交记录</h3>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>批次</th><th>提交时间</th><th>提交人</th><th>提交台数</th><th>成功</th><th>重复跳过</th><th>失败</th></tr>
        </thead>
        <tbody>
          <tr v-for="batch in lastBatches" :key="batch.batchId">
            <td>{{ batch.batchId }}</td>
            <td>{{ batch.submittedAt }}</td>
            <td>{{ batch.operator }}</td>
            <td>{{ batch.requested }}</td>
            <td>{{ batch.successCount }}</td>
            <td>{{ batch.skippedCount }}</td>
            <td>{{ batch.failedCount }}</td>
          </tr>
        </tbody>
      </table>
      <p class="todo-foot">重复整组提交时全部计入「重复跳过」，待检修台数不重复增加。</p>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条导轴承记录 · 待检修 {{ summary.pendingCount }} 台</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  activeBackfillVersion,
  backfillHistory,
  batchMarkHigh,
  bearingRows,
  bearingSummary,
  confirmBearingRepair,
  exportBearingCsv,
  listRepairTodos,
  markBearingHigh,
  recentBatches,
  runBackfill,
  submitBearingInspection,
} from '@/api/bearing-service'
import { filterRows } from '@/api/local-service'
import { canRunAction, roleLabel } from '@/data/roles'
import type { RoleKey } from '@/data/roles'
import { useSessionStore } from '@/stores/session'
import type { BearingBatchResult, EntryRow } from '@/data/types'

const store = useSessionStore()

const columns = ['轴承编号', '所属机组', '上导温度', '下导温度', '油位高度', '振动数值', '检测日期', '轴承状态']
const statuses = ['正常', '温度偏高', '待检修', '已检修']
const filterFields = columns.slice(0, 2)
const outcomeText = { success: '成功', skipped: '重复跳过', failed: '失败' } as const

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const selectedIds = ref<number[]>([])
const batchResult = ref<BearingBatchResult | null>(null)
const versions = ref(backfillHistory())
const lastBatches = ref(recentBatches())

const role = computed<RoleKey>(() => store.role)
const roleText = computed(() => roleLabel(role.value))
const canMark = computed(() => canRunAction(role.value, 'bearing', '标记偏高'))
const canRepair = computed(() => canRunAction(role.value, 'bearing', '确认检修'))
const canSubmit = computed(() => canRunAction(role.value, 'bearing', '提交检测'))
const canAnyAction = computed(() => canMark.value || canRepair.value || canSubmit.value)

const summary = computed(() => bearingSummary())
const todoCount = computed(() => listRepairTodos().length)
const activeVersion = computed(() => activeBackfillVersion())

const statCards = computed(() => [
  { label: '正常轴承', value: summary.value.counts.正常 },
  { label: '温度偏高轴承', value: summary.value.counts.温度偏高 },
  { label: '待检修轴承', value: summary.value.counts.待检修 },
  { label: '已检修轴承', value: summary.value.counts.已检修 },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const allChecked = computed(() => rows.value.length > 0 && rows.value.every((row) => selectedIds.value.includes(Number(row.id))))
const someChecked = computed(
  () => rows.value.some((row) => selectedIds.value.includes(Number(row.id))) && !allChecked.value,
)

function canAction(action: string): boolean {
  return canRunAction(role.value, 'bearing', action)
}

function displayValue(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || String(value) === '') {
    return column === '下导温度' ? '未测量' : '—'
  }
  return String(value)
}

function toggleAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked ? rows.value.map((row) => Number(row.id)) : []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  const { filename, content } = exportBearingCsv()
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

function flash(message: string) {
  errorMessage.value = message
}

function runSingle(action: '提交检测' | '标记偏高' | '确认检修', row: EntryRow) {
  errorMessage.value = ''
  const id = Number(row.id)
  const result =
    action === '提交检测'
      ? submitBearingInspection(id, role.value, roleText.value)
      : action === '标记偏高'
        ? markBearingHigh(id, role.value, roleText.value)
        : confirmBearingRepair(id, role.value, roleText.value)
  if (!result.ok) {
    flash(result.message)
  }
  reload()
}

function submitBatch() {
  errorMessage.value = ''
  if (selectedIds.value.length === 0) {
    return
  }
  const result = batchMarkHigh(selectedIds.value, role.value, roleText.value)
  batchResult.value = result
  selectedIds.value = []
  reload()
  lastBatches.value = recentBatches()
}

function doBackfill() {
  errorMessage.value = ''
  const result = runBackfill(role.value, roleText.value)
  if (!result.ok) {
    flash(result.message)
    return
  }
  versions.value = backfillHistory()
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = filterRows(bearingRows(), filters.value)
    total.value = rows.value.length
    // 清掉筛选后已不存在的勾选项，避免把看不到的台数带进批量提交。
    const visibleIds = new Set(rows.value.map((row) => Number(row.id)))
    selectedIds.value = selectedIds.value.filter((id) => visibleIds.has(id))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导轴承列表读取失败'
  }
}

onMounted(reload)
</script>
