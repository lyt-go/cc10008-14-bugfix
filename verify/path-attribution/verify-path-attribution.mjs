/**
 * 路径链路归因修复的端到端验证（独立目录，不进应用构建）。
 * 运行：node verify-path-attribution.mjs
 * 覆盖：闭合判定、并发确认只接受一份结论、首份归因去重、两种仲裁策略、
 *       跨模块复核数据流、以及「已确认路径中不出现未闭合事件链」不变量。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

// 验证脚本位于独立目录，显式指向前端工程里的 esbuild，避免 ESM 忽略 NODE_PATH。
const require = createRequire('/workspace/frontend/')
const { build } = require('esbuild')

// 最小 localStorage 垫片：在动态导入应用模块前就位，避免模块初始化触碰浏览器 API。
const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
}

const built = await build({
  entryPoints: ['/workspace/verify/path-attribution/app-entry.mts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
})
const dataUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString(
  'base64',
)}`
const app = await import(dataUrl)

const {
  confirmChain,
  confirmPath,
  submitAttribution,
  resolveConcurrent,
  buildReviewStream,
  buildFrequentPaths,
  aggregateCompletionRate,
  isChainClosed,
  resetAttributionLedger,
  EVENTTRACE_KEY,
  PATHMAP_KEY,
  listRows,
  saveRows,
  SEED_ROWS,
  service,
} = app

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 从种子数据复制一份隔离的内存数据集，避免用例互相污染。
function seedFresh() {
  storage.clear()
  resetAttributionLedger()
  for (const [key, rows] of Object.entries(SEED_ROWS)) {
    saveRows(key, JSON.parse(JSON.stringify(rows)))
  }
}

try {
  console.log('1) 闭合判定')
  seedFresh()
  const even2 = listRows(EVENTTRACE_KEY).find((row) => row['链路编号'] === 'EVEN-0002')
  const even3 = listRows(EVENTTRACE_KEY).find((row) => row['链路编号'] === 'EVEN-0003')
  check('EVEN-0002 终点未到转化成功且异常溯源中，判定为未闭合', () => {
    assert.equal(isChainClosed(even2).closed, false)
  })
  check('EVEN-0003 序列完整且到达转化成功，判定为闭合', () => {
    assert.equal(isChainClosed(even3).closed, true)
  })

  console.log('2) 未闭合链路确认被拒绝，且不覆盖历史完成率')
  seedFresh()
  const rateBefore = listRows(EVENTTRACE_KEY).find((row) => row.id === 2)['完成率']
  const rejected = confirmChain(2)
  const after = listRows(EVENTTRACE_KEY).find((row) => row.id === 2)
  check('confirmChain 对 EVEN-0002 返回失败', () => assert.equal(rejected.ok, false))
  check('被拒链路状态仍为「溯源中」，完成率保持原值', () => {
    assert.equal(after.status, '溯源中')
    assert.equal(after['完成率'], rateBefore)
  })

  console.log('3) 路径模型确认：未闭合链路隔离在已确认路径之外')
  seedFresh()
  const pathDecision = confirmPath(2)
  check('PATH-0002 因 EVEN-0002 未闭合被拒绝确认', () => {
    assert.equal(pathDecision.ok, false)
    assert.ok(pathDecision.blocking.some((item) => item.chainCode === 'EVEN-0002'))
  })
  check('PATH-0002 状态仍是「分析中」', () => {
    assert.equal(listRows(PATHMAP_KEY).find((row) => row.id === 2).status, '分析中')
  })

  console.log('4) 并发确认只接受一份完整结论，重复提交不覆盖')
  seedFresh()
  const first = confirmChain(3)
  const second = confirmChain(3)
  check('EVEN-0003 首次确认成功并产生归因回执', () => {
    assert.equal(first.ok, true)
    assert.equal(first.receipt.accepted, true)
  })
  check('再次确认只返回首份结论，不重复写入', () => {
    assert.equal(second.ok, true)
  })
  const receiptAgain = submitAttribution(3)
  check('重复归因回执照旧返回且标记 duplicate，不覆盖首份', () => {
    assert.equal(receiptAgain.duplicate, true)
    assert.equal(receiptAgain.accepted, false)
  })

  console.log('5) 修复恢复的路径转化归因只保留首份结果')
  seedFresh()
  const r1 = submitAttribution(3)
  const r2 = submitAttribution(3)
  const path3 = listRows(PATHMAP_KEY).find((row) => row.id === 3)
  check('首份归因写入 PATH-0003', () => {
    assert.equal(r1.accepted, true)
    assert.equal(r1.pathCode, 'PATH-0003')
    assert.ok(String(path3['首份归因链路']).includes('EVEN-0003'))
  })
  check('第二份回执不覆盖首份', () => {
    assert.equal(r2.duplicate, true)
    assert.equal(
      listRows(PATHMAP_KEY).find((row) => row.id === 3)['首份归因链路'],
      path3['首份归因链路'],
    )
  })
  check('未闭合链路 EVEN-0002 的归因直接被拒绝', () => {
    const blocked = submitAttribution(2)
    assert.equal(blocked.ok, false)
    assert.equal(blocked.accepted, false)
  })

  console.log('6) 完成率两侧恢复一致：修正口径剔除未闭合链路')
  seedFresh()
  const rate = aggregateCompletionRate(listRows(EVENTTRACE_KEY))
  check('污染口径（含未闭合 100%）高于修正口径', () => {
    assert.ok(rate.polluted > rate.corrected)
    assert.equal(rate.unclosedCount, 1)
  })
  check('修正口径只统计 EVEN-0001/EVEN-0003 两条闭合链路', () => {
    assert.equal(rate.closedCount, 2)
    assert.ok(Math.abs(rate.corrected - (0.78 + 0.84) / 2) < 1e-9)
  })

  console.log('7) 版本冲突仲裁：两种策略都保证不变量')
  seedFresh()
  const requests = [
    { kind: 'completion', chainId: 3, pathId: 2 },
    { kind: 'interrupt', chainId: 2, pathId: 2 },
  ]
  const completionFirst = resolveConcurrent(2, requests, 'completion-first')
  const closureFirst = resolveConcurrent(2, requests, 'closure-first')
  check('完成事件优先：输出完成链路确认与中断链路隔离单 + 全部回查清单', () => {
    assert.deepEqual(completionFirst.isolatedInterrupts, [2])
    assert.deepEqual(completionFirst.recheckChainIds.sort(), [2, 3])
    assert.equal(completionFirst.pathConfirmed, false)
  })
  check('链路闭合检查优先：输出全部回查清单与延后确认的完成路径', () => {
    assert.deepEqual(closureFirst.deferredCompletions, [3])
    assert.equal(closureFirst.pathConfirmed, false)
    assert.deepEqual(closureFirst.recheckChainIds.sort(), [2, 3])
  })
  const allClosed = resolveConcurrent(
    3,
    [{ kind: 'completion', chainId: 3, pathId: 3 }],
    'completion-first',
  )
  check('无未闭合链路时完成事件优先策略放行路径确认', () => {
    assert.equal(allClosed.pathConfirmed, true)
    assert.deepEqual(allClosed.acceptedCompletion, [3])
  })

  console.log('8) 跨模块复核数据流：重建清单/高频路径/路径模型/归因同流')
  seedFresh()
  confirmChain(3)
  const stream = buildReviewStream()
  check('重建清单包含全部三条链路并标注闭合状态', () => {
    assert.equal(stream.reconstructionList.length, 3)
    assert.equal(
      stream.reconstructionList.find((item) => item.chainCode === 'EVEN-0002').abnormalExit,
      true,
    )
  })
  check('高频行为路径由点击流页面序列聚合而来', () => {
    const edges = buildFrequentPaths().map((item) => item.edge)
    assert.ok(edges.includes('首页 → 商品详情'))
  })
  check('路径模型、归因台账与完成率一起进入复核数据流', () => {
    assert.equal(stream.pathModels.length, SEED_ROWS[PATHMAP_KEY].length)
    assert.equal(stream.attributions.some((item) => item.chainCode === 'EVEN-0003'), true)
    assert.equal(typeof stream.completion.corrected, 'number')
  })
  check('不变量：已确认路径中不出现未闭合事件链', () => {
    assert.deepEqual(stream.unclosedInConfirmedPaths, [])
    for (const model of stream.pathModels.filter((item) => item.status === '已确认')) {
      assert.equal(model.hasUnclosed, false)
    }
  })

  console.log('9) 走 local-service 通用动作入口也受领域闸门保护')
  seedFresh()
  const deny = service.runAction('eventtrace', 2, '确认链路')
  check('runAction 拒绝确认未闭合的 EVEN-0002', () => assert.equal(deny.ok, false))
  const allow = service.runAction('eventtrace', 3, '确认链路')
  check('runAction 放行闭合的 EVEN-0003 并完成归因', () => assert.equal(allow.ok, true))
  const denyPath = service.runAction('pathmap', 2, '确认模型')
  check('runAction 拒绝含未闭合链路的 PATH-0002 确认', () => assert.equal(denyPath.ok, false))

  console.log('10) 重置模块清空归因台账，首份写入重新计数')
  seedFresh()
  submitAttribution(3)
  service.resetModule('eventtrace')
  const afterReset = submitAttribution(3)
  check('重置后再次提交被视为新的首份而非重复回执', () => {
    assert.equal(afterReset.duplicate, false)
    assert.equal(afterReset.accepted, true)
  })

  console.log('11) 不变量自检：已确认路径若混入未闭合链路，复核流会告警')
  seedFresh()
  const tampered = listRows(PATHMAP_KEY).map((row) =>
    row.id === 3 ? { ...row, status: '已确认', pending: false, abnormal: false } : row,
  )
  saveRows(PATHMAP_KEY, tampered)
  // PATH-0003 只关联 EVEN-0003（闭合）；人为再挂一条未闭合的 EVEN-0002 到同转化事件。
  const tamperedChains = listRows(EVENTTRACE_KEY).map((row) =>
    row.id === 2 ? { ...row, '关联转化事件': '会员转化' } : row,
  )
  saveRows(EVENTTRACE_KEY, tamperedChains)
  const alarm = buildReviewStream()
  check('unclosedInConfirmedPaths 精确报出 PATH-0003/EVEN-0002', () => {
    assert.deepEqual(alarm.unclosedInConfirmedPaths, ['PATH-0003/EVEN-0002'])
  })
  const model3 = alarm.pathModels.find((item) => item.pathCode === 'PATH-0003')
  check('路径模型视图标记 hasUnclosed，溯源详情标出异常退出节点', () => {
    assert.equal(model3.hasUnclosed, true)
    const even2 = alarm.reconstructionList.find((item) => item.chainCode === 'EVEN-0002')
    assert.equal(even2.abnormalExit, true)
    assert.equal(even2.closed, false)
  })

  console.log(`\n全部 ${passed} 项断言通过 ✔`)
} catch (error) {
  console.error('验证失败：', error)
  process.exitCode = 1
}
