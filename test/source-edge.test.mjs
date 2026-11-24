import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {openArchive} from '../src/archive.mjs';
import {collect} from '../src/collector.mjs';

// 用最小本地来源覆盖公开回归未穷举的组合：异步发布、跨版本、未声明字节、
// 越界链接、截断与扩展缺失。来源经由真实 HTTP 响应。

function hexRecord({x = 0, y = 0, z = 0, intensity = 0, classification = 0, flags = 0, extra}) {
  const buffer = Buffer.alloc(18);
  buffer.writeInt32LE(x, 0);
  buffer.writeInt32LE(y, 4);
  buffer.writeInt32LE(z, 8);
  buffer.writeUInt16LE(intensity, 12);
  buffer.writeUInt8(classification, 14);
  buffer.writeUInt8(flags, 15);
  if (extra !== undefined) buffer.writeUInt16LE(extra, 16);
  return buffer.toString('hex');
}

async function source(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const entries = routes.filter(item => item.path === request.url);
    const selected = entries[Math.min(requests.filter(path => path === request.url).length - 1, entries.length - 1)];
    if (!selected) { response.writeHead(404).end(); return; }
    if (selected.status && selected.status >= 400) { response.writeHead(selected.status).end(); return; }
    const body = Buffer.isBuffer(selected.body) ? selected.body : Buffer.from(selected.body);
    response.writeHead(200, {'content-type': 'application/octet-stream', ...selected.headers});
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function acquire(routes) {
  const directory = await mkdtemp(join(tmpdir(), 'source-edge-'));
  const provider = await source(routes);
  try {
    const archive = await openArchive(directory);
    const result = await collect({baseUrl: provider.baseUrl, archive, mode: 'source'});
    const persisted = (await openArchive(directory)).snapshot();
    return {result, persisted, requests: provider.requests};
  } finally { await provider.close(); await rm(directory, {recursive: true, force: true}); }
}

const layout = (overrides = {}) => JSON.stringify({
  generation: 'v1', recordBytes: 18, littleEndian: true,
  scale: [0.01, 0.01, 0.01], offset: [100, 200, 0],
  extras: [{name: 'temperature', offset: 16, type: 'u16', unit: 'degC', missing: 65535}],
  ...overrides,
});

test('块先于布局可读时仍按布局解释并逐点记录字节范围', async () => {
  const {result} = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true})},
    {path: '/layout', body: layout()},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: Buffer.from(
      hexRecord({x: 100, y: 200, z: 300, classification: 7, flags: 1, extra: 0})
      + hexRecord({x: -100, y: 0, z: 0, classification: 2, extra: 65535}), 'hex')},
  ]);
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 2);
  const [first, second] = result.records;
  assert.equal(first.xyz[0], 101);
  assert.equal(first.xyz[1], 202);
  assert.equal(first.xyz[2], 3);
  assert.equal(first.withheld, true);
  assert.equal(first.classification, 7);
  assert.deepEqual(first.extras.temperature, {value: 0, unit: 'degC'});
  assert.equal(second.xyz[0], 99);
  assert.equal(second.xyz[1], 200);
  assert.deepEqual(second.extras.temperature, {value: null, unit: 'degC', reason: 'source-missing'});
  // 每点可回溯到交付、块、块摘要与块内字节范围。
  assert.equal(second.source.delivery, 'd9');
  assert.equal(second.source.block, 'b1');
  assert.equal(second.source.byteOffset, 18);
  assert.equal(second.source.byteLength, 18);
  assert.match(second.source.blockSha256, /^[a-f0-9]{64}$/);
});

test('分类标记与withheld分开表达，扣留的点仍保留', async () => {
  const {result} = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'dw', layout: '/layout', blocks: ['/blocks/b1'], sealed: true})},
    {path: '/layout', body: layout()},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: Buffer.from(
      hexRecord({classification: 18, flags: 0}) + hexRecord({classification: 18, flags: 1, extra: 5}), 'hex')},
  ]);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].classification, 18);
  assert.equal(result.records[0].withheld, false);
  assert.equal(result.records[1].classification, 18);
  assert.equal(result.records[1].withheld, true);
  assert.equal(result.records[1].extras.temperature.value, 5);
});

test('布局尚未发布时保留缺块问题且不臆测坐标', async () => {
  const {result, requests} = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'dm', layout: '/layout', blocks: ['/blocks/b1'], sealed: true})},
    {path: '/layout', status: 404, body: ''},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: Buffer.from(hexRecord({x: 1}), 'hex')},
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.records.length, 0);
  assert.ok(result.issues.some(item => item.code === 'layout-unavailable'));
  assert.equal(requests.includes('/blocks/b1'), false, '没有布局时不解释块');
});

