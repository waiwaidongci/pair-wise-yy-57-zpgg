<script setup lang="ts">
import { computed } from 'vue'
import { useTestStore } from '../store'

const store = useTestStore()
const ready = computed(() => store.cases.every((item) => item.status === '通过'))
const baseline = computed(() => store.dataset.baseline)

function exportPackage() {
  const report = store.buildReport()
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `联锁测试报告-${report.version}.json`
  link.click()
  URL.revokeObjectURL(link.href)
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">发布门禁与历史基线</p><h1>基线锁定与测试报告</h1><p>全部未通过、阻塞和证据缺失项闭环后才能锁定版本；锁定后新记录只进待复核，报告引用锁定时的用例、进路和证据。</p></div><n-space><n-button @click="exportPackage">导出测试报告</n-button><n-button type="primary" :disabled="!ready || store.baselineLocked" @click="store.lockBaseline">锁定发布基线</n-button></n-space></section>
  <n-alert :type="ready ? 'success' : 'error'" :title="ready ? '全部用例已通过，可锁定' : '发布门禁未通过'" :description="ready ? '设备快照、执行证据和失败闭环均完整。' : '存在失败、阻塞或未执行步骤，任何人员不得无痕跳过。'" style="margin-bottom:16px" />
  <div class="grid-2">
    <article class="card">
      <div class="panel-head"><div><h2>发布门禁清单</h2><p>自动判断，不允许人工绕过</p></div><n-tag :type="ready?'success':'error'">{{ready?'可发布':'阻断'}}</n-tag></div>
      <div v-for="item in store.cases" :key="item.id" class="gate"><div><b>{{item.id}} · {{item.name}}</b><small>{{item.failureReason || '执行记录完整'}}</small></div><n-tag :type="item.status==='通过'?'success':item.status==='失败'?'error':'warning'">{{item.status}}</n-tag></div>
    </article>
    <article class="card">
      <div class="panel-head"><div><h2>基线状态</h2><p>锁定后生成只读版本快照</p></div><n-result :status="store.baselineLocked ? 'success' : 'info'" :title="store.baselineLocked ? `v${baseline.version} 已锁定` : '等待全部用例通过'" :description="store.baselineLocked ? `锁定于 ${baseline.lockedAt}，报告引用锁定时快照。` : '锁定后固化用例、进路与证据。'" /></div>
      <n-divider />
      <h3>锁定快照内容</h3>
      <div v-if="store.baselineLocked && baseline.snapshot" class="diff">
        <b>用例 {{baseline.snapshot.cases.length}} 条 · 进路 {{baseline.snapshot.routes.length}} 条 · 设备 {{baseline.snapshot.devices.length}} 台</b>
        <p>证据 {{baseline.snapshot.evidence.length}} 项：{{baseline.snapshot.evidence.join('、') || '无'}}</p>
      </div>
      <n-alert v-else type="info" title="基线未锁定" description="锁定后此处展示固化的用例、进路与证据快照。" />
      <n-divider />
      <h3>待复核记录</h3>
      <n-tag :type="store.pendingReviewCount ? 'warning' : 'default'">{{store.pendingReviewCount}} 条</n-tag>
      <p style="color:#7a8798;font-size:13px;margin-top:8px">基线锁定后新提交的执行记录只进待复核，不覆盖已审核结果。</p>
    </article>
  </div>
  <div class="grid-2" style="margin-top:16px">
    <article class="card">
      <div class="panel-head"><div><h2>差异与影响范围</h2><p>v26.09 → v26.10 · 按当前进路重算</p></div><n-tag type="warning">{{store.affectedCases.length}} 条用例受影响</n-tag></div>
      <div v-for="change in store.changedDevices" :key="change" class="change"><n-tag type="error">设备变更</n-tag><div><b>{{change}}</b><small>影响 {{store.affectedCases.length}} 条用例 · 旧执行记录已标记失效</small></div></div>
      <n-alert type="warning" title="回归范围不能缩减" description="P-02 与 T-03 变更具有跨进路影响，只有版本控制负责人可审批范围例外。" />
    </article>
    <article class="card">
      <div class="panel-head"><div><h2>受影响用例（按当前进路）</h2><p>设备改动自动重算</p></div></div>
      <div v-for="item in store.affectedCases" :key="item.id" class="case-row"><div><b>{{item.id}} · {{item.name}}</b><small>关联 {{item.routeIds.join(' / ')}}</small></div><n-tag :type="item.status==='通过'?'success':item.status==='失败'?'error':item.status==='阻塞'?'warning':'info'">{{item.status}}</n-tag></div>
    </article>
  </div>
</template>
