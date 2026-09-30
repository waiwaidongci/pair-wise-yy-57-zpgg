export type TestStatus = '未执行' | '执行中' | '通过' | '失败' | '阻塞'
export type ConnectionState = '在线' | '重连中'
export type ReviewState = '待复核' | '已审核'
export type Validity = '有效' | '已失效'

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
  status: TestStatus
  steps: TestStep[]
  failureReason?: string
}

export interface ExecutionRecord {
  id: string
  caseId: string
  operator: string
  startedAt: string
  finishedAt?: string
  snapshot: string
  result: TestStatus
  evidence: string[]
  /** 审核状态：基线锁定后新记录只进待复核 */
  reviewState: ReviewState
  /** 效力：设备改动后旧执行记录失效 */
  validity: Validity
  /** 乐观并发版本 */
  version: number
  /** 提交终端 */
  terminal: string
  /** 补传序号：断网恢复后按原顺序补传 */
  seq: number
}

/** 站场设备快照：某一版本下的设备与进路关系 */
export interface StationSnapshot {
  version: string
  capturedAt: string
  devices: StationDevice[]
  routes: RouteRelation[]
}

/** 待补传队列项：断网期间暂存，恢复后按 seq 原顺序补传 */
export interface PendingUpload {
  seq: number
  terminal: string
  caseId: string
  result: TestStatus
  evidence: string[]
  operator: string
  startedAt: string
  baseVersion: number
  snapshot: string
  enqueuedAt: string
}

/** 发布基线快照：锁定时固化用例、进路与证据，报告只引用该快照 */
export interface BaselineStepSnapshot {
  id: string
  action: string
  expected: string
  result: TestStep['result']
  actual?: string
  evidence?: string
}

export interface BaselineCaseSnapshot {
  id: string
  name: string
  status: TestStatus
  version: string
  routeIds: string[]
  precondition: string
  failureReason?: string
  steps: BaselineStepSnapshot[]
}

export interface BaselineSnapshot {
  version: string
  lockedAt: string
  operator: string
  cases: BaselineCaseSnapshot[]
  routes: RouteRelation[]
  devices: StationDevice[]
  evidence: string[]
}

export interface ReleaseBaseline {
  locked: boolean
  version: string
  lockedAt?: string
  snapshot?: BaselineSnapshot
}

/** 统一数据集：站场设备快照 + 用例执行记录 + 发布基线接到一份数据里 */
export interface Dataset {
  snapshot: StationSnapshot
  executions: ExecutionRecord[]
  baseline: ReleaseBaseline
  /** 用例执行版本计数（乐观并发） */
  caseVersions: Record<string, number>
}
