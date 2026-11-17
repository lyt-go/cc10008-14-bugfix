/**
 * 路径链路归因领域层（纯函数，不直接读写 localStorage）。
 *
 * 修复背景：未闭合的事件链路（如 EVEN-0002）此前被通用状态流转直接归并进「已确认」路径，
 * 导致故障链路的事件链序列被错误归并、修复恢复的路径转化归因偏高、链路完成率两侧不一致。
 *
 * 本模块集中处理四件事：
 *  1. 闭合判定 isChainClosed：未闭合链路在任何入口都不能进入已确认路径；
 *  2. 归因传播 submitAttribution：同一路径只保留首份修复恢复的路径转化归因，重复回执照旧返回；
 *  3. 版本冲突仲裁 resolveConcurrent：完成事件优先 / 链路闭合检查优先两种边界；
 *  4. 复核数据流 buildReviewStream：事件溯源重建清单、高频行为路径、路径模型、路径链路归因
 *     一起进入同一条复核数据流，供事件溯源重建。
 */
import {
  listRows,
  loadAttributionLedger,
  saveAttributionLedger,
  saveRows,
} from '@/data/local-store'
import type { AttributionRecord } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

export const PATHMAP_KEY = 'pathmap'
export const EVENTTRACE_KEY = 'eventtrace'
export const CLICKSTREAM_KEY = 'clickstream'

export const PATH_CONFIRMED_STATUS = '已确认'
export const CHAIN_CONFIRMED_STATUS = '已确认'

const SEQUENCE_SPLIT = /\s*[→>]\s*/
const RATE_PERCENT = /(-?\d+(?:\.\d+)?)\s*%?/

/** 链路与路径模型的归因台账：记录每条事件链路被归到哪个路径模型、是否为首份。 */
type AttributionLedger = Map<number, AttributionRecord>

/** 台账从 localStorage 懒加载，首份写入后持久化；刷新或重复回执都不能覆盖首份结果。 */
let attributionLedger: AttributionLedger | null = null

function ledger(): AttributionLedger {
  if (attributionLedger === null) {
    const stored = loadAttributionLedger()
    attributionLedger = new Map(
      Object.entries(stored).map(([key, record]) => [Number(key), record]),
    )
  }
  return attributionLedger
}

function persistLedger(): void {
  const data: Record<number, AttributionRecord> = {}
  ledger().forEach((record, chainId) => {
    data[chainId] = record
  })
  saveAttributionLedger(data)
}

export function resetAttributionLedger(): void {
  attributionLedger = new Map()
  persistLedger()
}

/** 事件链序列拆成有序事件节点，兼容「A → B → C」与「A>B>C」两种写法。 */
export function splitSequence(sequence: unknown): string[] {
  return String(sequence ?? '')
    .split(SEQUENCE_SPLIT)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/** 解析「82% / 82 / 0.82」三类完成率写法，统一成 0~1 的比例；无法解析返回 null。 */
export function parseRate(value: unknown): number | null {
  const raw = String(value ?? '').trim()
  if (raw === '') {
    return null
  }
  const matched = raw.match(RATE_PERCENT)
  if (!matched) {
    return null
  }
  const num = Number(matched[1])
  if (Number.isNaN(num)) {
    return null
  }
  return raw.includes('%') || num > 1 ? num / 100 : num
}

export type ClosureResult = {
  chainId: number
  chainCode: string
  closed: boolean
  reason: string
  terminalEvent: string
}

/**
 * 闭合判定（链路闭合检查优先的事实来源）。
 * 一条事件链路必须同时满足：
 *  - 事件链序列非空、起点事件存在、链长度与序列节点数一致（结构完整）；
 *  - 终点事件落在转化事件上（到达转化而非中途异常退出）；
 *  - 记录未被标记为异常待处理（abnormal 且仍在 pending 的故障链路一律视为未闭合）。
 */
export function isChainClosed(chain: EntryRow): ClosureResult {
  const code = String(chain['链路编号'] ?? `#${chain.id}`)
  const nodes = splitSequence(chain['事件链序列'])
  const start = String(chain['起点事件'] ?? '').trim()
  const terminal = String(chain['终点事件'] ?? '').trim()
  const declaredLength = Number(chain['链长度'])

  if (nodes.length === 0 || start === '') {
    return {
      chainId: chain.id,
      chainCode: code,
      closed: false,
      reason: '事件链序列或起点事件缺失，链路结构不完整',
      terminalEvent: terminal,
    }
  }
  if (Number.isFinite(declaredLength) && declaredLength > 0 && declaredLength !== nodes.length) {
    return {
      chainId: chain.id,
      chainCode: code,
      closed: false,
      reason: `链长度 ${declaredLength} 与事件链序列节点数 ${nodes.length} 不一致`,
      terminalEvent: terminal,
    }
  }
  if (!terminal.includes('转化成功')) {
    return {
      chainId: chain.id,
      chainCode: code,
      closed: false,
      reason: `终点事件「${terminal || '空'}」未到达转化成功，链路在中途中断`,
      terminalEvent: terminal,
    }
  }
  if (chain.abnormal && chain.pending) {
    return {
      chainId: chain.id,
      chainCode: code,
      closed: false,
      reason: '链路被标记为异常且仍在溯源中，属于故障中断链路',
      terminalEvent: terminal,
    }
  }
  return {
    chainId: chain.id,
    chainCode: code,
    closed: true,
    reason: '事件链序列完整且终点到达转化成功，链路闭合',
    terminalEvent: terminal,
  }
}

/** 仅统计已闭合链路的完成率，避免未闭合故障链路把聚合结果抬高。 */
export function aggregateCompletionRate(chains: EntryRow[]): {
  corrected: number | null
  polluted: number | null
  closedCount: number
  unclosedCount: number
} {
  const closed: number[] = []
  const all: number[] = []
  let unclosedCount = 0
  for (const chain of chains) {
    const rate = parseRate(chain['完成率'])
    if (rate !== null) {
      all.push(rate)
    }
    if (isChainClosed(chain).closed) {
      if (rate !== null) {
        closed.push(rate)
      }
    } else {
      unclosedCount += 1
    }
  }
  const average = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, item) => sum + item, 0) / values.length
  return {
    corrected: average(closed),
    polluted: average(all),
    closedCount: closed.length,
    unclosedCount,
  }
}

