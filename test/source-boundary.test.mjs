import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

// 边界回归：公开验收未穷举的组合，用本地合成来源逐一固定行为。
async function startRoutes(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({method: request.method, path: request.url});
    const route = routes.find(item => item.path === request.url && (item.method ?? 'GET') === request.method);
    if (!route) { response.writeHead(404).end('未声明'); return; }
    const headers = {...route.headers};
    let bytes;
    if (route.hex !== undefined) {
      bytes = Buffer.from(route.hex, 'hex');
      headers['content-type'] = 'application/octet-stream';
    } else {
      bytes = Buffer.from(JSON.stringify(route.body));
      headers['content-type'] = 'application/json';
    }
    response.writeHead(route.status ?? 200, headers).end(bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

const layoutV1 = {
  generation: 'v1', recordBytes: 18, littleEndian: true,
  scale: [0.01, 0.01, 0.01], offset: [100, 200, 0],
  extras: [{name: 'temperature', offset: 16, type: 'u16', unit: 'degC', missing: 65535}]
};

function surveyBody(overrides = {}) {
  return {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true, ...overrides};
}

function pointBytes({x = 0, y = 0, z = 0, intensity = 0, classification = 0, flags = 0, extra = Buffer.alloc(2)}) {
  const base = Buffer.alloc(16);
  base.writeInt32LE(x, 0);
  base.writeInt32LE(y, 4);
  base.writeInt32LE(z, 8);
  base.writeUInt16LE(intensity, 12);
  base.writeUInt8(classification, 14);
  base.writeUInt8(flags, 15);
  return Buffer.concat([base, extra]);
}

function i16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16LE(value, 0);
  return bytes;
}

async function runCollect(routes, {runs = 1} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  const source = await startRoutes(routes);
  try {
    let result;
    let archive;
    for (let iteration = 0; iteration < runs; iteration += 1) {
      archive = await openArchive(directory);
      result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
    }
    return {result, archive, source};
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
}

test('未封存交付保留已解释记录但不报完整', async () => {
  const routes = [
    {path: '/survey', body: surveyBody({sealed: false})},
    {path: '/layout', body: layoutV1},
    {path: '/blocks/b1', hex: pointBytes({x: 100, y: 200, z: 300, flags: 1}).toString('hex'), headers: {'X-Generation': 'v1'}}
  ];
  const {result, archive} = await runCollect(routes);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].pointId, 'd9/b1/0');
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.code === 'delivery-unsealed'));
  assert.equal(archive.snapshot().records.length, 1, '已收的安全独立部分仍然落库');
});

test('个别块不可用保留其他块并留下可复核缺口', async () => {
  const routes = [
    {path: '/survey', body: surveyBody({blocks: ['/blocks/b1', '/blocks/b2']})},
    {path: '/layout', body: layoutV1},
    {path: '/blocks/b1', status: 503, hex: ''},
    {path: '/blocks/b2', hex: pointBytes({x: 1}).toString('hex'), headers: {'X-Generation': 'v1'}}
  ];
  const {result} = await runCollect(routes);
  assert.deepEqual(result.records.map(record => record.pointId), ['d9/b2/0']);
  assert.equal(result.complete, false);
  const issue = result.issues.find(item => item.code === 'block-unavailable');
  assert.equal(issue.source, '/blocks/b1');
  assert.equal(issue.status, 503);
});

test('属性说明未发布时不取块、不出点、缺口可复核', async () => {
  const routes = [
    {path: '/survey', body: surveyBody()},
    {path: '/layout', status: 503, hex: ''}
  ];
  const {result, source} = await runCollect(routes);
  assert.deepEqual(result.records, []);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.code === 'layout-unavailable'));
  assert.equal(source.requests.some(request => request.path.startsWith('/blocks/')), false, '缺解释依据时不得领取块');
});

test('块缺少世代标记时拒绝解释，不做跨版本拼接', async () => {
  const routes = [
    {path: '/survey', body: surveyBody()},
    {path: '/layout', body: layoutV1},
    {path: '/blocks/b1', hex: pointBytes({x: 100}).toString('hex')}
  ];
  const {result} = await runCollect(routes);
  assert.deepEqual(result.records, []);
  assert.equal(result.complete, false);
  const issue = result.issues.find(item => item.code === 'generation-mismatch');
  assert.equal(issue.layoutGeneration, 'v1');
  assert.equal(issue.blockGeneration, null);
});

