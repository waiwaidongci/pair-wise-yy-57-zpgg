<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTestStore, type TerminalId } from '../store'

const store = useTestStore()
const failureReason = ref('模拟 3G 占用后，S2 信号未立即关闭，联锁日志出现 126ms 延迟')
const evidence = ref('录屏 VID-021、联锁日志 LG-144、CS-LEU-09 设备快照')

const willConflict = computed(() => store.isStaleCheckout(store.activeTerminal, store.selectedCaseId))

function failStep() {
  if (!failureReason.value.trim()) { store.liveMessage = '失败必须填写原因与证据'; return }
  store.submitExecution('失败', failureReason.value, evidence.value)
}
function passStep() {
  store.submitExecution('通过', '预期结果一致，证据已归档', evidence.value)
}
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">实时执行与证据</p><h1>回归执行记录</h1><p>每次执行关联设备快照、证据指纹与失败原因；断网先入队、恢复按原顺序补传，同快照只认首次结果。</p></div>
    <n-space>
      <n-select :value="store.activeTerminal" :options="store.terminals.map((t) => ({ label:t, value:t }))" style="width:200px" @update:value="(v: TerminalId) => { store.activeTerminal = v }" />
      <n-button v-if="store.connection === '在线'" @click="store.simulateDisconnect">模拟断线</n-button>
      <n-button v-else type="warning" @click="store.retry">网络恢复 · 立即补传 {{ store.pendingRetry }} 笔</n-button>
      <n-button @click="store.pullLatest">刷新版本 r{{ store.selectedCase?.revision }}</n-button>
      <n-button type="success" @click="passStep">提交通过</n-button>
      <n-button type="error" @click="failStep">提交失败</n-button>
    </n-space></section>

  <n-alert v-if="store.baselineLocked" type="info" title="发布基线已锁定" description="新提交只进待复核队列，不改动用例状态；测试报告仍引用锁定时的用例、进路和证据。" style="margin-bottom:16px" />
  <n-alert v-for="item in store.conflicts.slice(0,2)" :key="item.at + item.message" type="error" :title="`版本冲突 / ${item.terminalId} · ${item.caseId} @ ${item.at}`" :description="item.message" style="margin-bottom:12px" />

  <div class="execution-grid"><article class="card"><div class="panel-head"><div><h2>{{store.selectedCase?.id}} 执行面板</h2><p>{{store.selectedCase?.name}} · 当前快照 {{store.currentSnapshot.id}}（{{store.currentSnapshot.softwareVersion}} / {{store.currentSnapshot.leuVersion}}）</p></div><n-tag :type="store.connection==='在线'?'success':'warning'">{{store.connection}} · r{{store.selectedCase?.revision}}</n-tag></div><n-progress type="line" :percentage="store.progress" :height="12" /><div v-for="step in store.selectedCase?.steps" :key="step.id" class="execute-step" :class="step.result"><div><b>{{step.id}} · {{step.action}}</b><small>预期：{{step.expected}}</small><small v-if="step.actual">实测：{{step.actual}}</small></div><n-tag :type="step.result==='通过'?'success':step.result==='失败'?'error':'info'">{{step.result}}</n-tag></div>
    <n-alert v-if="willConflict" type="warning" title="本地检出版本可能落后" description="另一终端已提交同一用例，直接提交会收到版本冲突，请先刷新版本合并结果。" style="margin:12px 0" />
    <n-form label-placement="top"><n-form-item label="失败原因与设备快照"><n-input v-model:value="failureReason" type="textarea" :rows="3" /></n-form-item><n-form-item label="证据附件（、分隔，提交后生成证据指纹）"><n-input v-model:value="evidence" /></n-form-item></n-form></article>

    <aside class="card"><div class="panel-head"><div><h2>执行历史</h2><p>失败与重测记录不可覆盖 · #现场顺序</p></div><n-tag>{{ store.executions.length }} 条</n-tag></div>
      <div v-if="store.pendingRetry" class="outbox"><b>待补传队列（恢复后按原顺序）</b><div v-for="q in store.outbox.filter((x)=>x.state==='待补传')" :key="q.enqueueSeq" class="outbox-row"><n-tag size="small" type="warning">#{{q.enqueueSeq}}</n-tag><span>{{q.record.caseId}} · {{q.record.result}} · {{q.terminalId.split(' ')[0]}}</span></div></div>
      <n-timeline><n-timeline-item v-for="record in store.executions" :key="record.id" :type="record.result==='通过'?'success':record.result==='失败'?'error':'info'" :title="`#${record.seq} ${record.caseId} · ${record.result}`">
        <template #default>
          <div>{{record.operator}} · {{record.terminalId}} · r{{record.baseRevision}}</div>
          <div>{{record.startedAt}}{{record.finishedAt ? ' → '+record.finishedAt : ''}} · {{record.snapshotLabel}}</div>
          <div>证据：{{record.evidence.join('、') || '采集中'}}（{{record.evidenceHash}}）</div>
          <n-space style="margin-top:4px">
            <n-tag size="small" :type="record.reviewState==='已审核'?'success':record.reviewState==='已驳回'?'error':'warning'">{{record.reviewState}}</n-tag>
            <n-tag v-if="record.stale" size="small" type="default">已失效（设备改动 {{record.invalidatedBy}}）</n-tag>
          </n-space>
        </template>
      </n-timeline-item></n-timeline>
      <div v-if="store.reviewQueue.length" class="outbox"><b>待复核（{{store.reviewQueue.length}}）</b><small>基线锁定或断网期间入账，审核前不进报告</small></div>
    </aside></div>
</template>
