<template>
  <section class="page" data-module="spare">
    <header class="page-head">
      <div>
        <h2>备品备件管理</h2>
        <p class="page-desc">导轴承备件待办是导轴承结论的只读投影，不另存副本；轴承那边标记、接收、完工，这里同步变化，别的入口打开也是这一份。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记备品备件</button>
        <button class="btn" type="button" @click="exportRows">导出备品备件清单</button>
      </div>
    </header>

    <section class="todo-panel">
      <div class="todo-head">
        <h3>导轴承备件待办（待补充）</h3>
        <span class="todo-count">共 {{ demands.length }} 项，与检修待办同口径（温度偏高＋待检修 {{ recon.spareTodo }} 台）</span>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>轴承编号</th><th>所属机组</th><th>上导温度</th><th>下导温度</th>
            <th>检测日期</th><th>登记时间</th><th>当前结论</th><th>结论版本</th><th>备件需求</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in demands" :key="item.bearingId">
            <td>{{ item.code }}</td>
            <td>{{ item.unit }}</td>
            <td>{{ item.upperTemp }}</td>
            <td>{{ item.lowerTemp }}</td>
            <td>{{ item.detectedAt }}</td>
            <td>{{ item.registeredAt }}</td>
            <td><span :class="['status-pill', item.status === '待检修' ? 'st-pending' : 'st-high']">{{ item.status }}</span></td>
            <td>{{ item.version }}</td>
            <td>{{ item.advice }}</td>
          </tr>
          <tr v-if="!demands.length">
            <td colspan="9" class="empty-state">暂无轴承备件待办：没有温度偏高或待检修的导轴承</td>
          </tr>
        </tbody>
      </table>
      <p v-if="store.role !== 'warehouse'" class="note-text">
        当前岗位「{{ store.roleLabel }}」对备件台账只读；备件的验收、领用、补充只有仓库管理员能操作。
      </p>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
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

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-for="action in actions" :key="action">
              <button
                v-if="store.role === 'warehouse'"
                class="link" type="button" @click="runAction(action, row)"
              >{{ action }}</button>
            </template>
            <span v-if="store.role !== 'warehouse'" class="lock-text">仅查看</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无备品备件数据，可先登记备品备件</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条备品备件记录 · 轴承备件待办 {{ recon.spareTodo }} 项（与导轴承页、检修待办一致）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  bearingReconciliation,
  bearingSpareDemands,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { BearingReconciliation, BearingSpareDemand, EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('spare')
const columns = ['备件编号', '备件名称', '规格型号', '适用设备', '存放位置', '现有数量', '最低储备量', '备件状态']
const actions = ['办理验收', '领用备件', '提交补充']
const statuses = ['待验收', '已登记', '已领用', '待补充']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const demands = ref<BearingSpareDemand[]>([])
const recon = ref<BearingReconciliation>(bearingReconciliation())
const stats = computed(() => [
  { label: '轴承备件待办', value: recon.value.spareTodo },
  { label: '待补充备件', value: rows.value.filter((row) => String(row.status) === '待补充').length },
  { label: '已登记备件', value: rows.value.filter((row) => String(row.status) === '已登记').length },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '备品备件登记入口尚未接入审批流'
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

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    demands.value = bearingSpareDemands()
    recon.value = bearingReconciliation()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '备品备件列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.todo-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 14px;
}
.todo-head { display: flex; justify-content: space-between; align-items: baseline; }
.todo-head h3 { margin: 0 0 8px; font-size: 14px; }
.todo-count { font-size: 12px; color: var(--muted); }
.status-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.st-high { background: #fdeceb; color: #b42318; }
.st-pending { background: #fff4e5; color: #8a4b08; }
.note-text { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.lock-text { color: var(--muted); font-size: 12px; }
</style>
