// 连续测试流的上下文归约器：按 (机头,工位) 槽位归集真实器件生命周期。
// 纯函数、无 I/O，状态可整体序列化进归档，重启后从断点继续。

export function initialStreamState() {
  return {
    stream: null,
    nextOffset: 0,
    currentLot: null,
    lots: {},        // 批次 -> {descriptions:{测试号:{unit,scale,offset}}, startedOffset, ended, endOffset}
    heads: {},       // 机头 -> {offset, lot}，仅记录机头停止
    open: {},        // 槽位 `${head}:${site}` -> 在制器件
    orphans: [],     // 槽位被新批次复用、且始终未收到 PART_END 的悬置器件
    devices: [],     // 已完结器件（PART_START 与 PART_END 配对成功）
    anomalies: []    // 来源记录违反生命周期约定时的可观测异常，不静默捏造
  };
}

const slotKey = (head, site) => `${head}:${site}`;
const pendingId = part => `pending:${part.lot}:${part.head}:${part.site}:${part.startedOffset}`;

function ensureLot(state, lot, offset) {
  if (!state.lots[lot]) {
    state.lots[lot] = {descriptions: {}, startedOffset: offset ?? null, ended: false, endOffset: null};
  }
  return state.lots[lot];
}

function pushAnomaly(state, offset, kind, detail) {
  state.anomalies.push({offset, kind, ...(detail === undefined ? {} : {detail})});
}

function assertFlags(flags, offset) {
  for (const name of ['valid', 'executed', 'passed']) {
    if (!flags || typeof flags[name] !== 'boolean') {
      throw new Error(`偏移${offset}的测试记录缺少独立布尔标记 ${name}`);
    }
  }
}

// 测试视图：DESCR 以批次为作用域，允许晚于测量值到达，缺失时保留 null 而不猜单位
function testViews(part, state) {
  const context = state.lots[part.lot];
  return part.tests.map(test => {
    const description = context?.descriptions[test.number];
    return {
      number: test.number,
      value: test.value,
      flags: {...test.flags},
      sourceOffset: test.offset,
      description: description
        ? {unit: description.unit, scale: description.scale, sourceOffset: description.offset}
        : null
    };
  });
}

// 通过率只在“已执行”测试内计算；无效值与未执行测试独立计数，不混成失败
export function computeMetrics(tests) {
  const total = tests.length;
  const executed = tests.filter(test => test.flags.executed).length;
  const passed = tests.filter(test => test.flags.executed && test.flags.passed).length;
  const failed = tests.filter(test => test.flags.executed && !test.flags.passed).length;
  const invalid = tests.filter(test => !test.flags.valid).length;
  const notExecuted = tests.filter(test => !test.flags.executed).length;
  return {
    total,
    executed,
    passed,
    failed,
    invalid,
    notExecuted,
    passRate: executed === 0 ? null : passed / executed
  };
}

function finalizeDevice(part, record, state) {
  const tests = testViews(part, state);
  const device = {
    kind: 'stream-device',
    id: `${part.lot}:${record.serial}`,
    lot: part.lot,
    serial: record.serial,
    head: part.head,
    site: part.site,
    lifecycle: 'complete',
    startedOffset: part.startedOffset,
    endedOffset: record.offset,
    tests,
    metrics: computeMetrics(tests)
  };
  if (state.devices.some(existing => existing.id === device.id)) {
    pushAnomaly(state, record.offset, 'duplicate-device-id', device.id);
  }
  state.devices.push(device);
}

