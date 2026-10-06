<template>
  <section class="page" data-module="overhaul">
    <header class="page-head">
      <div>
        <h2>机组检修管理</h2>
        <p class="page-desc">检修待办直接读导轴承那一份结论：温度偏高的在此接收，待检修的办理完工；页面不另存副本。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修工作票</button>
        <button class="btn" type="button" @click="exportRows">导出机组检修清单</button>
      </div>
    </header>

    <section class="todo-panel">
      <div class="todo-head">
        <h3>检修班组待办（与导轴承列表、备件待办同口径）</h3>
        <span class="todo-count">共 {{ recon.maintenanceTodo }} 台：温度偏高 {{ recon.high }} · 待检修 {{ recon.pending }}</span>
      </div>
      <div v-if="store.role !== 'maintenance'" class="role-tip warn">
        当前岗位「{{ store.roleLabel }}」只读；接收检修、办理完工只有检修班组能操作。
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>轴承编号</th><th>所属机组</th><th>上导温度</th><th>下导温度</th>
            <th>检测日期</th><th>登记时间</th><th>当前结论</th><th>结论版本</th><th>处理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in todoRows" :key="String(row.id)">
            <td>{{ row['轴承编号'] }}</td>
            <td>{{ row['所属机组'] }}</td>
            <td>{{ row['上导温度'] ?? '未记录' }}</td>
            <td>
              {{ row['下导温度'] ?? '未记录（早期缺项）' }}
            </td>
            <td>{{ row['检测日期'] }}</td>
            <td>{{ row['登记时间'] ?? row['检测日期'] }}</td>
            <td><span :class="['status-pill', String(row.status) === '待检修' ? 'st-pending' : 'st-high']">{{ row.status }}</span></td>
            <td>{{ row['结论版本'] ?? '初始台账' }}</td>
            <td class="row-actions">
              <button
                v-if="store.role === 'maintenance' && row.status === '温度偏高'"
                class="link" type="button" @click="receive(row)"
              >接收检修</button>
              <button
                v-if="store.role === 'maintenance' && row.status === '待检修'"
                class="link" type="button" @click="finish(row)"
              >办理完工</button>
              <span v-if="store.role !== 'maintenance'" class="lock-text">仅查看</span>
            </td>
          </tr>
          <tr v-if="!todoRows.length">
            <td colspan="9" class="empty-state">暂无待检修轴承：温度偏高＋待检修为 0 台</td>
          </tr>
        </tbody>
      </table>
      <p v-if="recon.missingLowerGuide.length" class="note-text">
        另有 {{ recon.missingLowerGuide.length }} 台早期台账缺下导温度（已在导轴承页另列说明），本页不臆造补值。
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
                v-if="store.role === 'maintenance'"
                class="link" type="button" @click="runAction(action, row)"
              >{{ action }}</button>
            </template>
            <span v-if="store.role !== 'maintenance'" class="lock-text">仅查看</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机组检修数据，可先登记检修工作票</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条机组检修记录 · 导轴承检修待办 {{ recon.maintenanceTodo }} 台（与导轴承页一致）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  bearingReconciliation,
  downloadEntries,
  finishOverhaul,
  listEntries,
  maintenanceTodoRows,
  moduleMeta,
  receiveForOverhaul,
  runAction as applyAction,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { BearingReconciliation, EntryRow } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('overhaul')
const columns = ['工作票号', '检修机组', '检修级别', '计划工期', '实际工期', '工作负责人', '验收人员', '检修状态']
const actions = ['提交审批', '开工检修', '办理完工']
const statuses = ['待审批', '已批准', '检修中', '已完工']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const todoRows = ref<EntryRow[]>([])
const recon = ref<BearingReconciliation>(bearingReconciliation())
const stats = computed(() => [
  { label: '检修待办（偏高+待修）', value: recon.value.maintenanceTodo },
  { label: '待接收（温度偏高）', value: recon.value.high },
  { label: '待完工（待检修）', value: recon.value.pending },
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
  errorMessage.value = '检修工作票登记入口尚未接入审批流'
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

function receive(row: EntryRow) {
  errorMessage.value = ''
  const result = receiveForOverhaul(Number(row.id), { role: store.role })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function finish(row: EntryRow) {
  errorMessage.value = ''
  const result = finishOverhaul(Number(row.id), { role: store.role })
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
    todoRows.value = maintenanceTodoRows()
    recon.value = bearingReconciliation()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '机组检修列表读取失败'
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
.role-tip { border-radius: 8px; padding: 8px 12px; font-size: 13px; margin-bottom: 10px; }
.role-tip.warn { background: #fff4e5; border: 1px solid #f5c18b; color: #8a4b08; }
.status-pill { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.st-high { background: #fdeceb; color: #b42318; }
.st-pending { background: #fff4e5; color: #8a4b08; }
.note-text { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.lock-text { color: var(--muted); font-size: 12px; }
</style>
