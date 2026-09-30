# 铁路信号联锁测试用例编排与回归记录平台

源提示词编号：14。包含道岔、信号机、轨道区段与进路关系，Canvas 站场缩放与定位，受设备变化影响的回归范围推导，用例步骤/预期/依赖编排，实时执行同步、断线重试、失败证据、基线锁定和测试报告导出。

## 技术栈

Vue 3、Naive UI、Pinia、Vue Router、TanStack Query、Axios、WebSocket 模拟、Canvas、Vite、TypeScript。

## 运行

```bash
npm install
npm run dev
```

开发地址：http://localhost:62057

```bash
npm run build
npm run verify   # 数据层六项语义的断言验证
```

## 现场数据语义（src/engine.ts）

站场设备快照、用例执行记录和发布基线接在同一份数据集 `InterlockDataset` 里：

1. **断网补传按原顺序**：断网期间提交进入 FIFO 发件箱（`outbox.enqueueSeq`），恢复后 `flushOutbox()` 严格按入队顺序补传。
2. **同快照只认首次**：以 `用例ID@快照ID` 为幂等键，补传重复按 `duplicate` 丢弃；客户端幂等键保证同一笔提交重传只入账一次。
3. **设备改动失效并重算**：`registerDeviceChange` 宣告新设备快照（LEU 版本 + 设备指纹），旧快照记录置 `stale` 留痕，并按当前进路图重算受影响进路/用例；旧快照补传入账即失效。已审核失败记录作为质量闭环证据跨快照继续受保护。
4. **并发版本冲突**：用例带乐观锁 `revision`，终端检出时绑定基准版本；后到一方基准落后即 `conflict`，拒绝覆盖；已审核失败记录任何情况下不可覆盖，需走缺陷闭环。
5. **基线锁定**：`lockBaseline` 冻结当时的用例、进路和证据哈希；之后新记录只进「待复核」，不改用例状态/版本；`getReport()` 永远引用冻结点，待复核单列。
