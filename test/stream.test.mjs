import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource} from '../provider/server.mjs';
import {createClient} from '../src/source.mjs';
import {openArchive} from '../src/archive.mjs';
import {startIntake} from '../src/app.mjs';
import {
  initialStreamState, reduceRecord, ingestStream, listPending, streamStatus, computeMetrics
} from '../src/stream.mjs';

const lot = (offset, name) => ({offset, type: 'LOT', lot: name});
const start = (offset, head, site) => ({offset, type: 'PART_START', head, site});
const testRec = (offset, head, site, number, value, flags) => ({offset, type: 'TEST', head, site, number, value, flags});
const descr = (offset, lotName, number, unit, scale) => ({offset, type: 'DESCR', lot: lotName, number, unit, scale});
const end = (offset, head, site, serial) => ({offset, type: 'PART_END', head, site, serial});
const headEnd = (offset, head) => ({offset, type: 'HEAD_END', head});
const lotEnd = (offset, lotName) => ({offset, type: 'LOT_END', lot: lotName});

const PASSED = {valid: true, executed: true, passed: true};
const FAILED = {valid: true, executed: true, passed: false};
const INVALID = {valid: false, executed: true, passed: false};
const SKIPPED = {valid: false, executed: false, passed: false};

test('按真实生命周期归集：交错的两个工位不会被相邻记录错配成一颗芯片', () => {
  const state = initialStreamState();
  [
    lot(0, 'L1'),
    start(1, 1, 1),                 // 器件A 开工（工位1）
    start(2, 1, 2),                 // 器件B 开工（工位2），与 A 交错
    testRec(3, 1, 2, 9, 12, FAILED),
    end(4, 1, 1, 'chip1'),          // 先结束的是工位1的 A
    descr(5, 'L1', 9, 'V', -3),     // 描述晚于测量值
    end(6, 1, 2, 'chip2')           // B 随后才结束
  ].forEach(record => reduceRecord(state, record));

  assert.equal(state.devices.length, 2);
  const [a, b] = state.devices;
  assert.equal(a.id, 'L1:chip1');
  assert.equal(a.head, 1); assert.equal(a.site, 1);
  assert.deepEqual(a.tests, []);
  assert.equal(b.id, 'L1:chip2');
  assert.equal(b.site, 2);
  assert.equal(b.tests.length, 1);
  assert.equal(b.tests[0].value, 12);
  // 描述晚到后按批次作用域回填到正确器件的正确测试号
  assert.deepEqual(b.tests[0].description, {unit: 'V', scale: -3, sourceOffset: 5});
  assert.equal(streamStatus(state).openCount, 0);
});

test('失败位、无效值、未执行测试保留来源状态，且完整性与通过率分开', () => {
  const state = initialStreamState();
  [
    lot(0, 'L1'), start(1, 2, 1),
    testRec(2, 2, 1, 1, 5, PASSED),
    testRec(3, 2, 1, 2, 0, FAILED),   // 真实失败位
    testRec(4, 2, 1, 3, null, INVALID),
    testRec(5, 2, 1, 4, null, SKIPPED),
    end(6, 2, 1, 'chipX')
  ].forEach(record => reduceRecord(state, record));

  const device = state.devices[0];
  assert.equal(device.lifecycle, 'complete');          // 器件完整：PART_START/PART_END 齐全
  const flags = device.tests.map(t => t.flags);
  assert.deepEqual(flags, [PASSED, FAILED, INVALID, SKIPPED]);
  assert.equal(device.tests[3].value, null);
  assert.deepEqual(device.metrics, {
    total: 4, executed: 3, passed: 1, failed: 2, invalid: 2, notExecuted: 1, passRate: 1 / 3
  });
  assert.notEqual(device.metrics.failed, device.metrics.notExecuted);
});

test('HEAD_END 与 LOT_END 都不替工位伪造 PART_END，未结束器件继续悬置并保留上下文', () => {
  const state = initialStreamState();
  [
    lot(0, 'L1'),
    start(1, 1, 1),
    testRec(2, 1, 1, 7, 9, PASSED),
    start(3, 1, 2),
    headEnd(4, 1),
    lotEnd(5, 'L1')
  ].forEach(record => reduceRecord(state, record));

  assert.equal(state.devices.length, 0);
  assert.equal(streamStatus(state).openCount, 2);
  const pending = listPending(state);
  assert.equal(pending.length, 2);
  for (const part of pending) {
    assert.equal(part.lifecycle, 'open');
    assert.equal(part.serial, null);
    assert.equal(part.headStopped, true);
    assert.equal(part.headEndOffset, 4);
    assert.equal(part.lotEnded, true);
  }
  const withTest = pending.find(p => p.site === 1);
  assert.equal(withTest.tests.length, 1);
  assert.equal(withTest.tests[0].number, 7);
});