/** 链路归属的转化事件：优先取显式登记的「关联转化事件」，中断链路也能被路径模型反查到。 */
function chainConversionEvent(chain: EntryRow): string {
  const explicit = String(chain['关联转化事件'] ?? '').trim()
  if (explicit) {
    return explicit
  }
  return String(chain['终点事件'] ?? '').trim()
}

/** 通过路径模型的「转化事件」字段反查归属它的事件链路（兼容「支付转化」与「支付转化成功」）。 */
export function chainsOfPath(path: EntryRow, chains: EntryRow[]): EntryRow[] {
  const conversion = String(path['转化事件'] ?? '').trim()
  if (conversion === '') {
    return []
  }
  return chains.filter((chain) => {
    const linked = chainConversionEvent(chain)
    // 终点事件以转化事件为前缀（支付转化成功 命中 支付转化），或反向包含。
    return linked === conversion || linked.startsWith(conversion) || linked.includes(conversion)
  })
}

export type AttributionReceipt = {
  ok: boolean
  accepted: boolean
  duplicate: boolean
  chainId: number
  chainCode: string
  pathId: number | null
  pathCode: string | null
  message: string
}

/**
 * 归因传播（首份写入）。
 * 未闭合链路直接拒绝，不产生任何写入；闭合链路只在首次提交时把归因结果写进路径模型，
 * 同一链路的重复提交返回「照旧」回执且不覆盖首份结果。
 */