export function reduceRecord(state, record) {
  if (!record || typeof record.offset !== 'number') throw new Error('流记录缺少有效 offset');
  // 重新投递：已处理过的偏移直接跳过，保证不重复生成器件
  if (record.offset < state.nextOffset) return state;
  // 缺偏移意味着来源数据有缺口，不能跳着拼接
  if (record.offset > state.nextOffset) {
    throw new Error(`流记录不连续：期望偏移 ${state.nextOffset}，收到 ${record.offset}`);
  }
  const offset = record.offset;
  switch (record.type) {
    case 'LOT': {
      if (typeof record.lot !== 'string' || !record.lot) {
        throw new Error(`偏移${offset}的批次记录缺少批次号`);
      }
      state.currentLot = record.lot;
      ensureLot(state, record.lot, offset);
      break;
    }
    case 'PART_START': {
      if (!state.currentLot) {
        pushAnomaly(state, offset, 'part-start-without-lot', {head: record.head, site: record.site});
        break;
      }
      const key = slotKey(record.head, record.site);
      const occupied = state.open[key];
      if (occupied) {
        // 新批次复用同一物理槽位：旧器件没有 PART_END，悬置保留，绝不替它捏造结束
        pushAnomaly(state, offset, 'part-slot-reused-before-end', {lot: occupied.lot, head: record.head, site: record.site});
        state.orphans.push({...occupied, suspendedOffset: offset});
      }
      state.open[key] = {
        lot: state.currentLot,
        head: record.head,
        site: record.site,
        startedOffset: offset,
        tests: []
      };
      break;
    }
    case 'TEST': {
      assertFlags(record.flags, offset);
      const part = state.open[slotKey(record.head, record.site)];
      if (!part) {
        pushAnomaly(state, offset, 'test-without-active-part', {head: record.head, site: record.site});
        break;
      }
      part.tests.push({
        offset,
        number: record.number,
        value: record.value ?? null,
        flags: {...record.flags}
      });
      break;
    }
    case 'DESCR': {
      const lot = record.lot ?? state.currentLot;
      if (!lot) {
        pushAnomaly(state, offset, 'descr-without-lot', {number: record.number});
        break;
      }
      const context = ensureLot(state, lot, offset);
      context.descriptions[record.number] = {unit: record.unit, scale: record.scale, offset};
      // 描述晚到：回填同批次已完结器件上仍缺描述的测量项
      for (const device of state.devices) {
        if (device.lot !== lot) continue;
        for (const test of device.tests) {
          if (test.number === record.number && test.description === null) {
            test.description = {unit: record.unit, scale: record.scale, sourceOffset: offset};
            device.metrics = computeMetrics(device.tests);
          }
        }
      }
      break;
    }
    case 'PART_END': {
      const key = slotKey(record.head, record.site);
      const part = state.open[key];
      if (!part) {
        pushAnomaly(state, offset, 'part-end-without-start', {head: record.head, site: record.site});
        break;
      }
      delete state.open[key];
      finalizeDevice(part, record, state);
      break;
    }
    case 'HEAD_END': {
      // 机头停止只登记事实，不关闭任何在制器件
      state.heads[record.head] = {offset, lot: state.currentLot ?? null};
      break;
    }
    case 'LOT_END': {
      const lot = record.lot ?? state.currentLot;
      if (!lot) {
        pushAnomaly(state, offset, 'lot-end-without-lot');
        break;
      }
      const context = ensureLot(state, lot, offset);
      context.ended = true;
      context.endOffset = offset;
      // 明确不补齐 PART_END：未结束器件继续留在 open/orphans 中
      break;
    }
    default:
      pushAnomaly(state, offset, 'unknown-record-type', String(record.type));
  }
  state.nextOffset = offset + 1;
  return state;
}

export function listPending(state) {
  const describe = (part, lifecycle) => {
    const tests = testViews(part, state);
    const head = state.heads[part.head];
    return {
      kind: 'stream-pending',
      id: pendingId(part),
      lifecycle,
      lot: part.lot,
      serial: null, // 序列号只随 PART_END 到来；未结束就是未知，不伪造
      head: part.head,
      site: part.site,
      startedOffset: part.startedOffset,
      ...(part.suspendedOffset === undefined ? {} : {suspendedOffset: part.suspendedOffset}),
      headStopped: Boolean(head),
      headEndOffset: head ? head.offset : null,
      lotEnded: state.lots[part.lot]?.ended ?? false,
      tests,
      metrics: computeMetrics(tests)
    };
  };
  return [
    ...state.orphans.map(part => describe(part, 'suspended')),
    ...Object.values(state.open).map(part => describe(part, 'open'))
  ];
}

export function streamStatus(state) {
  return {
    stream: state.stream,
    nextOffset: state.nextOffset,
    currentLot: state.currentLot,
    lots: state.lots,
    heads: state.heads,
    openCount: Object.keys(state.open).length,
    suspendedCount: state.orphans.length,
    completedCount: state.devices.length,
    anomalyCount: state.anomalies.length,
    anomalies: state.anomalies
  };
}

// 从持久化水位起逐页拉取；404 表示“暂时没有新数据”，是连续接收的正常停点
export async function ingestStream(client, state) {
  let fetchedPages = 0;
  let fetchedRecords = 0;
  const completedBefore = state.devices.length;
  for (;;) {
    let page;
    try {
      page = await client(`/records?offset=${state.nextOffset}`);
    } catch (error) {
      if (error.status === 404) break;
      throw error;
    }
    if (typeof page?.nextOffset !== 'number' || !Array.isArray(page.records)) {
      throw new Error('来源流响应结构无效');
    }
    if (state.stream === null) {
      state.stream = page.stream;
    } else if (page.stream !== state.stream) {
      throw new Error('流标识发生变化，拒绝拼接不同来源');
    }
    for (const record of page.records) reduceRecord(state, record);
    if (page.nextOffset !== state.nextOffset) {
      throw new Error(`流水位不一致：记录处理到 ${state.nextOffset}，来源声明 ${page.nextOffset}`);
    }
    if (page.records.length === 0) break;
    fetchedPages += 1;
    fetchedRecords += page.records.length;
  }
  return {
    stream: state.stream,
    fetchedPages,
    fetchedRecords,
    nextOffset: state.nextOffset,
    completed: state.devices.length - completedBefore,
    open: Object.keys(state.open).length,
    suspended: state.orphans.length,
    anomalies: state.anomalies.length
  };
}
