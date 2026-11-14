# 来源资料约定

多工位封测资料接入。现有收件器读取最终器件摘要；网关另提供保持记录顺序的测试流投影，字段名与本服务合同一致。

## 交互与身份

GET /summary 返回已完结器件；GET /records?offset=0 返回stream、nextOffset及records。record有offset/type/head/site；LOT开始批次，PART_START开启该工位器件，TEST含number/value/flags，DESCR含number/unit/scale并以lot为作用域，PART_END含serial。flags是valid/executed/passed三个独立布尔值。HEAD_END只表示机头停止，LOT_END不补齐PART_END。读取可重叠，nextOffset不是器件完成水位。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：interrupted、new-lot。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。

## 已有收件边界

当前`src/reader.mjs`只收取/summary提供的已整理资料。归档按资料标识和内容摘要区分版本，原文按响应字节摘要独立存储，打开归档时逐份校验。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。