test('i16 扩展按符号解释，缺失哨兵给出无效原因', async () => {
  const layout = {...layoutV1, extras: [{name: 'tilt', offset: 16, type: 'i16', unit: 'arcsec', missing: -32768}]};
  const block = Buffer.concat([
    pointBytes({x: 1, extra: i16(-1)}),
    pointBytes({x: 2, extra: i16(-32768)})
  ]);
  const routes = [
    {path: '/survey', body: surveyBody()},
    {path: '/layout', body: layout},
    {path: '/blocks/b1', hex: block.toString('hex'), headers: {'X-Generation': 'v1'}}
  ];
  const {result} = await runCollect(routes);
  assert.equal(result.complete, true);
  assert.deepEqual(result.records[0].extras.tilt, {value: -1, unit: 'arcsec'});
  assert.deepEqual(result.records[1].extras.tilt, {value: null, unit: 'arcsec', reason: 'source-missing'});
});

test('多块序号各自起算，字节范围与分类标记可溯源', async () => {
  const block1 = Buffer.concat([
    pointBytes({x: 100, y: 200, z: 300, intensity: 10, classification: 7, flags: 0}),
    pointBytes({x: 101, flags: 1})
  ]);
  const routes = [
    {path: '/survey', body: surveyBody({blocks: ['/blocks/b1', '/blocks/b2']})},
    {path: '/layout', body: layoutV1},
    {path: '/blocks/b1', hex: block1.toString('hex'), headers: {'X-Generation': 'v1'}},
    {path: '/blocks/b2', hex: pointBytes({x: 5}).toString('hex'), headers: {'X-Generation': 'v1'}}
  ];
  const {result} = await runCollect(routes);
  assert.equal(result.complete, true);
  assert.deepEqual(result.records.map(record => record.pointId), ['d9/b1/0', 'd9/b1/1', 'd9/b2/0']);
  assert.deepEqual(result.records.map(record => record.byteOffset), [0, 18, 0]);
  assert.ok(result.records.every(record => record.byteLength === 18 && record.generation === 'v1'));
  const first = result.records[0];
  assert.equal(first.classification, 7);
  assert.equal(first.intensity, 10);
  assert.equal(first.withheld, false);
  assert.equal(result.records[1].withheld, true);
  assert.deepEqual(first.xyz, [101, 202, 3]);
});

test('块长不是记录整数倍时整块按截断拒绝，完整前缀也不提交', async () => {
  const truncated = Buffer.concat([pointBytes({x: 100}), Buffer.from([1, 2])]);
  assert.equal(truncated.length % 18 !== 0, true);
  const routes = [
    {path: '/survey', body: surveyBody()},
    {path: '/layout', body: layoutV1},
    {path: '/blocks/b1', hex: truncated.toString('hex'), headers: {'X-Generation': 'v1'}}
  ];
  const {result} = await runCollect(routes);
  assert.deepEqual(result.records, []);
  assert.equal(result.complete, false);
  const issue = result.issues.find(item => item.code === 'block-truncated');
  assert.equal(issue.byteLength, 20);
  assert.equal(issue.recordBytes, 18);
});

test('重复领取不制造新修订，归档记录数保持稳定', async () => {
  const routes = [
    {path: '/survey', body: surveyBody()},
    {path: '/layout', body: layoutV1},
    {path: '/blocks/b1', hex: pointBytes({x: 100, y: 200, z: 300}).toString('hex'), headers: {'X-Generation': 'v1'}}
  ];
  const {result, archive} = await runCollect(routes, {runs: 2});
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 1);
  assert.equal(archive.snapshot().records.length, 1);
});

test('越界块链接转为可复核缺口，不发起站外请求', async () => {
  const routes = [
    {path: '/survey', body: surveyBody({blocks: ['https://example.invalid/blocks/b1']})},
    {path: '/layout', body: layoutV1}
  ];
  const {result} = await runCollect(routes);
  assert.deepEqual(result.records, []);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.code === 'block-unavailable' && /越界/.test(issue.message)));
  assert.equal(result.evidenceCount, 2, '只实际接收了目录与布局两份原文');
});

test('已封存且块目录为空是完整的空结果，区别于缺数据', async () => {
  const routes = [
    {path: '/survey', body: surveyBody({blocks: []})},
    {path: '/layout', body: layoutV1}
  ];
  const {result} = await runCollect(routes);
  assert.deepEqual(result.records, []);
  assert.equal(result.complete, true);
  assert.deepEqual(result.issues, []);
});

test('布局超出规范化子集时不解释任何点', async () => {
  const routes = [
    {path: '/survey', body: surveyBody()},
    {path: '/layout', body: {...layoutV1, recordBytes: 10}},
    {path: '/blocks/b1', hex: pointBytes({}).toString('hex'), headers: {'X-Generation': 'v1'}}
  ];
  const {result, source} = await runCollect(routes);
  assert.deepEqual(result.records, []);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.code === 'layout-invalid'));
  assert.equal(source.requests.some(request => request.path.startsWith('/blocks/')), false);
});