export function submitAttribution(chainId: number): AttributionReceipt {
  const chains = listRows(EVENTTRACE_KEY)
  const chain = chains.find((row) => Number(row.id) === chainId)
  if (!chain) {
    return {
      ok: false,
      accepted: false,
      duplicate: false,
      chainId,
      chainCode: `#${chainId}`,
      pathId: null,
      pathCode: null,
      message: `没有找到编号为 ${chainId} 的事件链路`,
    }
  }
  const code = String(chain['链路编号'] ?? `#${chain.id}`)
  const closure = isChainClosed(chain)
  if (!closure.closed) {
    return {
      ok: false,
      accepted: false,
      duplicate: false,
      chainId: chain.id,
      chainCode: code,
      pathId: null,
      pathCode: null,
      message: `链路 ${code} 未闭合（${closure.reason}），已拒绝归因，不能并入已确认路径`,
    }
  }

  const paths = listRows(PATHMAP_KEY)
  // 链路登记的关联转化事件命中路径模型的转化事件（如「支付转化」）。
  const linkedConversion = chainConversionEvent(chain)
  const path = paths.find((item) => {
    const conversion = String(item['转化事件'] ?? '').trim()
    return (
      conversion !== '' &&
      (linkedConversion === conversion ||
        linkedConversion.startsWith(conversion) ||
        linkedConversion.includes(conversion))
    )
  })

  const ledgerEntry = ledger().get(chain.id)
  if (ledgerEntry) {
    const owner = paths.find((item) => Number(item.id) === ledgerEntry.pathId)
    return {
      ok: true,
      accepted: false,
      duplicate: true,
      chainId: chain.id,
      chainCode: code,
      pathId: ledgerEntry.pathId,
      pathCode: owner ? String(owner['模型编号'] ?? '') : null,
      message: `链路 ${code} 的修复恢复路径转化归因已存在首份结果，重复回执照旧返回，不覆盖历史完成率`,
    }
  }
  if (!path) {
    return {
      ok: false,
      accepted: false,
      duplicate: false,
      chainId: chain.id,
      chainCode: code,
      pathId: null,
      pathCode: null,
      message: `链路 ${code} 闭合但未匹配到转化事件对应的路径模型，无法归因`,
    }
  }

  // 首份归因：只写这一次，并把归因链路落到路径模型上；后续重复提交不再触碰历史完成率。
  ledger().set(chain.id, { pathId: path.id, firstWrite: true })
  persistLedger()
  const attributed = new Set(
    [...ledger().entries()]
      .filter(([, record]) => record.pathId === path.id)
      .map(([chainId]) => chainId),
  )
  const nextPaths = paths.map((item) =>
    item.id === path.id
      ? {
          ...item,
          首份归因链路: [...attributed]
            .map((chainId) => chains.find((row) => row.id === chainId)?.['链路编号'])
            .filter(Boolean)
            .join('、'),
        }
      : item,
  )
  saveRows(PATHMAP_KEY, nextPaths)
  return {
    ok: true,
    accepted: true,
    duplicate: false,
    chainId: chain.id,
    chainCode: code,
    pathId: path.id,
    pathCode: String(path['模型编号'] ?? ''),
    message: `链路 ${code} 闭合，首份修复恢复路径转化归因已写入路径模型 ${path['模型编号'] ?? path.id}`,
  }
}

export type ChainConfirmation = {
  ok: boolean
  chainId: number
  chainCode: string
  closure: ClosureResult
  receipt: AttributionReceipt | null
  message: string
}

/**
 * 确认链路：闭合判定是确认的前置闸门。
 * 未闭合链路被拒绝且保持原状态，绝不覆盖历史完成率；闭合链路确认后再做首份归因传播。
 */
export function confirmChain(chainId: number): ChainConfirmation {
  const chains = listRows(EVENTTRACE_KEY)
  const chain = chains.find((row) => Number(row.id) === chainId)
  if (!chain) {
    return {
      ok: false,
      chainId,
      chainCode: `#${chainId}`,
      closure: {
        chainId,
        chainCode: `#${chainId}`,
        closed: false,
        reason: '链路不存在',
        terminalEvent: '',
      },
      receipt: null,
      message: `没有找到编号为 ${chainId} 的事件链路`,
    }
  }
  const code = String(chain['链路编号'] ?? `#${chain.id}`)
  const closure = isChainClosed(chain)
  if (!closure.closed) {
    return {
      ok: false,
      chainId: chain.id,
      chainCode: code,
      closure,
      receipt: null,
      message: `链路 ${code} 未闭合（${closure.reason}），确认被拒绝，历史完成率保持不变`,
    }
  }

  // 已经确认过的链路：状态不重复写；归因统一交给 submitAttribution，
  // 台账保证只有首份写入，重复点击拿到的是照旧返回的回执（种子自带的已确认链路也在此补登首份）。
  if (String(chain.status) === CHAIN_CONFIRMED_STATUS) {
    return {
      ok: true,
      chainId: chain.id,
      chainCode: code,
      closure,
      receipt: submitAttribution(chain.id),
      message: `链路 ${code} 已确认，只接受首份完整结论，不重复覆盖`,
    }
  }

  const next = chains.map((row) =>
    row.id === chain.id
      ? { ...row, status: CHAIN_CONFIRMED_STATUS, pending: false, abnormal: false }
      : row,
  )
  saveRows(EVENTTRACE_KEY, next)
  const receipt = submitAttribution(chain.id)
  return {
    ok: true,
    chainId: chain.id,
    chainCode: code,
    closure,
    receipt,
    message: `链路 ${code} 闭合判定通过，已确认并传播首份路径转化归因`,
  }
}

export type PathConfirmation = {
  ok: boolean
  pathId: number
  pathCode: string
  blocking: ClosureResult[]
  message: string
}

