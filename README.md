# 芯片多工位测试记录的上下文接收

多工位封测资料接入。现有收件器读取最终器件摘要；网关另提供保持记录顺序的测试流投影，字段名与本服务合同一致。

## 运行

使用 Node.js 22，依赖由 package-lock.json 固定。安装后可执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
npm start
```

服务启动本地来源与收件接口，默认端口分别为4011和4010。`POST /collect` 领取当前单份摘要资料；`POST /ingest` 连续接收保序测试流并按真实器件生命周期归集。`GET /records`查看摘要记录，`GET /devices`查看已完结器件，`GET /pending`查看未结束与悬置器件，`GET /stream`查看流水位、批次上下文与异常，`GET /receipts`查看原文凭据，`GET /health`查看服务状态。`PORT`、`SOURCE_PORT`与`DATA_DIR`可分别设置端口和归档目录。示例领取不会自动遍历其他来源资料。

```sh
docker build -t multisite-testing .
docker run --rm --network none multisite-testing npm test
docker run --rm --network none multisite-testing npm run demo
docker run --rm -p 4010:4010 multisite-testing
```

## 资料组织

`provider/`是独立本地来源，`fixtures/`记录合成资料和来源阶段，`src/reader.mjs`负责现有单份摘要收件，`src/stream.mjs`负责连续测试流的上下文归约（纯函数、可序列化、可重放），`src/source.mjs`限定来源地址并记录响应字节，`src/archive.mjs`保存按摘要校验的原文、资料版本与流接收状态。`test/`覆盖现有收件、来源边界、原文完整性、连续接收生命周期和服务联通。运行不依赖外网、数据库服务或真实设备。

完整来源约定见 `docs/source-contract.md`。项目只访问本地合成资料，不携带真实身份、密钥或业务数据。

## 连续接收语义

器件按`(机头,工位)`槽位上的PART_START与PART_END配对，多机头多工位交错记录不会把相邻两条配成一颗芯片；流状态（水位、批次描述、在制与悬置器件、已完结器件、异常）随归档原子落盘，中断重开后续投不重复建件。`HEAD_END`/`LOT_END`不替任何工位伪造PART_END。测试描述以批次为作用域且允许晚到回填，同测试号跨批次可换单位与比例。`valid/executed/passed`三个来源标记原样保留，器件完整性（`lifecycle`）与测试通过率（`metrics.passRate`，仅统计已执行测试）分开表达。

## 快速查看

`npm run demo`启动实际来源和收件服务、执行一次当前收件并打印查询结果及凭据，临时归档在退出时清理。正常完成时间小于90秒；需要保留数据时用`npm start`及独立`DATA_DIR`。演示反映当前产品能力，不代表全部来源资料已被接纳。
