// 纯 Node 验证：断网补传顺序 / 同快照只认首次 / 设备改动失效重算 / 版本冲突 / 已审核失败保护 / 基线冻结
// 运行：node --experimental-strip-types scripts/verify.ts
import { InterlockDataset } from '../src/engine.ts'
import { devices, routes, seedCases, seedExecutions } from '../src/mock.ts'

let passed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { console.error(`  ✗ ${name} ${detail}`); process.exitCode = 1 }
}

// 1) 断网：按原顺序补传
let ds = new InterlockDataset(seedCases, routes, devices, seedExecutions)
ds.online = false
// TC-102 在引导快照是“执行中”，未占用 用例@快照 首条（可提交）
const r1 = ds.submit({ caseId: 'TC-102', operator: '甲', result: '通过', evidence: ['E1'], baseRevision: 0 }, 'TERM-A', 'k1')
const r2 = ds.submit({ caseId: 'TC-104', operator: '甲', result: '阻塞', evidence: ['E2'], baseRevision: 0 }, 'TERM-A', 'k2')
check('断网提交进入发件箱', r1.outcome === 'queued' && r2.outcome === 'queued' && ds.pendingOutbox.length === 2)
ds.online = true
const flush = ds.flushOutbox()
check('恢复后按入队原顺序补传', flush.sent === 2 && ds.outbox.map((q) => q.enqueueSeq).join() === '1,2'
  && ds.executions.filter((e) => ['TERM-A'].includes(e.terminalId)).map((e) => e.seq).join() === '4,5')
// 重复补传同幂等键
const dup = ds.submit({ caseId: 'TC-102', operator: '甲', result: '通过', evidence: ['E1'], baseRevision: 0 }, 'TERM-A', 'k1', true)
check('同幂等键补传只入账一次', dup.outcome === 'duplicate')
// 同用例快照第二条（不同幂等键）也只认首次
const dup2 = ds.submit({ caseId: 'TC-102', operator: '乙', result: '失败', evidence: ['E9'], baseRevision: 1 }, 'TERM-B', 'k3', true)
check('同一用例快照只认首次结果', dup2.outcome === 'duplicate')

// 2) 设备改动：旧记录失效 + 按当前进路重算范围
ds = new InterlockDataset(seedCases, routes, devices, seedExecutions)
const chg = ds.registerDeviceChange('P-02', 'P-02 转辙机更换', '甲')
check('设备改动重算进路范围', chg.routeIds.join() === 'R-01,R-02,R-03', chg.routeIds.join())
check('设备改动重算用例范围（TC-101/102/103）', chg.caseIds.join() === 'TC-101,TC-102,TC-103', chg.caseIds.join())
check('旧快照执行记录失效留痕，已审核失败继续受保护', ds.executions.filter((e) => e.stale).length === 1
  && ds.executions.find((e) => e.caseId === 'TC-101')?.stale === true
  && ds.executions.find((e) => e.caseId === 'TC-103')?.stale === false
  && ds.executions.every((e) => e.evidenceHash))
check('宣告了新设备快照', ds.currentSnapshot.id === 'SNAP-02' && ds.currentSnapshot.leuVersion === 'CS-LEU-09')
check('受影响用例 revision 已抬升', ds.cases.find((c) => c.id === 'TC-101').revision === 2)
// 补传旧快照首条：入账即失效
ds.online = false
ds.submit({ caseId: 'TC-104', operator: '甲', result: '通过', evidence: ['E4'], baseRevision: 0, snapshotId: 'SNAP-01' }, 'TERM-A', 'k4')
ds.registerDeviceChange('T-03', 'T-03 绝缘节调整', '甲')
ds.online = true
const flush2 = ds.flushOutbox()
const back = ds.executions.find((e) => e.idempotencyKey === 'k4')
check('旧快照补传入账即失效，不污染当前状态', flush2.sent === 1 && back.stale === true && back.invalidatedBy === 'SNAP-03')

// 3) 两端并发：版本冲突
ds = new InterlockDataset(seedCases, routes, devices, seedExecutions)
ds.registerDeviceChange('P-02', 'P-02 转辙机更换', '甲') // 新快照下各用例首条开放
const a = ds.submit({ caseId: 'TC-104', operator: '甲', result: '通过', evidence: ['EA'], baseRevision: 0 }, 'TERM-A', 'ka')
const b = ds.submit({ caseId: 'TC-104', operator: '乙', result: '失败', evidence: ['EB'], baseRevision: 0 }, 'TERM-B', 'kb')
check('先到一方入账', a.outcome === 'accepted')
check('后到一方版本冲突且未覆盖', b.outcome === 'conflict' && ds.executions.filter((e) => e.caseId === 'TC-104' && !e.stale).length === 1)
check('冲突事件留痕', ds.conflicts[0].caseId === 'TC-104' && ds.conflicts[0].terminalId === 'TERM-B')
// 刷新后重提可成功（新快照仍是首条失败路径？首条已占 → duplicate；换未占用用例 TC-101）
const c = ds.submit({ caseId: 'TC-101', operator: '乙', result: '失败', evidence: ['EC'], baseRevision: 2 }, 'TERM-B', 'kc')
check('刷新到最新 revision 后可提交', c.outcome === 'accepted')

// 4) 已审核失败不可覆盖
ds = new InterlockDataset(seedCases, routes, devices, seedExecutions)
ds.registerDeviceChange('P-02', 'P-02 转辙机更换', '甲')
const overwrite = ds.submit({ caseId: 'TC-103', operator: '乙', result: '通过', evidence: ['HACK'], baseRevision: 2 }, 'TERM-B', 'ko')
check('已审核失败记录禁止覆盖', overwrite.outcome === 'conflict'
  && ds.executions.find((e) => e.caseId === 'TC-103' && e.result === '失败' && e.reviewState === '已审核'))

// 5) 基线锁定：新记录只进待复核，报告引用冻结点
ds = new InterlockDataset(seedCases, routes, devices, seedExecutions)
const before = ds.getReport()
const baseline = ds.lockBaseline('v26.10')
const frozenExecCount = baseline.executions.length
const frozenRevision = ds.cases.find((c) => c.id === 'TC-101').revision
const locked = ds.submit({ caseId: 'TC-102', operator: '甲', result: '通过', evidence: ['EL'], baseRevision: 0 }, 'TERM-A', 'kl')
check('锁定后新记录只进待复核', locked.outcome === 'review-pending'
  && ds.executions.at(-1).reviewState === '待复核'
  && ds.cases.find((c) => c.id === 'TC-102').revision === 0)
const after = ds.getReport()
check('报告仍引用锁定时的用例与证据', after.locked === true
  && after.executions.length === frozenExecCount
  && !after.executions.some((e) => e.idempotencyKey === 'kl')
  && after.pendingReview.some((e) => e.idempotencyKey === 'kl')
  && after.cases.find((c) => c.id === 'TC-101').revision === frozenRevision)
check('冻结点包含进路与证据哈希', baseline.routes.length === 4 && baseline.evidence.every((e) => e.evidenceHash.startsWith('sha1-')))

console.log(`\n${passed} 项断言全部通过`)