test('新批次复用槽位时旧器件转入悬置而非被结束，同测试号的新单位按批次生效', () => {
  const state = initialStreamState();
  [
    lot(0, 'L1'), start(1, 1, 2), testRec(2, 1, 2, 9, 12, FAILED),
    lotEnd(3, 'L1'),
    lot(4, 'L2'),
    descr(5, 'L2', 9, 'A', 0),          // 同一测试号 9 在新批次换单位与比例
    start(6, 1, 2),                      // 物理槽位被新批次复用
    testRec(7, 1, 2, 9, null, SKIPPED)
  ].forEach(record => reduceRecord(state, record));

  assert.equal(state.devices.length, 0);
  const pending = listPending(state);
  assert.equal(pending.length, 2);
  const old = pending.find(p => p.lot === 'L1');
  assert.equal(old.lifecycle, 'suspended');
  assert.equal(old.suspendedOffset, 6);
  const fresh = pending.find(p => p.lot === 'L2');
  assert.equal(fresh.lifecycle, 'open');
  assert.equal(fresh.tests[0].description.unit, 'A');
  assert.equal(fresh.tests[0].description.scale, 0);
  assert.equal(state.anomalies[0].kind, 'part-slot-reused-before-end');
  assert.equal(state.lots.L1.descriptions[9], undefined);
});

test('重新投递已处理偏移不重复建件；缺偏移的数据缺口直接拒绝', () => {
  const state = initialStreamState();
  const replay = [lot(0, 'L1'), start(1, 1, 1), end(2, 1, 1, 'c1')];
  replay.forEach(record => reduceRecord(state, record));
  replay.forEach(record => reduceRecord(state, record));   // 整段重放
  reduceRecord(state, end(2, 1, 1, 'c1'));
  assert.equal(state.devices.length, 1);
  assert.equal(state.nextOffset, 3);
  assert.throws(() => reduceRecord(state, end(5, 1, 1, 'c2')), /不连续/);
});

test('无已执行测试时通过率为 null，不伪造成 0 或 100%', () => {
  assert.deepEqual(computeMetrics([]), {total: 0, executed: 0, passed: 0, failed: 0, invalid: 0, notExecuted: 0, passRate: null});
});

test('TEST 缺少独立布尔标记时拒绝归约', () => {
  const state = initialStreamState();
  reduceRecord(state, lot(0, 'L1'));
  reduceRecord(state, start(1, 1, 1));
  assert.throws(
    () => reduceRecord(state, testRec(2, 1, 1, 1, 1, {valid: true, executed: true})),
    /布尔标记 passed/
  );
});

async function environment(run) {
  const directory = await mkdtemp(join(tmpdir(), 'stream-test-'));
  const source = await startSource();
  try { await run({directory, source}); }
  finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
}

test('正常来源整段连续接收：完结器件与原始摘要并存，原文凭据逐份留存', () => environment(async ({directory, source}) => {
  const intake = await startIntake({origin: source.origin, directory});
  try {
    const first = await (await fetch(intake.origin + '/ingest', {method: 'POST'})).json();
    assert.equal(first.fetchedRecords, 8);
    assert.equal(first.committed, true);
    assert.equal(first.completed, 2);
    assert.equal(first.open, 0);
    assert.equal(first.suspended, 0);
    assert.equal(first.nextOffset, 8);
    assert.equal(first.receipt.devices, 2);

    const devices = await (await fetch(intake.origin + '/devices')).json();
    assert.deepEqual(devices.map(d => d.id).sort(), ['L1:chip1', 'L1:chip2']);
    const chip2 = devices.find(d => d.serial === 'chip2');
    assert.deepEqual(chip2.tests[0].description, {unit: 'V', scale: -3, sourceOffset: 5});
    assert.equal(chip2.metrics.failed, 1);
    assert.equal(chip2.metrics.executed, 1);
    assert.equal(chip2.lifecycle, 'complete');

    const status = await (await fetch(intake.origin + '/stream')).json();
    assert.equal(status.stream, 's1');
    assert.equal(status.completedCount, 2);
    assert.equal(status.anomalyCount, 0);

    // 原有 /summary 成品收件能力不受影响
    assert.ok((await (await fetch(intake.origin + '/collect', {method: 'POST'})).json()).records >= 1);
    const receipts = await (await fetch(intake.origin + '/receipts')).json();
    assert.ok(receipts.some(r => r.url.includes('/records?offset=0')));
    assert.ok(receipts.some(r => r.url.includes('/summary')));
  } finally { await intake.close(); }
}));