/**
 * 确认路径模型：已确认路径中不出现未闭合事件链（跨模块不变量）。
 * 任何挂在该路径转化事件上的链路未闭合，确认即被拒绝。
 */
export function confirmPath(pathId: number): PathConfirmation {
  const paths = listRows(PATHMAP_KEY)
  const path = paths.find((row) => Number(row.id) === pathId)
  if (!path) {
    return {
      ok: false,
      pathId,
      pathCode: `#${pathId}`,
      blocking: [],
      message: `没有找到编号为 ${pathId} 的路径模型`,
    }
  }
  const code = String(path['模型编号'] ?? `#${pathId}`)
  const blocking = chainsOfPath(path, listRows(EVENTTRACE_KEY))
    .map(isChainClosed)
    .filter((result) => !result.closed)
  if (blocking.length > 0) {
    return {
      ok: false,
      pathId: path.id,
      pathCode: code,
      blocking,
      message: `路径模型 ${code} 存在 ${blocking.length} 条未闭合事件链路（${blocking
        .map((item) => item.chainCode)
        .join('、')}），确认被拒绝，未闭合链路隔离在已确认路径之外`,
    }
  }
  const next = paths.map((row) =>
    row.id === path.id
      ? { ...row, status: PATH_CONFIRMED_STATUS, pending: false, abnormal: false }
      : row,
  )
  saveRows(PATHMAP_KEY, next)
  return {
    ok: true,
    pathId: path.id,
    pathCode: code,
    blocking: [],
    message: `路径模型 ${code} 关联链路全部闭合，已确认`,
  }
}

export type ConcurrentRequest = {
  kind: 'completion' | 'interrupt'
  chainId: number
  pathId: number
}

export type ArbitrationPolicy = 'completion-first' | 'closure-first'

export type ArbitrationOutcome = {
  policy: ArbitrationPolicy
  pathId: number
  pathConfirmed: boolean
  acceptedCompletion: number[]
  isolatedInterrupts: number[]
  deferredCompletions: number[]
  recheckChainIds: number[]
  message: string
}

/**
 * 同一路径模型上「完成链路确认」与「中断链路回执」并发到达时的版本冲突仲裁。
 * 两种边界都保证同一条不变量：已确认路径中不出现未闭合事件链。
 *
 * - completion-first（完成事件优先）：先落完成链路的路径确认，再做链路闭合检查，
 *   中断链路生成隔离单挡在已确认路径之外，产出全部链路回查清单；
 * - closure-first（链路闭合检查优先）：先跑闭合检查，未闭合则完成确认延后，
 *   产出全部链路回查清单与延后确认的完成路径。
 */
export function resolveConcurrent(
  pathId: number,
  requests: ConcurrentRequest[],
  policy: ArbitrationPolicy,
): ArbitrationOutcome {
  const chains = listRows(EVENTTRACE_KEY)
  const closureById = new Map(chains.map((chain) => [chain.id, isChainClosed(chain)]))
  const interrupts = requests.filter((request) => request.kind === 'interrupt')
  const completions = requests.filter((request) => request.kind === 'completion')

  const isolatedInterrupts = interrupts
    .map((request) => request.chainId)
    .filter((chainId) => !closureById.get(chainId)?.closed)
  const recheckChainIds = requests.map((request) => request.chainId)
  const closedCompletions = completions
    .filter((request) => closureById.get(request.chainId)?.closed)
    .map((request) => request.chainId)
  const deferredCompletions = completions
    .filter((request) => !closureById.get(request.chainId)?.closed)
    .map((request) => request.chainId)

  if (policy === 'completion-first') {
    const canConfirm = isolatedInterrupts.length === 0 && deferredCompletions.length === 0
    return {
      policy,
      pathId,
      pathConfirmed: canConfirm,
      acceptedCompletion: canConfirm ? closedCompletions : [],
      isolatedInterrupts,
      deferredCompletions,
      recheckChainIds,
      message: canConfirm
        ? '完成事件优先：完成链路的路径确认已落库，中断链路隔离单已生成，全部链路进入回查清单'
        : '完成事件优先：存在未闭合中断链路，路径确认被拦截并生成中断链路隔离单，全部链路回查',
    }
  }

  const canConfirm = isolatedInterrupts.length === 0 && deferredCompletions.length === 0
  return {
    policy,
    pathId,
    // 闭合检查优先：只要有一条链路未闭合，整条路径确认延后，
    // 即使完成链路本身闭合也不抢先确认，统一进入延后确认的完成路径清单。
    pathConfirmed: canConfirm,
    acceptedCompletion: canConfirm ? closedCompletions : [],
    isolatedInterrupts,
    deferredCompletions: canConfirm ? [] : completions.map((request) => request.chainId),
    recheckChainIds,
    message: canConfirm
      ? '链路闭合检查优先：全部链路闭合，完成路径确认放行'
      : '链路闭合检查优先：闭合检查未通过，完成路径整体延后确认，输出全部链路回查清单与延后确认的完成路径',
  }
}

