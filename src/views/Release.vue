<script setup lang="ts">
import { computed } from 'vue'
import { useTestStore } from '../store'

const store = useTestStore()
const report = computed(() => store.getReport())

function exportPackage() {
  const r = store.getReport()
  const payload = {
    station: '海州站 CS',
    version: r.version,
    locked: r.locked,
    lockedAt: r.lockedAt,
    snapshot: store.currentSnapshot.id,
    cases: r.cases.map((item) => ({ id: item.id, name: item.name, revision: item.revision, status: item.status, steps: item.steps.length, failureReason: item.failureReason })),
    routes: r.routes.map((route) => ({ id: route.id, name: route.name, devices: route.devices })),
    executions: r.executions.map((item) => ({ id: item.id, caseId: item.caseId, seq: item.seq, snapshot: item.snapshotLabel, result: item.result, evidenceHash: item.evidenceHash, reviewState: item.reviewState })),
    pendingReview: r.pendingReview.map((item) => ({ id: item.id, caseId: item.caseId, result: item.result })),
    note: r.locked ? '报告引用基线锁定时的用例、进路和证据；锁定后新记录只进待复核' : '报告反映当前有效数据（失效记录已剔除）',
    generatedAt: new Date().toISOString(),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `联锁测试报告-${r.version}${r.locked ? '-锁定' : ''}.json`; link.click(); URL.revokeObjectURL(link.href)
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">发布门禁与历史基线</p><h1>基线锁定与测试报告</h1><p>当前快照下每个用例都有已审核通过证据、发件箱清空后才能锁定；锁定后报告只读引用冻结点。</p></div><n-space><n-button @click="exportPackage">导出测试报告</n-button><n-button type="primary" :disabled="!store.gateReady" @click="store.lockBaseline()">锁定发布基线</n-button></n-space></section>
  <n-alert :type="store.gateReady ? 'success' : store.baselineLocked ? 'info' : 'error'" :title="store.baselineLocked ? `${store.baseline?.version} 基线已锁定` : store.gateReady ? '全部用例已通过，可锁定' : '发布门禁未通过'" :description="store.baselineLocked ? `锁定于 ${store.baseline?.lockedAt}，新记录只进待复核，不影响已锁定报告。` : store.gateReady ? '设备快照、执行证据和失败闭环均完整。' : '存在失败、阻塞、未执行步骤、失效记录或待补传提交，任何人员不得无痕跳过。'" style="margin-bottom:16px" />
  <div class="grid-2"><article class="card"><div class="panel-head"><div><h2>发布门禁清单</h2><p>按当前快照 {{store.currentSnapshot.id}} 的有效审核记录自动判断</p></div><n-tag :type="store.gateReady?'success':'error'">{{store.gateReady?'可发布':'阻断'}}</n-tag></div><div v-for="item in store.cases" :key="item.id" class="gate"><div><b>{{item.id}} · {{item.name}}</b><small>{{item.failureReason || (item.status==='通过'?'执行记录完整':'步骤未闭环 / 记录已失效需重测')}}</small></div><n-tag :type="item.status==='通过'?'success':item.status==='失败'?'error':'warning'">{{item.status}} · r{{item.revision}}</n-tag></div>
    <n-alert v-if="store.reviewQueue.length" type="warning" :title="`待复核 ${store.reviewQueue.length} 条`" description="基线锁定后或断网期间入账的记录，审核通过前不进入已锁定报告。" style="margin-top:12px" /></article>

    <article class="card"><div class="panel-head"><div><h2>差异与影响范围</h2><p>设备改动按当前进路图重算，旧执行记录失效留痕</p></div><n-tag>{{store.changes.length}} 次设备改动</n-tag></div>
      <div v-if="!store.changes.length" class="diff"><b>暂无设备改动登记</b><p>在「站场与进路」页对设备登记改动后，将自动宣告新快照、失效旧记录并重算受影响进路。</p></div>
      <div v-for="change in store.changes" :key="change.id" class="diff"><b>{{change.deviceId}} {{change.description}} · {{change.changedAt}}</b><p>快照 {{change.snapshotId}} · 影响进路 {{change.routeIds.join('、') || '无'}}；受影响用例 {{change.caseIds.join('、') || '无'}}；失效记录 {{change.invalidatedExecutionIds.length}} 条。</p></div>
      <n-divider /><h3>基线状态</h3><n-result :status="store.baselineLocked ? 'success' : 'info'" :title="store.baselineLocked ? `${store.baseline?.version} 已锁定` : '等待全部用例通过'" :description="store.baselineLocked ? `冻结 ${store.baseline?.executions.length} 条执行证据，报告只读引用锁定时的用例、进路和证据。` : '锁定后生成只读版本快照，之后新记录只进待复核。'" /></article></div>
</template>