test('块被扣留（503）时保留其他块并可复核', async () => {
  const {result} = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'dh', layout: '/layout', blocks: ['/blocks/b1', '/blocks/b2'], sealed: true})},
    {path: '/layout', body: layout()},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: Buffer.from(hexRecord({x: 10, extra: 1}), 'hex')},
    {path: '/blocks/b2', status: 503, body: ''},
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].pointId, 'dh/b1/0');
  assert.ok(result.issues.some(item => item.code === 'block-unavailable' && item.block === 'b2'));
});

test('块代次不一致时拒绝解释该块，不与本次布局的点混拼', async () => {
  const {result} = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'dg', layout: '/layout', blocks: ['/blocks/b1', '/blocks/b2'], sealed: true})},
    {path: '/layout', body: layout()},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: Buffer.from(hexRecord({x: 10}), 'hex')},
    {path: '/blocks/b2', headers: {'x-generation': 'v0'}, body: Buffer.from(hexRecord({x: 20}), 'hex')},
  ]);
  assert.equal(result.complete, false);
  assert.deepEqual(result.records.map(record => record.pointId), ['dg/b1/0']);
  assert.ok(result.issues.some(item => item.code === 'block-generation-mismatch'));
});

test('未声明字节与未支持类型只登记问题，不解释成事实', async () => {
  const {result} = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'du', layout: '/layout', blocks: ['/blocks/b1'], sealed: true})},
    {path: '/layout', body: layout({recordBytes: 20, extras: [
      {name: 'temperature', offset: 16, type: 'u16', unit: 'degC', missing: 65535},
      {name: 'humidity', offset: 18, type: 'u32', unit: '%', missing: 0},
    ]})},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: Buffer.alloc(20, 0)},
  ]);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(item => item.code === 'extra-type-unsupported' && item.name === 'humidity'));
  assert.ok(result.issues.some(item => item.code === 'layout-unexplained-bytes'));
  const [record] = result.records;
  assert.deepEqual(Object.keys(record.extras), ['temperature']);
  assert.equal('humidity' in record.extras, false);
});

test('sealed=false 可保留已收点但不得宣称完整', async () => {
  const {result} = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'ds', layout: '/layout', blocks: ['/blocks/b1'], sealed: false})},
    {path: '/layout', body: layout()},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: Buffer.from(hexRecord({x: 10, extra: 2}), 'hex')},
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.records.length, 1);
  assert.ok(result.issues.some(item => item.code === 'survey-unsealed'));
});

test('sealed=true 且未发布分块是与缺数据相区分的空有效结果', async () => {
  const {result} = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'de', layout: '/layout', blocks: [], sealed: true})},
    {path: '/layout', body: layout({extras: []})},
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.issues, []);
});

test('重复领取不重复累积记录且原文可复核', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'source-repeat-'));
  const provider = await source([
    {path: '/survey', body: JSON.stringify({delivery: 'dr', layout: '/layout', blocks: ['/blocks/b1'], sealed: true})},
    {path: '/layout', body: layout()},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: Buffer.from(hexRecord({x: 1, extra: 0}), 'hex')},
  ]);
  try {
    await collect({baseUrl: provider.baseUrl, archive: await openArchive(directory), mode: 'source'});
    const result = await collect({baseUrl: provider.baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(result.records.length, 1);
    const snapshot = (await openArchive(directory)).snapshot();
    assert.equal(snapshot.records.length, 1);
    assert.ok(snapshot.evidence.some(item => item.url.endsWith('/blocks/b1')));
    const blockEvidence = snapshot.evidence.find(item => item.url.endsWith('/blocks/b1'));
    const raw = await (await openArchive(directory)).raw(blockEvidence.hash);
    assert.equal(raw.toString('hex'), hexRecord({x: 1, extra: 0}));
  } finally { await provider.close(); await rm(directory, {recursive: true, force: true}); }
});

test('坐标原点变化只按本次布局解释，不沿用旧版本', async () => {
  const block = Buffer.from(hexRecord({x: 50, y: 50, z: 0, extra: 0}), 'hex');
  const first = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'dv', layout: '/layout', blocks: ['/blocks/b1'], sealed: true})},
    {path: '/layout', body: layout({generation: 'v1', offset: [0, 0, 0]})},
    {path: '/blocks/b1', headers: {'x-generation': 'v1'}, body: block},
  ]);
  const second = await acquire([
    {path: '/survey', body: JSON.stringify({delivery: 'dv', layout: '/layout', blocks: ['/blocks/b1'], sealed: true})},
    {path: '/layout', body: layout({generation: 'v2', offset: [1000, 2000, 3000]})},
    {path: '/blocks/b1', headers: {'x-generation': 'v2'}, body: block},
  ]);
  assert.deepEqual(first.result.records[0].xyz, [0.5, 0.5, 0]);
  assert.deepEqual(second.result.records[0].xyz, [1000.5, 2000.5, 3000]);
  assert.equal(second.result.layoutGeneration, 'v2');
});
