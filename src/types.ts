export type TestStatus = '未执行' | '执行中' | '通过' | '失败' | '阻塞'
export type ReviewState = '待复核' | '已审核' | '已驳回'
export type OutboxState = '待补传' | '已补传' | '重复' | '冲突'
export type SubmitOutcome = 'accepted' | 'queued' | 'duplicate' | 'conflict' | 'review-pending'

export interface StationDevice {
  id: string
  name: string
  kind: '道岔' | '信号机' | '轨道区段'
  x: number
  y: number
  routeIds: string[]
}

export interface RouteRelation {
  id: string
  name: string
  color: string
  points: [number, number][]
  devices: string[]
  affectedBy: string[]
}

export interface TestStep {
  id: string
  action: string
  expected: string
  dependency?: string
  result: '未执行' | '通过' | '失败'
  actual?: string
  evidence?: string
}

export interface TestCase {
  id: string
  name: string
  routeIds: string[]
  precondition: string
  version: string
  /** 乐观锁版本：每次入账 +1，并发提交时后到一方据此识别冲突 */
  revision: number
  status: TestStatus
  steps: TestStep[]
  failureReason?: string
}

/** 站场设备快照：联锁/LEU 版本 + 每台设备配置指纹 */
export interface DeviceSnapshot {
  id: string
  softwareVersion: string
  leuVersion: string
  deviceHashes: Record<string, string>
  capturedAt: string
  capturedBy: string
}

/** 现场终端产生的执行记录草稿（断网时先落本地发件箱） */
export interface ExecutionDraft {
  caseId: string
  operator: string
  result: TestStatus
  evidence: string[]
  actual?: string
  baseRevision: number
  snapshotId?: string
  startedAt?: string
  finishedAt?: string
}

export interface ExecutionRecord {
  id: string
  caseId: string
  operator: string
  terminalId: string
  /** 现场顺序号：断网补传严格按此（入队顺序）回放 */
  seq: number
  snapshotId: string
  snapshotLabel: string
  /** 提交时所依据的用例 revision，用于两端并发版本冲突判定 */
  baseRevision: number
  startedAt: string
  finishedAt?: string
  result: TestStatus
  evidence: string[]
  evidenceHash: string
  reviewState: ReviewState
  /** 设备改动后旧记录失效（保留留痕，不参与门禁与报告） */
  stale: boolean
  invalidatedBy?: string
  /** 客户端幂等键：同一笔提交补传多次只入账一次 */
  idempotencyKey: string
}

export interface OutboxItem {
  /** 全局入队顺序，恢复后按原顺序补传 */
  enqueueSeq: number
  seq: number
  terminalId: string
  record: ExecutionRecord
  state: OutboxState
  note?: string
}

export interface DeviceChange {
  id: string
  deviceId: string
  deviceName: string
  description: string
  changedAt: string
  /** 按当前进路图重算出的受影响进路 */
  routeIds: string[]
  /** 受影响用例（进路推导） */
  caseIds: string[]
  /** 本次改动宣告失效的旧执行记录 */
  invalidatedExecutionIds: string[]
  snapshotId: string
}

export interface ConflictEvent {
  at: string
  terminalId: string
  caseId: string
  recordId?: string
  message: string
}

/** 基线锁定时的不可变冻结点：报告永远引用这里的用例、进路和证据 */
export interface BaselineFrozen {
  version: string
  lockedAt: string
  cases: TestCase[]
  routes: RouteRelation[]
  executions: ExecutionRecord[]
  evidence: { caseId: string; recordId: string; snapshotId: string; evidenceHash: string }[]
}

export interface SubmitResult {
  outcome: SubmitOutcome
  message: string
  recordId?: string
}
