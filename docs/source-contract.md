# 来源资料约定

多工位封测资料接入。现有收件器读取最终器件摘要；网关另提供保持记录顺序的测试流投影，字段名与本服务合同一致。

## 交互与身份

GET /summary 返回已完结器件；GET /records?offset=0 返回stream、nextOffset及records。record有offset/type/head/site；LOT开始批次，PART_START开启该工位器件，TEST含number/value/flags，DESCR含number/unit/scale并以lot为作用域，PART_END含serial。flags是valid/executed/passed三个独立布尔值。HEAD_END只表示机头停止，LOT_END不补齐PART_END。读取可重叠，nextOffset不是器件完成水位。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：interrupted、new-lot。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。

## 已有收件边界

当前`src/reader.mjs`只收取/summary提供的已整理资料。归档按资料标识和内容摘要区分版本，原文按响应字节摘要独立存储，打开归档时逐份校验。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。

## 连续接收边界

`src/stream.mjs`按本页记录顺序消费/records投影，状态整体持久化在归档索引的`stream`字段中，重启从`nextOffset`继续。器件以`(机头,工位)`槽位上的PART_START/PART_END配对归集，交错工位不会被相邻记录错配；序列号只在PART_END取得，器件标识为`批次:序列号`。TEST先于DESCR到达时保留测量值与来源偏移，DESCR按批次作用域到达后回填，包括已完结器件；同一测试号在新批次可换单位和比例，两套描述互不串用。

`HEAD_END`只登记机头停止，`LOT_END`只标记批次结束，二者都不补齐PART_END：未结束器件保留在未决视图中（`open`），若其物理槽位被新批次PART_START复用则转入`suspended`并记录`part-slot-reused-before-end`异常，任何情况下都不伪造序列号或结束偏移。偏移已处理的重放记录直接跳过，重复PART_END、无开工的TEST/结束、缺批次等情况进入`anomalies`而不静默造数；出现偏移缺口或流标识变化则拒绝拼接并报错。

测试的`valid/executed/passed`三个布尔位原样保留。器件完整性由`lifecycle`（`complete`/`open`/`suspended`）表达，与测试通过率分开：`metrics.passRate`只在已执行测试内计算（通过数/已执行数），无已执行测试时为`null`；`failed`、`invalid`、`notExecuted`分别计数，无效值和未执行测试不计入失败。失败位是已执行但`passed=false`，不会被未执行测试稀释。

