import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { Dataset, ExecutionRecord, PendingUpload, TestCase, TestStatus, TestStep } from './types'
import { devices, routes, seedCases, seedExecutions } from './mock'

const STORAGE_KEY = 'yy57-interlocking-dataset-v2'
const CURRENT_VERSION = 'v26.10'

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
function nowIso() {
  return new Date().toISOString()
}

/** 站场设备快照：当前版本下设备与进路关系的固化 */
function buildSnapshot() {
  return {
    version: CURRENT_VERSION,
    capturedAt: nowIso(),
    devices: structuredClone(devices),
    routes: structuredClone(routes),
  }
}

/** 种子记录补全并发 / 审核 / 效力字段 */
function hydrateSeed(record: ExecutionRecord): ExecutionRecord {
  return {
    ...record,
    reviewState: '已审核',
    validity: record.snapshot === CURRENT_VERSION ? '有效' : '已失效',
    version: 1,
    terminal: '历史终端',
    seq: 0,
  }
}

export const useTestStore = defineStore('interlocking', () => {
  const cases = ref<TestCase[]>(structuredClone(seedCases))
  const dataset = reactive<Dataset>({
    snapshot: buildSnapshot(),
    executions: seedExecutions.map(hydrateSeed),
    baseline: { locked: false, version: CURRENT_VERSION },
    caseVersions: {},
  })
  for (const record of dataset.executions) {
    dataset.caseVersions[record.caseId] = Math.max(dataset.caseVersions[record.caseId] ?? 0, record.version)
  }

  const selectedCaseId = ref('TC-102')
  const selectedRouteIds = ref<string[]>(['R-02'])
  const connection = ref<'在线' | '重连中'>('在线')
  const pendingRetry = ref(0)
  const pendingUploads = ref<PendingUpload[]>([])
  const conflicts = ref<string[]>([])
  const liveMessage = ref('执行进度已同步')
  const seqCounter = ref(0)

  const selectedCase = computed(() => cases.value.find((item) => item.id === selectedCaseId.value))
  const progress = computed(() => {
    const steps = cases.value.flatMap((item) => item.steps)
    return Math.round(steps.filter((step) => step.result !== '未执行').length / steps.length * 100)
  })

  // 设备改动：P-02 转辙机更换、T-03 绝缘节调整
  const changedDeviceIds = ['P-02', 'T-03']
  const changedDevices = ['P-02 转辙机更换', 'T-03 绝缘节调整']

  /** 按当前进路重算受影响进路：设备落在进路上即受影响 */
  const affectedRouteIds = computed(() => {
    const set = new Set<string>()
    for (const route of dataset.snapshot.routes) {
      if (route.devices.some((deviceId) => changedDeviceIds.includes(deviceId))) set.add(route.id)
    }
    return set
  })
  /** 按当前进路重算受影响用例：用例关联进路与受影响进路有交集 */
  const affectedCases = computed(() =>
    cases.value.filter((item) => item.routeIds.some((routeId) => affectedRouteIds.value.has(routeId))),
  )

  const baselineLocked = computed(() => dataset.baseline.locked)
  const pendingReviewCount = computed(() => dataset.executions.filter((record) => record.reviewState === '待复核').length)
  const invalidCount = computed(() => dataset.executions.filter((record) => record.validity === '已失效').length)

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cases: cases.value,
      dataset: {
        snapshot: dataset.snapshot,
        executions: dataset.executions,
        baseline: dataset.baseline,
        caseVersions: dataset.caseVersions,
      },
      seqCounter: seqCounter.value,
    }))
  }

  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const draft = JSON.parse(raw)
    if (draft.cases) cases.value = draft.cases
    if (draft.dataset) {
      dataset.snapshot = draft.dataset.snapshot
      dataset.executions = draft.dataset.executions
      dataset.baseline = draft.dataset.baseline
      dataset.caseVersions = draft.dataset.caseVersions ?? {}
    }
    if (typeof draft.seqCounter === 'number') seqCounter.value = draft.seqCounter
  }

  function selectCase(id: string) {
    selectedCaseId.value = id
    selectedRouteIds.value = cases.value.find((item) => item.id === id)?.routeIds ?? []
  }

  function setStepResult(caseId: string, stepId: string, result: TestStep['result'], actual?: string) {
    if (dataset.baseline.locked) {
      liveMessage.value = '基线已锁定，步骤变更请走变更流程'
      return
    }
    const item = cases.value.find((entry) => entry.id === caseId)
    const step = item?.steps.find((entry) => entry.id === stepId)
    if (!item || !step) return
    if (step.dependency && item.steps.find((entry) => entry.id === step.dependency)?.result !== '通过') {
      liveMessage.value = `前置步骤 ${step.dependency} 未通过，禁止跳过`
      return
    }
    step.result = result
    step.actual = actual ?? step.actual
    item.status = item.steps.some((entry) => entry.result === '失败')
      ? '失败'
      : item.steps.every((entry) => entry.result === '通过')
        ? '通过'
        : '执行中'
    persist()
  }

  /**
   * 提交执行结果（唯一入口，承载并发与补传规则）
   * - 断网：进入补传队列，按 seq 保证恢复后按原顺序补传
   * - 在线：乐观并发校验，后到的一方看到版本冲突
   */
  function submitExecution(input: {
    caseId: string
    result: TestStatus
    evidence: string[]
    operator: string
    terminal: string
    baseVersion: number
  }): { ok: boolean; queued?: boolean; conflict?: string } {
    if (connection.value === '重连中') {
      const seq = ++seqCounter.value
      pendingUploads.value.push({
        seq,
        terminal: input.terminal,
        caseId: input.caseId,
        result: input.result,
        evidence: input.evidence,
        operator: input.operator,
        startedAt: nowTime(),
        baseVersion: input.baseVersion,
        snapshot: dataset.snapshot.version,
        enqueuedAt: nowIso(),
      })
      liveMessage.value = `已进入补传队列（#${seq}），恢复后按原顺序上传`
      persist()
      return { ok: true, queued: true }
    }
    return applySubmit(input)
  }

  function applySubmit(input: {
    caseId: string
    result: TestStatus
    evidence: string[]
    operator: string
    terminal: string
    baseVersion: number
  }): { ok: boolean; conflict?: string } {
    const currentVersion = dataset.caseVersions[input.caseId] ?? 0

    // 规则：两个终端同时提交同一用例，后到的一方看到版本冲突
    if (input.baseVersion !== currentVersion) {
      const message = `终端 ${input.terminal} 提交 ${input.caseId} 时版本冲突（本地 v${input.baseVersion} / 服务端 v${currentVersion}），已拒绝`
      conflicts.value.unshift(message)
      liveMessage.value = '版本冲突：后到提交被拒绝'
      persist()
      return { ok: false, conflict: '版本冲突：该用例已有更新的执行记录' }
    }

    // 规则：已审核的失败记录不可覆盖（仅同快照内；设备改动后新快照允许重测）
    const reviewedFailure = dataset.executions.find(
      (record) =>
        record.caseId === input.caseId &&
        record.snapshot === dataset.snapshot.version &&
        record.reviewState === '已审核' &&
        record.result === '失败',
    )
    if (reviewedFailure) {
      const message = `终端 ${input.terminal} 提交 ${input.caseId} 失败，但已审核失败记录 ${reviewedFailure.id} 不可覆盖`
      conflicts.value.unshift(message)
      liveMessage.value = '已审核失败记录不可覆盖'
      persist()
      return { ok: false, conflict: '已审核失败记录不可覆盖' }
    }

    // 规则：补传同一用例快照只认首次结果
    const duplicated = dataset.executions.find(
      (record) => record.caseId === input.caseId && record.snapshot === dataset.snapshot.version,
    )
    if (duplicated) {
      const message = `终端 ${input.terminal} 补传 ${input.caseId} 同一快照 ${dataset.snapshot.version} 已存在首次结果（${duplicated.id}），只认首次`
      conflicts.value.unshift(message)
      liveMessage.value = '同一快照只认首次结果'
      persist()
      return { ok: false, conflict: '同一快照只认首次结果' }
    }

    const seq = ++seqCounter.value
    const record: ExecutionRecord = {
      id: `EX-${Date.now().toString().slice(-6)}-${seq}`,
      caseId: input.caseId,
      operator: input.operator,
      startedAt: nowTime(),
      finishedAt: input.result === '执行中' ? undefined : nowTime(),
      snapshot: dataset.snapshot.version,
      result: input.result,
      evidence: input.evidence,
      // 规则：基线锁定后新记录只进待复核
      reviewState: dataset.baseline.locked ? '待复核' : '已审核',
      validity: '有效',
      version: currentVersion + 1,
      terminal: input.terminal,
      seq,
    }
    dataset.executions.unshift(record)
    dataset.caseVersions[input.caseId] = currentVersion + 1
    persist()
    return { ok: true }
  }

  /** 恢复网络：按原顺序补传 */
  function retry() {
    connection.value = '在线'
    const pending = [...pendingUploads.value].sort((a, b) => a.seq - b.seq)
    let accepted = 0
    for (const item of pending) {
      const result = applySubmit({
        caseId: item.caseId,
        result: item.result,
        evidence: item.evidence,
        operator: item.operator,
        terminal: item.terminal,
        baseVersion: item.baseVersion,
      })
      if (result.ok) accepted += 1
    }
    pendingUploads.value = []
    pendingRetry.value = 0
    liveMessage.value = `断线期间 ${pending.length} 项记录已按原顺序补传（成功 ${accepted}，冲突 ${pending.length - accepted}）`
    persist()
  }

  function simulateDisconnect() {
    connection.value = '重连中'
    pendingRetry.value += 1
  }

  /** 设备改动：旧执行记录失效，受影响用例按当前进路重算 */
  function applyEquipmentChange() {
    for (const record of dataset.executions) {
      if (record.snapshot !== dataset.snapshot.version) record.validity = '已失效'
    }
    liveMessage.value = `设备变更已生效：${invalidCount.value} 条旧记录失效，受影响用例 ${affectedCases.value.length} 条`
    persist()
  }

  /** 锁定发布基线：固化用例、进路、证据快照 */
  function lockBaseline() {
    if (dataset.baseline.locked || !dataset.snapshot) return
    const evidence = dataset.executions.flatMap((record) => record.evidence)
    const snapshot = {
      version: dataset.snapshot.version,
      lockedAt: nowIso(),
      operator: '当前用户',
      cases: cases.value.map((item) => ({
        id: item.id,
        name: item.name,
        status: item.status,
        version: item.version,
        routeIds: [...item.routeIds],
        precondition: item.precondition,
        failureReason: item.failureReason,
        steps: item.steps.map((step) => ({
          id: step.id,
          action: step.action,
          expected: step.expected,
          result: step.result,
          actual: step.actual,
          evidence: step.evidence,
        })),
      })),
      routes: structuredClone(dataset.snapshot.routes),
      devices: structuredClone(dataset.snapshot.devices),
      evidence,
    }
    dataset.baseline = {
      locked: true,
      version: dataset.snapshot.version,
      lockedAt: nowIso(),
      snapshot,
    }
    liveMessage.value = `发布基线 v${dataset.snapshot.version} 已锁定，报告引用锁定时快照`
    persist()
  }

  /** 报告：基线锁定后引用锁定时的用例、进路和证据 */
  function buildReport() {
    const locked = dataset.baseline.locked && dataset.baseline.snapshot
    const snapshotCases = locked
      ? dataset.baseline.snapshot!.cases
      : cases.value.map((item) => ({
          id: item.id,
          name: item.name,
          status: item.status,
          version: item.version,
          routeIds: [...item.routeIds],
          precondition: item.precondition,
          failureReason: item.failureReason,
          steps: item.steps.map((step) => ({
            id: step.id,
            action: step.action,
            expected: step.expected,
            result: step.result,
            actual: step.actual,
            evidence: step.evidence,
          })),
        }))
    return {
      station: '海州站 CS',
      version: dataset.baseline.version,
      locked: dataset.baseline.locked,
      lockedAt: dataset.baseline.lockedAt,
      cases: snapshotCases,
      routes: locked ? dataset.baseline.snapshot!.routes : dataset.snapshot.routes,
      evidence: locked ? dataset.baseline.snapshot!.evidence : dataset.executions.flatMap((record) => record.evidence),
      executions: dataset.executions,
      generatedAt: nowIso(),
    }
  }

  function startExecution() {
    const item = selectedCase.value
    if (!item) return
    const baseVersion = dataset.caseVersions[item.id] ?? 0
    const result = submitExecution({
      caseId: item.id,
      result: '执行中',
      evidence: [],
      operator: '当前用户',
      terminal: '本终端',
      baseVersion,
    })
    if (result.ok) {
      item.status = '执行中'
      if (result.queued) liveMessage.value = '已进入补传队列，恢复后按序上传'
    } else {
      liveMessage.value = result.conflict ?? '提交失败'
    }
  }

  /** 模拟两个终端同时提交同一用例：后到的一方看到版本冲突 */
  function simulateConcurrentSubmit() {
    const item = selectedCase.value
    if (!item) return { ok: false }
    const baseVersion = dataset.caseVersions[item.id] ?? 0
    const first = submitExecution({
      caseId: item.id,
      result: '通过',
      evidence: ['并发证据-A'],
      operator: '终端A',
      terminal: '终端A',
      baseVersion,
    })
    const second = submitExecution({
      caseId: item.id,
      result: '失败',
      evidence: ['并发证据-B'],
      operator: '终端B',
      terminal: '终端B',
      baseVersion,
    })
    return { ok: true, caseId: item.id, first, second }
  }

  function updateLiveProgress(value: number) {
    liveMessage.value = value >= 100 ? '全部用例执行完成，等待审核锁定' : `实时同步：已完成 ${value}%`
    if (value >= 100) {
      const active = dataset.executions.find((record) => record.result === '执行中' && record.validity === '有效')
      if (active) {
        active.result = '失败'
        active.finishedAt = nowTime()
        persist()
      }
    }
  }

  watch(cases, persist, { deep: true })
  watch(dataset, persist, { deep: true })
  restore()
  // 初始化时按当前进路重算受影响范围，并让旧快照记录失效
  applyEquipmentChange()

  return {
    cases,
    dataset,
    selectedCaseId,
    selectedRouteIds,
    selectedCase,
    progress,
    baselineLocked,
    connection,
    pendingRetry,
    pendingUploads,
    conflicts,
    liveMessage,
    changedDevices,
    changedDeviceIds,
    affectedCases,
    affectedRouteIds,
    pendingReviewCount,
    invalidCount,
    selectCase,
    setStepResult,
    submitExecution,
    retry,
    simulateDisconnect,
    applyEquipmentChange,
    lockBaseline,
    buildReport,
    startExecution,
    simulateConcurrentSubmit,
    updateLiveProgress,
  }
})
