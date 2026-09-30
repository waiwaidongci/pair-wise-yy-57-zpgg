import type {
  BaselineFrozen,
  ConflictEvent,
  DeviceChange,
  DeviceSnapshot,
  ExecutionDraft,
  ExecutionRecord,
  OutboxItem,
  ReviewState,
  RouteRelation,
  StationDevice,
  SubmitResult,
  TestCase,
  TestStatus,
} from './types'

/** 证据指纹（演示用确定性哈希，语义等同内容寻址的证据签章） */
export function hashEvidence(evidence: string[]): string {
  const text = evidence.slice().sort().join('|')
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return `sha1-${hash.toString(16).padStart(8, '0')}`
}

export function nowLabel(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

export interface EngineStateJSON {
  snapshots: DeviceSnapshot[]
  cases: TestCase[]
  executions: ExecutionRecord[]
  outbox: OutboxItem[]
  changes: DeviceChange[]
  conflicts: ConflictEvent[]
  baseline: BaselineFrozen | null
  acceptedCaseSnapshotKeys: string[][]
  counters: { seq: number; enqueueSeq: number; recordSeq: number; snapshotSeq: number; changeSeq: number }
  currentSnapshotId: string
  online: boolean
}

export interface EngineSeedExecution {
  caseId: string
  operator: string
  startedAt: string
  finishedAt?: string
  result: ExecutionRecord['result']
  evidence: string[]
  reviewState: ReviewState
}

/**
 * 联锁测试数据集：把站场设备快照、用例执行记录和发布基线接到同一份数据里。
 * 纯 TypeScript，不依赖 Vue，store 层只负责响应式包装与持久化。
 */
export class InterlockDataset {
  snapshots: DeviceSnapshot[] = []
  cases: TestCase[] = []
  executions: ExecutionRecord[] = []
  /** 断网期间的现场提交，恢复后按 enqueueSeq 原序补传 */
  outbox: OutboxItem[] = []
  changes: DeviceChange[] = []
  conflicts: ConflictEvent[] = []
  baseline: BaselineFrozen | null = null
  /** 已入账的 用例@快照 集合：同一用例快照只认首次结果 */
  private acceptedCaseSnapshotKeys = new Set<string>()
  private counters = { seq: 0, enqueueSeq: 0, recordSeq: 0, snapshotSeq: 0, changeSeq: 0 }
  currentSnapshotId = ''
  online = true

  private routes: RouteRelation[] = []
  private devices: StationDevice[] = []

  constructor(cases: TestCase[], routes: RouteRelation[], devices: StationDevice[], seed: EngineSeedExecution[]) {
    this.cases = structuredClone(cases)
    this.routes = structuredClone(routes)
    this.devices = structuredClone(devices)
    const snapshot = this.declareSnapshot('v26.09', 'CS-LEU-08', Object.fromEntries(this.devices.map((d) => [d.id, `${d.id}@cfg-09`])), '引导', '基线快照（现场历史记录）')
    seed.forEach((entry) => {
      this.counters.seq += 1
      const record: ExecutionRecord = {
        id: `EX-${String(this.counters.recordSeq += 1).padStart(4, '0')}`,
        caseId: entry.caseId,
        operator: entry.operator,
        terminalId: 'TERM-引导',
        seq: this.counters.seq,
        snapshotId: snapshot.id,
        snapshotLabel: `${snapshot.softwareVersion} / ${snapshot.leuVersion}`,
        baseRevision: cases.find((c) => c.id === entry.caseId)?.revision ?? 0,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
        result: entry.result,
        evidence: entry.evidence,
        evidenceHash: hashEvidence(entry.evidence),
        reviewState: entry.reviewState,
        stale: false,
        idempotencyKey: `seed-${entry.caseId}-${snapshot.id}`,
      }
      this.executions.push(record)
      if (entry.result !== '执行中') this.acceptedCaseSnapshotKeys.add(`${record.caseId}@${snapshot.id}`)
    })
  }

  get currentSnapshot(): DeviceSnapshot {
    return this.snapshots.find((s) => s.id === this.currentSnapshotId) ?? this.snapshots[0]!
  }

  private declareSnapshot(softwareVersion: string, leuVersion: string, deviceHashes: Record<string, string>, capturedBy: string, note?: string): DeviceSnapshot {
    this.counters.snapshotSeq += 1
    const snapshot: DeviceSnapshot = {
      id: `SNAP-${String(this.counters.snapshotSeq).padStart(2, '0')}`,
      softwareVersion,
      leuVersion,
      deviceHashes,
      capturedAt: `${nowLabel()}${note ? ` · ${note}` : ''}`,
      capturedBy,
    }
    this.snapshots.push(snapshot)
    this.currentSnapshotId = snapshot.id
    return snapshot
  }

  private makeRecord(draft: ExecutionDraft, terminalId: string, seq: number, idempotencyKey: string, snapshotId: string, reviewState: ReviewState): ExecutionRecord {
    const snapshot = this.snapshots.find((s) => s.id === snapshotId)!
    return {
      id: `EX-${String(this.counters.recordSeq += 1).padStart(4, '0')}`,
      caseId: draft.caseId,
      operator: draft.operator,
      terminalId,
      seq,
      snapshotId,
      snapshotLabel: `${snapshot.softwareVersion} / ${snapshot.leuVersion}`,
      baseRevision: draft.baseRevision,
      startedAt: draft.startedAt ?? nowLabel(),
      finishedAt: draft.finishedAt ?? nowLabel(),
      result: draft.result,
      evidence: draft.evidence,
      evidenceHash: hashEvidence(draft.evidence),
      reviewState,
      stale: false,
      idempotencyKey,
    }
  }

  /**
   * 现场提交一笔执行记录。
   * @param replay true 表示断线恢复后的补传（同快照重复只认首次，按重复丢弃）
   *
   * 优先级：幂等去重 → 已审核失败保护 → 同快照首条 → 版本冲突 → 入账（锁定后只进待复核）
   */
  submit(draft: ExecutionDraft, terminalId: string, idempotencyKey: string, replay = false): SubmitResult {
    const testCase = this.cases.find((item) => item.id === draft.caseId)
    if (!testCase) return { outcome: 'conflict', message: `用例 ${draft.caseId} 不存在` }

    if (!this.online && !replay) return this.enqueue(draft, terminalId, idempotencyKey)

    // 同一笔提交（幂等键）补传多次，只入账一次
    const sameKey = this.executions.find((r) => r.idempotencyKey === idempotencyKey)
    if (sameKey) {
      return {
        outcome: 'duplicate',
        message: `补传命中幂等键，${sameKey.caseId} 仅保留首次入账结果（${sameKey.id} / ${sameKey.result}）`,
        recordId: sameKey.id,
      }
    }

    // 不能覆盖已审核的失败记录
    const reviewedFailure = this.executions.find((r) => r.caseId === draft.caseId && r.result === '失败' && r.reviewState === '已审核' && !r.stale)
    if (reviewedFailure) {
      this.pushConflict(terminalId, draft.caseId, undefined, `已审核失败记录 ${reviewedFailure.id} 受保护，禁止覆盖；请走缺陷闭环或申诉复核流程`)
      return { outcome: 'conflict', message: `已审核失败记录 ${reviewedFailure.id} 不可覆盖`, recordId: reviewedFailure.id }
    }

    // 补传同一用例快照只认首次结果：
    //  - 断网补传（replay）是同一现场工作的延迟送达，重复按幂等丢弃；
    //  - 两端并发的后到一方先判版本冲突，不落到这里。
    const snapshotId = draft.snapshotId ?? this.currentSnapshotId
    const snapshotKey = `${draft.caseId}@${snapshotId}`
    if (this.acceptedCaseSnapshotKeys.has(snapshotKey) && replay) {
      return {
        outcome: 'duplicate',
        message: `${draft.caseId} 在快照 ${snapshotId} 下已有首次结果，补传只认首次，该笔丢弃`,
      }
    }

    // 两端同时提交同一用例：后到一方 baseRevision 落后即版本冲突。
    // 断网补传（replay）按原顺序回放，是同一次现场工作的延迟送达，不判为并发冲突。
    if (draft.baseRevision !== testCase.revision && !replay) {
      this.pushConflict(terminalId, draft.caseId, undefined, `版本冲突：终端依据 r${draft.baseRevision}，服务端已到 r${testCase.revision}，拒绝覆盖`)
      return {
        outcome: 'conflict',
        message: `版本冲突：本地 r${draft.baseRevision} 落后于当前 r${testCase.revision}，请刷新后合并重提`,
      }
    }

    // 在线场景下列车已被同快照首条占用（并发双方 revision 相同、首条已入账）仍只认首次
    if (this.acceptedCaseSnapshotKeys.has(snapshotKey)) {
      this.pushConflict(terminalId, draft.caseId, undefined, `${draft.caseId} 在快照 ${snapshotId} 下已有首次结果`)
      return { outcome: 'duplicate', message: `同一用例快照 ${snapshotId} 只认首次结果，请用当前快照重测` }
    }

    this.counters.seq += 1
    // 基线锁定后新记录只进待复核，不改用例状态、不抬版本
    const reviewState: ReviewState = this.baseline ? '待复核' : '已审核'
    const record = this.makeRecord(draft, terminalId, this.counters.seq, idempotencyKey, snapshotId, reviewState)
    this.executions.push(record)
    this.acceptedCaseSnapshotKeys.add(snapshotKey)

    // 设备改动后补传的旧快照首条：入账留痕即失效，不改变当前用例状态
    if (snapshotId !== this.currentSnapshotId) {
      record.stale = true
      record.invalidatedBy = this.currentSnapshotId
      return { outcome: 'accepted', message: `已按原顺序补传入账 ${record.id}，但快照已过期，记录失效待按当前进路重测`, recordId: record.id }
    }

    if (this.baseline) {
      return {
        outcome: 'review-pending',
        message: `基线已锁定，${record.id} 只进待复核；报告仍引用锁定时的用例、进路和证据`,
        recordId: record.id,
      }
    }

    testCase.status = draft.result
    if (draft.actual) testCase.failureReason = draft.actual
    testCase.revision += 1
    return { outcome: 'accepted', message: `已按现场顺序入账：${record.id}（${draft.result}，r${testCase.revision}）`, recordId: record.id }
  }

  private enqueue(draft: ExecutionDraft, terminalId: string, idempotencyKey: string): SubmitResult {
    this.counters.enqueueSeq += 1
    const record = this.makeRecord(draft, terminalId, this.counters.enqueueSeq, idempotencyKey, draft.snapshotId ?? this.currentSnapshotId, '待复核')
    this.outbox.push({ enqueueSeq: this.counters.enqueueSeq, seq: record.seq, terminalId, record, state: '待补传' })
    return { outcome: 'queued', message: `断网暂存：${record.id} 已进入待补传队列第 ${this.counters.enqueueSeq} 位，恢复后按原顺序补传` }
  }

  /** 网络恢复：严格按入队顺序补传 */
  flushOutbox(): { sent: number; duplicate: number; conflict: number; messages: string[] } {
    const messages: string[] = []
    let sent = 0
    let duplicate = 0
    let conflict = 0
    for (const item of this.outbox.filter((q) => q.state === '待补传').sort((a, b) => a.enqueueSeq - b.enqueueSeq)) {
      const draft: ExecutionDraft = {
        caseId: item.record.caseId,
        operator: item.record.operator,
        result: item.record.result,
        evidence: item.record.evidence,
        baseRevision: item.record.baseRevision,
        snapshotId: item.record.snapshotId,
        startedAt: item.record.startedAt,
        finishedAt: item.record.finishedAt,
      }
      // 补传时复用原顺序号与记录编号语义：先移除暂存壳记录，由入账流程决定去留
      const result = this.submit(draft, item.terminalId, item.record.idempotencyKey, true)
      if (result.outcome === 'duplicate') { item.state = '重复'; duplicate += 1 }
      else if (result.outcome === 'conflict') { item.state = '冲突'; conflict += 1 }
      else {
        item.state = '已补传'
        item.note = result.recordId
        sent += 1
      }
      messages.push(`#${item.enqueueSeq} ${item.record.id} → ${item.state}：${result.message}`)
    }
    return { sent, duplicate, conflict, messages }
  }

  get pendingOutbox(): OutboxItem[] { return this.outbox.filter((q) => q.state === '待补传') }

  /**
   * 登记设备改动：
   * 1) 宣告新设备快照；2) 旧快照下的执行记录全部失效留痕；
   * 3) 按当前进路图重算受影响进路与用例范围。
   */
  registerDeviceChange(deviceId: string, description: string, operator: string): DeviceChange {
    const device = this.devices.find((d) => d.id === deviceId)
    if (!device) throw new Error(`未知设备 ${deviceId}`)

    // 按当前进路图重算：哪些进路包含该设备 → 哪些用例挂在这些进路上
    const routeIds = this.routes.filter((r) => r.devices.includes(deviceId)).map((r) => r.id)
    const caseIds = [...new Set(this.cases.filter((c) => c.routeIds.some((id) => routeIds.includes(id))).map((c) => c.id))]

    // 新快照：仅改动设备换指纹，其余沿用
    const previous = this.currentSnapshot
    const deviceHashes = { ...previous.deviceHashes, [deviceId]: `${deviceId}@cfg-${nowLabel().replace(/:/g, '')}` }
    const nextLeu = previous.leuVersion.replace(/-(\d+)$/, (_, n: string) => `-${String(Number(n) + 1).padStart(2, '0')}`)
    const snapshot = this.declareSnapshot(previous.softwareVersion, nextLeu, deviceHashes, operator, `设备改动 ${deviceId}`)

    // 旧快照（非当前）下的执行记录失效留痕；
    // 已审核失败记录是质量闭环证据，设备改动不消除其责任，继续受保护
    const invalidatedExecutionIds: string[] = []
    for (const record of this.executions) {
      const protectedFailure = record.result === '失败' && record.reviewState === '已审核'
      if (!record.stale && record.snapshotId !== snapshot.id && record.result !== '执行中' && !protectedFailure) {
        record.stale = true
        record.invalidatedBy = snapshot.id
        invalidatedExecutionIds.push(record.id)
      }
    }
    for (const item of this.outbox) {
      if (item.state === '待补传' && caseIds.includes(item.record.caseId)) {
        item.note = `补传将按新快照 ${snapshot.id} 重算有效性`
      }
    }

    // 用例回到待回归（进路范围内）
    for (const testCase of this.cases) {
      if (caseIds.includes(testCase.id)) {
        testCase.status = '执行中'
        testCase.revision += 1
        for (const step of testCase.steps) if (step.result !== '未执行') { step.result = '未执行'; step.actual = undefined }
      }
    }
    if (!this.routes.find((r) => r.id === routeIds[0])?.affectedBy.includes(description)) {
      for (const route of this.routes) if (routeIds.includes(route.id) && !route.affectedBy.includes(description)) route.affectedBy.push(description)
    }

    this.counters.changeSeq += 1
    const change: DeviceChange = {
      id: `CHG-${String(this.counters.changeSeq).padStart(2, '0')}`,
      deviceId,
      deviceName: device.name,
      description,
      changedAt: nowLabel(),
      routeIds,
      caseIds,
      invalidatedExecutionIds,
      snapshotId: snapshot.id,
    }
    this.changes.push(change)
    return change
  }

  /** 当前进路图推导的受影响用例 */
  affectedCaseIds(): string[] {
    const routeIds = new Set(this.changes.flatMap((c) => c.routeIds))
    return [...new Set(this.cases.filter((c) => c.routeIds.some((id) => routeIds.has(id))).map((c) => c.id))]
  }

  private pushConflict(terminalId: string, caseId: string, recordId: string | undefined, message: string) {
    this.conflicts.unshift({ at: nowLabel(), terminalId, caseId, recordId, message })
    if (this.conflicts.length > 30) this.conflicts.pop()
  }

  /** 锁定发布基线：冻结用例、进路和证据；之后新记录只进待复核 */
  lockBaseline(version: string): BaselineFrozen {
    const live = this.executions.filter((r) => !r.stale && r.reviewState === '已审核' && r.result !== '执行中')
    this.baseline = {
      version,
      lockedAt: nowLabel(),
      cases: structuredClone(this.cases),
      routes: structuredClone(this.routes),
      executions: structuredClone(live),
      evidence: live.map((r) => ({ caseId: r.caseId, recordId: r.id, snapshotId: r.snapshotId, evidenceHash: r.evidenceHash })),
    }
    return this.baseline
  }

  /** 报告永远引用锁定时的用例、进路和证据；未锁定时报告当前有效数据 */
  getReport(): { locked: boolean; version: string; cases: TestCase[]; routes: RouteRelation[]; executions: ExecutionRecord[]; lockedAt?: string; pendingReview: ExecutionRecord[] } {
    const pendingReview = this.executions.filter((r) => r.reviewState === '待复核' && !r.stale)
    if (this.baseline) {
      return {
        locked: true,
        version: this.baseline.version,
        lockedAt: this.baseline.lockedAt,
        cases: this.baseline.cases,
        routes: this.baseline.routes,
        executions: this.baseline.executions,
        pendingReview,
      }
    }
    return {
      locked: false,
      version: this.currentSnapshot.softwareVersion,
      cases: this.cases,
      routes: this.routes,
      executions: this.executions.filter((r) => !r.stale),
      pendingReview,
    }
  }

  toJSON(): EngineStateJSON {
    return {
      snapshots: this.snapshots,
      cases: this.cases,
      executions: this.executions,
      outbox: this.outbox,
      changes: this.changes,
      conflicts: this.conflicts,
      baseline: this.baseline,
      acceptedCaseSnapshotKeys: [...this.acceptedCaseSnapshotKeys].map((k) => [k]),
      counters: this.counters,
      currentSnapshotId: this.currentSnapshotId,
      online: this.online,
    }
  }

  static restore(json: EngineStateJSON, routes: RouteRelation[], devices: StationDevice[]): InterlockDataset {
    const dataset = new InterlockDataset([], routes, devices, [])
    dataset.snapshots = json.snapshots
    dataset.cases = json.cases
    dataset.executions = json.executions
    dataset.outbox = json.outbox
    dataset.changes = json.changes
    dataset.conflicts = json.conflicts
    dataset.baseline = json.baseline
    dataset.acceptedCaseSnapshotKeys = new Set(json.acceptedCaseSnapshotKeys.map((pair) => pair[0]!))
    dataset.counters = json.counters
    dataset.currentSnapshotId = json.currentSnapshotId
    dataset.online = json.online
    return dataset
  }
}

export function statusOf(testCase: TestCase, executions: ExecutionRecord[]): TestStatus {
  const latest = executions
    .filter((r) => r.caseId === testCase.id && !r.stale && r.reviewState === '已审核' && r.result !== '执行中')
    .sort((a, b) => b.seq - a.seq)[0]
  return latest?.result ?? testCase.status
}
