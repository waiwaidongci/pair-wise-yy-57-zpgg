<script setup lang="ts">
import { ref } from 'vue'
import { useTestStore } from '../store'

const store = useTestStore()

const failureReason = ref('模拟 3G 占用后，S2 信号未立即关闭，联锁日志出现 126ms 延迟')
const evidence = ref('录屏 VID-021、联锁日志 LG-144、CS-LEU-09 设备快照')

function failStep() {
  const item = store.selectedCase
  const step = item?.steps.find((entry) => entry.result === '未执行')
  if (item && step && failureReason.value.trim()) store.setStepResult(item.id, step.id, '失败', failureReason.value)
}
function passStep() {
  const item = store.selectedCase
  const step = item?.steps.find((entry) => entry.result === '未执行')
  if (item && step) store.setStepResult(item.id, step.id, '通过', '预期结果一致，证据已归档')
}
function simulateDisconnect() { store.simulateDisconnect() }
function concurrentSubmit() { store.simulateConcurrentSubmit() }
function exportReport() {
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
  <section class="page-head"><div><p class="eyebrow">实时执行与证据</p><h1>回归执行记录</h1><p>每次执行关联设备快照、证据附件和失败原因；断网恢复后按原顺序补传，未通过用例不能无痕跳过。</p></div><n-space><n-button @click="simulateDisconnect">模拟断线</n-button><n-button @click="concurrentSubmit">模拟两终端同时提交</n-button><n-button type="success" @click="passStep">记录通过</n-button><n-button type="error" @click="failStep">记录失败</n-button></n-space></section>

  <div class="execution-grid">
    <article class="card">
      <div class="panel-head"><div><h2>{{store.selectedCase?.id}} 执行面板</h2><p>{{store.selectedCase?.name}}</p></div><n-tag :type="store.connection==='在线'?'success':'warning'">{{store.connection}} · {{store.liveMessage}}</n-tag></div>
      <n-progress type="line" :percentage="store.progress" :height="12" />
      <div v-for="step in store.selectedCase?.steps" :key="step.id" class="execute-step" :class="step.result"><div><b>{{step.id}} · {{step.action}}</b><small>预期：{{step.expected}}</small><small v-if="step.actual">实测：{{step.actual}}</small></div><n-tag :type="step.result==='通过'?'success':step.result==='失败'?'error':'info'">{{step.result}}</n-tag></div>
      <n-form label-placement="top"><n-form-item label="失败原因与设备快照"><n-input v-model:value="failureReason" type="textarea" :rows="3" /></n-form-item><n-form-item label="证据附件"><n-input v-model:value="evidence" /></n-form-item></n-form>
    </article>

    <aside class="card">
      <div class="panel-head"><div><h2>补传队列</h2><p>断网期间暂存，恢复后按原顺序上传</p></div><n-tag :type="store.pendingUploads.length ? 'warning' : 'default'">{{store.pendingUploads.length}} 项</n-tag></div>
      <n-timeline v-if="store.pendingUploads.length"><n-timeline-item v-for="item in store.pendingUploads" :key="item.seq" type="warning" :title="`#${item.seq} · ${item.terminal} · ${item.caseId}`" :content="`${item.result} · ${item.operator}\n${item.snapshot}`" /></n-timeline>
      <n-alert v-else type="success" title="无待补传记录" description="所有执行记录已同步。" />
      <n-button v-if="store.pendingUploads.length" block type="warning" style="margin-top:10px" @click="store.retry">恢复网络并按序补传</n-button>
    </aside>
  </div>

  <div class="execution-grid" style="margin-top:16px">
    <article class="card">
      <div class="panel-head"><div><h2>执行历史</h2><p>失败与重测记录不可覆盖 · 同一快照只认首次结果</p></div><n-tag>{{store.dataset.executions.length}} 条 · 待复核 {{store.pendingReviewCount}} · 已失效 {{store.invalidCount}}</n-tag></div>
      <n-timeline><n-timeline-item v-for="record in store.dataset.executions" :key="record.id" :type="record.result==='通过'?'success':record.result==='失败'?'error':record.result==='执行中'?'info':'warning'" :title="`${record.caseId} · ${record.result} · ${record.terminal}`" :content="`${record.operator} ${record.startedAt}${record.finishedAt ? ' → '+record.finishedAt : ''}\n${record.snapshot}\n证据：${record.evidence.join('、') || '采集中'}`"><template #header><n-tag size="small" :type="record.reviewState==='已审核'?'success':'warning'" style="margin-right:6px">{{record.reviewState}}</n-tag><n-tag size="small" :type="record.validity==='有效'?'success':'default'">{{record.validity}}</n-tag></template></n-timeline-item></n-timeline>
      <n-button block @click="exportReport">导出执行报告</n-button>
    </article>

    <aside class="card">
      <div class="panel-head"><div><h2>版本冲突</h2><p>后到的一方看到版本冲突，已审核失败不可覆盖</p></div><n-tag :type="store.conflicts.length ? 'error' : 'default'">{{store.conflicts.length}} 条</n-tag></div>
      <n-alert v-for="(message, index) in store.conflicts" :key="index" type="error" :title="message" style="margin-bottom:8px" />
      <n-alert v-if="!store.conflicts.length" type="info" title="暂无冲突" description="两个终端同时提交同一用例时，后到的一方将在此看到版本冲突。" />
    </aside>
  </div>
</template>