export type ReconstructionEntry = {
  chainId: number
  chainCode: string
  status: string
  closed: boolean
  closureReason: string
  sequence: string[]
  terminalEvent: string
  completionRate: number | null
  abnormalExit: boolean
}

export type FrequentPath = {
  edge: string
  count: number
}

export type PathAttributionView = {
  pathId: number
  pathCode: string
  status: string
  linkedChains: { chainCode: string; closed: boolean }[]
  hasUnclosed: boolean
}

export type ReviewStream = {
  generatedAt: string
  reconstructionList: ReconstructionEntry[]
  frequentPaths: FrequentPath[]
  pathModels: PathAttributionView[]
  attributions: { chainCode: string; pathCode: string; firstWrite: boolean }[]
  completion: ReturnType<typeof aggregateCompletionRate>
  unclosedInConfirmedPaths: string[]
}

/** 高频行为路径：顺着点击流（clickstream）既有数据流，把页面序列聚合成相邻页面边。 */
export function buildFrequentPaths(): FrequentPath[] {
  const counter = new Map<string, number>()
  for (const click of listRows(CLICKSTREAM_KEY)) {
    const pages = splitSequence(click['页面序列'])
    for (let index = 0; index < pages.length - 1; index += 1) {
      const edge = `${pages[index]} → ${pages[index + 1]}`
      counter.set(edge, (counter.get(edge) ?? 0) + 1)
    }
  }
  return [...counter.entries()]
    .map(([edge, count]) => ({ edge, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * 跨模块复核数据流：事件溯源重建清单 + 高频行为路径 + 路径模型 + 路径链路归因
 * 一起进入路径链路归因的复核数据流，供事件溯源重建使用。
 */
export function buildReviewStream(): ReviewStream {
  const chains = listRows(EVENTTRACE_KEY)
  const paths = listRows(PATHMAP_KEY)

  const reconstructionList: ReconstructionEntry[] = chains.map((chain) => {
    const closure = isChainClosed(chain)
    return {
      chainId: chain.id,
      chainCode: String(chain['链路编号'] ?? `#${chain.id}`),
      status: String(chain.status),
      closed: closure.closed,
      closureReason: closure.reason,
      sequence: splitSequence(chain['事件链序列']),
      terminalEvent: closure.terminalEvent,
      completionRate: parseRate(chain['完成率']),
      abnormalExit: !closure.closed,
    }
  })

  const pathModels: PathAttributionView[] = paths.map((path) => {
    const linked = chainsOfPath(path, chains).map((chain) => ({
      chainCode: String(chain['链路编号'] ?? `#${chain.id}`),
      closed: isChainClosed(chain).closed,
    }))
    return {
      pathId: path.id,
      pathCode: String(path['模型编号'] ?? `#${path.id}`),
      status: String(path.status),
      linkedChains: linked,
      hasUnclosed: linked.some((item) => !item.closed),
    }
  })

  const attributions = [...ledger().entries()].map(([chainId, entry]) => {
    const chain = chains.find((item) => item.id === chainId)
    const path = paths.find((item) => item.id === entry.pathId)
    return {
      chainCode: chain ? String(chain['链路编号'] ?? `#${chainId}`) : `#${chainId}`,
      pathCode: path ? String(path['模型编号'] ?? `#${entry.pathId}`) : `#${entry.pathId}`,
      firstWrite: entry.firstWrite,
    }
  })

  // 不变量自检：已确认路径里绝不允许出现未闭合事件链。
  const unclosedInConfirmedPaths = pathModels
    .filter((model) => model.status === PATH_CONFIRMED_STATUS && model.hasUnclosed)
    .flatMap((model) =>
      model.linkedChains.filter((item) => !item.closed).map((item) => `${model.pathCode}/${item.chainCode}`),
    )

  return {
    generatedAt: new Date().toISOString(),
    reconstructionList,
    frequentPaths: buildFrequentPaths(),
    pathModels,
    attributions,
    completion: aggregateCompletionRate(chains),
    unclosedInConfirmedPaths,
  }
}