test('重复投递在水位处停住，不重新拉取也不多生成器件', () => environment(async ({directory, source}) => {
  const intake = await startIntake({origin: source.origin, directory});
  try {
    await fetch(intake.origin + '/ingest', {method: 'POST'});
    const again = await (await fetch(intake.origin + '/ingest', {method: 'POST'})).json();
    assert.equal(again.fetchedRecords, 0);
    assert.equal(again.committed, false);
    assert.equal(again.completed, 0);
    const devices = await (await fetch(intake.origin + '/devices')).json();
    assert.equal(devices.length, 2);
  } finally { await intake.close(); }
}));

test('断在未结束器件：上下文与未决记录保留，重开归档后续投不重复建件', () => environment(async ({directory, source}) => {
  // 第一页（偏移0-4）正常接收并落盘：chip1 完结，工位2 器件在制
  let intake = await startIntake({origin: source.origin, directory});
  const client = createClient(source.origin);
  const page0 = await client('/records?offset=0');
  const state = initialStreamState();
  for (const record of page0.records) reduceRecord(state, record);
  assert.equal(state.nextOffset, 5);
  await intake.archive.commitStream(state, client.exchanges.filter(e => e.status === 200));
  await intake.close();

  source.setPhase('interrupted');                     // 第二页外部阶段切换：HEAD_END + LOT_END，无 PART_END
  intake = await startIntake({origin: source.origin, directory});
  try {
    const summary = await (await fetch(intake.origin + '/ingest', {method: 'POST'})).json();
    assert.equal(summary.fetchedRecords, 2);
    assert.equal(summary.completed, 0);
    assert.equal(summary.open, 1);                    // 工位2 的芯片从未收到 PART_END
    const pending = await (await fetch(intake.origin + '/pending')).json();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].serial, null);
    assert.equal(pending[0].lifecycle, 'open');
    assert.equal(pending[0].headStopped, true);
    assert.equal(pending[0].lotEnded, true);
    assert.equal(pending[0].tests[0].number, 9);
    assert.equal(pending[0].tests[0].flags.passed, false);

    const onceMore = await (await fetch(intake.origin + '/ingest', {method: 'POST'})).json();
    assert.equal(onceMore.fetchedRecords, 0);
    const devices = await (await fetch(intake.origin + '/devices')).json();
    assert.equal(devices.length, 1);                 // 只有 chip1，绝不给悬置芯片伪造结束
    assert.deepEqual(devices.map(d => d.serial), ['chip1']);
  } finally { await intake.close(); }
}));

test('新批次阶段：同测试号换单位比例，未执行测试的来源状态原样保留', () => environment(async ({directory, source}) => {
  const intake = await startIntake({origin: source.origin, directory});
  const client = createClient(source.origin);
  const page0 = await client('/records?offset=0');   // L1 偏移 0-4，工位2 器件仍在制
  const state = initialStreamState();
  for (const record of page0.records) reduceRecord(state, record);
  await intake.archive.commitStream(state, client.exchanges.filter(e => e.status === 200));
  source.setPhase('new-lot');
  try {
    const summary = await (await fetch(intake.origin + '/ingest', {method: 'POST'})).json();
    assert.equal(summary.fetchedRecords, 4);
    assert.equal(summary.suspended, 1);              // L1 工位2 旧器件悬置
    assert.equal(summary.open, 1);                   // L2 新器件在制
    const pending = await (await fetch(intake.origin + '/pending')).json();
    const l2 = pending.find(p => p.lot === 'L2');
    assert.deepEqual(l2.tests[0].flags, {valid: false, executed: false, passed: false});
    assert.equal(l2.tests[0].value, null);
    assert.equal(l2.tests[0].description.unit, 'A');
    assert.equal(l2.tests[0].description.scale, 0);
    const status = await (await fetch(intake.origin + '/stream')).json();
    assert.equal(status.anomalyCount, 1);
    assert.equal(status.anomalies[0].kind, 'part-slot-reused-before-end');
  } finally { await intake.close(); }
}));

test('流状态随归档持久化：重开后水位、悬置器件与异常全部可恢复', () => environment(async ({directory, source}) => {
  const client = createClient(source.origin);
  const state = initialStreamState();
  await ingestStream(client, state);
  const archive = await openArchive(directory);
  await archive.commitStream(state, client.exchanges.filter(e => e.status === 200));
  const reopened = await openArchive(directory);
  const restored = reopened.stream();
  assert.equal(restored.nextOffset, 8);
  assert.equal(restored.devices.length, 2);
  assert.equal(restored.stream, 's1');
  assert.equal(listPending(restored).length, 0);
}));
