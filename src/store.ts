import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import type { DeviceChange, SubmitResult, TestStep } from './types'
import { devices, routes, seedCases, seedExecutions } from './mock'
import { InterlockDataset } from './engine'

const STORAGE_KEY = 'yy57-interlocking-v2'
const TERMINALS = ['TERM-A 手持终端', 'TERM-B 现场终端'] as const
export type TerminalId = (typeof TERMINALS)[number]

interface PersistShape {
  engine: ReturnType<InterlockDataset['toJSON']>
  checkout: Record<string, Record<string, number>>
  selectedCaseId: string
}

export const useTestStore = defineStore('interlocking', () => {
  function bootstrap(): InterlockDataset {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const saved = JSON.parse(raw) as PersistShape
        return InterlockDataset.restore(saved.engine, routes, devices)
      } catch {
        // 损坏的本地草稿不阻断现场使用，回退引导数据
      }
    }
    return new InterlockDataset(seedCases, routes, devices, seedExecutions)
  }

  const engineRef = shallowRef<InterlockDataset>(bootstrap())
  // engine 是纯逻辑对象，每次变更后 bump 一次驱动 computed 重算
  const version = ref(0)
  function bump(): void { version.value += 1; persist() }

  const selectedCaseId = ref(localStorage.getItem(STORAGE_KEY) ? (JSON.parse(localStorage.getItem(STORAGE_KEY)!) as PersistShape).selectedCaseId ?? 'TC-102' : 'TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const activeTerminal = ref<TerminalId>(TERMINALS[0])
  /** 各终端本地检出的用例 revision，两端同时提交时后到一方据此判版本冲突 */
  const checkout = ref<Record<string, Record<string, number>>>({})
  const liveMessage = ref('执行进度已同步')

  const cases = computed(() => { void version.value; return engineRef.value.cases })
  const executions = computed(() => { void version.value; return engineRef.value.executions })
  const outbox = computed(() => { void version.value; return engineRef.value.outbox })
  const changes = computed(() => { void version.value; return engineRef.value.changes })
  const conflicts = computed(() => { void version.value; return engineRef.value.conflicts })
  const baseline = computed(() => { void version.value; return engineRef.value.baseline })
  const currentSnapshot = computed(() => { void version.value; return engineRef.value.currentSnapshot })
  const connection = computed<'在线' | '重连中'>(() => { void version.value; return engineRef.value.online ? '在线' : '重连中' })
  const pendingRetry = computed(() => outbox.value.filter((item) => item.state === '待补传').length)
  const baselineLocked = computed(() => baseline.value !== null)
  const reviewQueue = computed(() => executions.value.filter((r) => r.reviewState === '待复核' && !r.stale))

  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    return Math.round(steps.filter((step) => step.result !== '未执行').length / steps.length * 100)
  })

  const changedDevices = computed(() => {
    void version.value
    return changes.value.map((c) => ({
      id: c.id,
      label: `${c.deviceId} ${c.description}`,
      routeIds: c.routeIds,
      caseIds: c.caseIds,
      invalidatedExecutionIds: c.invalidatedExecutionIds,
      snapshotId: c.snapshotId,
    }))
  })
  const affectedCases = computed(() => {
    void version.value
    const ids = new Set(engineRef.value.affectedCaseIds())
    return cases.value.filter((item) => ids.has(item.id))
  })
  /** 发布门禁：每个用例都在当前快照上有一条未失效、已审核的通过记录，且发件箱清空 */
  const gateReady = computed(() => {
    void version.value
    if (baselineLocked.value || pendingRetry.value > 0) return false
    return cases.value.every((testCase) => executions.value.some((r) =>
      r.caseId === testCase.id && r.result === '通过' && r.reviewState === '已审核' && !r.stale && r.snapshotId === currentSnapshot.value.id))
  })

  function persist(): void {
    const payload: PersistShape = {
      engine: engineRef.value.toJSON(),
      checkout: checkout.value,
      selectedCaseId: selectedCaseId.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  }

  function selectCase(id: string): void {
    selectedCaseId.value = id
    selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? []
    persist()
  }

  function setStepResult(caseId: string, stepId: string, result: TestStep['result'], actual?: string): void {
    if (baselineLocked.value) { liveMessage.value = '基线已锁定，步骤只读；新执行只进待复核'; return }
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    if (!item || !step) return
    if (step.dependency && item.steps.find((entry) => entry.id === step.dependency)?.result !== '通过') {
      liveMessage.value = `前置步骤 ${step.dependency} 未通过，禁止跳过`
      return
    }
    step.result = result
    step.actual = actual ?? step.actual
    item.status = item.steps.some((entry) => entry.result === '失败') ? '失败' : item.steps.every((entry) => entry.result === '通过') ? '通过' : '执行中'
    bump()
  }

  function checkedRevision(terminal: string, caseId: string): number {
    return checkout.value[terminal]?.[caseId] ?? cases.value.find((c) => c.id === caseId)?.revision ?? 0
  }

  /** 视图层判断：终端检出版本是否落后于服务端（提交将版本冲突） */
  function isStaleCheckout(terminal: string, caseId: string): boolean {
    const testCase = cases.value.find((c) => c.id === caseId)
    return !!testCase && checkout.value[terminal]?.[caseId] !== undefined && checkout.value[terminal]![caseId]! < testCase.revision
  }

  /** 终端检出用例（开始执行）：绑定当前 revision，作为并发冲突判定基准 */
  function startExecution(terminal: TerminalId = activeTerminal.value): void {
    const item = selectedCase.value
    if (!item) return
    checkout.value[terminal] = { ...checkout.value[terminal], [item.id]: item.revision }
    if (item.status === '未执行' || item.status === '阻塞') item.status = '执行中'
    liveMessage.value = `${terminal} 已检出 ${item.id}（基线 r${item.revision}），可开始执行`
    bump()
  }

  /** 终端拉取最新版本：冲突后必须先刷新合并，再重提 */
  function pullLatest(terminal: TerminalId = activeTerminal.value): void {
    const item = selectedCase.value
    if (!item) return
    checkout.value[terminal] = { ...checkout.value[terminal], [item.id]: item.revision }
    liveMessage.value = `${terminal} 已刷新到 r${item.revision}`
    bump()
  }

  /**
   * 提交执行结果：在线直接入账；断网进 FIFO 发件箱，恢复后按原顺序补传。
   * 同一幂等键/同一用例快照只认首次结果；版本冲突与已审核失败保护由引擎拒绝。
   */
  function submitExecution(result: '通过' | '失败', actual: string, evidenceText: string, terminal: TerminalId = activeTerminal.value): SubmitResult {
    const item = selectedCase.value
    if (!item) return { outcome: 'conflict', message: '未选择用例' }
    const evidence = evidenceText.split(/[、,，\s]+/).filter(Boolean)
    const draft = {
      caseId: item.id,
      operator: terminal.startsWith('TERM-A') ? '陆晨' : '方瑜',
      result,
      evidence,
      actual: actual.trim() || undefined,
      baseRevision: checkedRevision(terminal, item.id),
    }
    const idempotencyKey = `${terminal}:${item.id}@${currentSnapshot.value.id}:${Date.now()}`
    const submitResult = engineRef.value.submit(draft, terminal, idempotencyKey)
    bump()

    if (submitResult.outcome === 'accepted') {
      const pending = item.steps.find((step) => step.result === '未执行')
      if (pending) setStepResult(item.id, pending.id, result, actual)
      checkout.value[terminal] = { ...checkout.value[terminal], [item.id]: item.revision }
      persist()
    }
    liveMessage.value = submitResult.message
    return submitResult
  }

  function simulateDisconnect(): void {
    engineRef.value.online = false
    liveMessage.value = '现场断网：提交将先入待补传队列，恢复后按原顺序补传'
    bump()
  }

  function setConnectionState(online: boolean): void {
    if (engineRef.value.online === online) return
    engineRef.value.online = online
    liveMessage.value = online ? '连接恢复' : 'WebSocket 断开，进入断网暂存模式'
    bump()
  }

  function updateLiveProgress(value: number): void {
    liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`
  }

  function retry(): void {
    engineRef.value.online = true
    const summary = engineRef.value.flushOutbox()
    liveMessage.value = `网络恢复，按原顺序补传 ${summary.sent} 笔` +
      (summary.duplicate ? `，同快照重复丢弃 ${summary.duplicate} 笔` : '') +
      (summary.conflict ? `，版本冲突 ${summary.conflict} 笔` : '')
    bump()
  }

  function registerDeviceChange(deviceId: string, description: string): DeviceChange | null {
    try {
      const change = engineRef.value.registerDeviceChange(deviceId, description, '当前用户')
      liveMessage.value = `${deviceId} 改动已登记：旧执行记录失效，按当前进路重算受影响 ${change.routeIds.length} 条进路 / ${change.caseIds.length} 条用例`
      bump()
      return change
    } catch (error) {
      liveMessage.value = (error as Error).message
      return null
    }
  }

  function lockBaseline(version = 'v26.10'): void {
    engineRef.value.lockBaseline(version)
    liveMessage.value = `发布基线 ${version} 已锁定，新记录只进待复核，报告引用锁定时的用例、进路和证据`
    bump()
  }

  function getReport() { void version.value; return engineRef.value.getReport() }

  return {
    cases, executions, outbox, changes, conflicts, baseline, currentSnapshot, reviewQueue,
    selectedCaseId, selectedRouteIds, selectedCase, progress, changedDevices, affectedCases,
    connection, pendingRetry, liveMessage, baselineLocked, gateReady,
    activeTerminal, terminals: TERMINALS,
    selectCase, setStepResult, startExecution, pullLatest, submitExecution, checkedRevision, isStaleCheckout,
    simulateDisconnect, setConnectionState, updateLiveProgress, retry, registerDeviceChange, lockBaseline, getReport,
  }
})
