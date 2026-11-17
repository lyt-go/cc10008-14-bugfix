<template>
  <section class="page" data-module="eventtrace">
    <header class="page-head">
      <div>
        <h2>事件溯源管理</h2>
        <p class="page-desc">追踪完整的事件链路，从首个触发到最终转化的事件序列溯源分析。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记事件链路</button>
        <button class="btn" type="button" @click="exportRows">导出事件溯源清单</button>
      </div>
    </header>

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
          <th>闭合判定</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span :class="closureOf(row).closed ? 'tag ok' : 'tag warn'">
              {{ closureOf(row).closed ? '已闭合' : '未闭合' }}
            </span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无事件溯源数据，可先登记事件链路</td>
        </tr>
      </tbody>
    </table>

    <section class="review-panel">
      <header class="review-head">
        <h3>路径链路归因复核数据流</h3>
        <button class="btn ghost" type="button" @click="refreshReview">刷新复核数据流</button>
      </header>
      <p class="review-meta">
        生成时间 {{ review.generatedAt }} ｜
        修正后链路完成率 {{ formatRate(review.completion.corrected) }}
        （含未闭合的污染口径 {{ formatRate(review.completion.polluted) }}）｜
        已闭合 {{ review.completion.closedCount }} 条 · 未闭合 {{ review.completion.unclosedCount }} 条
      </p>
      <p v-if="review.unclosedInConfirmedPaths.length" class="error-text">
        不变量告警：已确认路径出现未闭合链路 {{ review.unclosedInConfirmedPaths.join('、') }}
      </p>
      <p v-else class="review-ok">不变量校验通过：已确认路径中不出现未闭合事件链。</p>

      <div class="review-grid">
        <article class="review-card">
          <h4>事件溯源重建清单</h4>
          <ul class="review-list">
            <li v-for="item in review.reconstructionList" :key="item.chainCode">
              <span :class="item.closed ? 'tag ok' : 'tag warn'">{{ item.closed ? '闭合' : '未闭合' }}</span>
              <strong>{{ item.chainCode }}</strong>
              <span class="muted">{{ item.sequence.join(' → ') }}</span>
              <em class="muted">{{ item.closureReason }}</em>
            </li>
          </ul>
        </article>

        <article class="review-card">
          <h4>高频行为路径（点击流）</h4>
          <ul class="review-list">
            <li v-for="item in review.frequentPaths" :key="item.edge">
              <strong>{{ item.edge }}</strong>
              <span class="muted">{{ item.count }} 次</span>
            </li>
            <li v-if="!review.frequentPaths.length" class="muted">暂无点击流页面序列</li>
          </ul>
        </article>

        <article class="review-card">
          <h4>路径模型与链路归因</h4>
          <ul class="review-list">
            <li v-for="model in review.pathModels" :key="model.pathCode">
              <strong>{{ model.pathCode }}（{{ model.status }}）</strong>
              <span class="muted">
                关联链路：
                <template v-if="model.linkedChains.length">
                  <span
                    v-for="link in model.linkedChains"
                    :key="link.chainCode"
                    :class="link.closed ? 'tag ok' : 'tag warn'"
                  >{{ link.chainCode }}</span>
                </template>
                <template v-else>无</template>
              </span>
            </li>
          </ul>
          <h4>首份归因台账</h4>
          <ul class="review-list">
            <li v-for="item in review.attributions" :key="item.chainCode">
              <strong>{{ item.chainCode }} → {{ item.pathCode }}</strong>
              <span class="tag ok">首份{{ item.firstWrite ? '已留存' : '' }}</span>
            </li>
            <li v-if="!review.attributions.length" class="muted">暂无已写入的修复恢复路径转化归因</li>
          </ul>
        </article>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条事件溯源记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  buildReviewStream,
  isChainClosed,
} from '@/domain/path-attribution'
import type { ReviewStream } from '@/domain/path-attribution'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('eventtrace')
const columns = ["链路编号", "事件链序列", "链长度", "起点事件", "终点事件", "关联转化事件", "中间事件数", "完成率", "平均耗时秒"]
const actions = ["发起溯源", "确认链路", "归档链路"]
const statuses = ["草稿", "溯源中", "已确认", "已归档"]
const stats = [{"label": "事件链路总数", "value": 0}, {"label": "已确认链路", "value": 0}, {"label": "溯源中链路", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const review = ref<ReviewStream>(buildReviewStream())
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function closureOf(row: EntryRow) {
  return isChainClosed(row)
}

function formatRate(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function refreshReview() {
  review.value = buildReviewStream()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '事件链路登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
  refreshReview()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '事件溯源列表读取失败'
  }
}

onMounted(reload)
</script>
