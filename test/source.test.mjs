import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

// 这些边界不在公开样例内：用独立的小来源验证接收端自己的解释规则。
function startRoutes(routes) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const path = request.url;
    requests.push(path);
    const entry = routes[path];
    if (!entry) { response.writeHead(404).end(); return; }
    const resolved = typeof entry === 'function' ? entry({path, requests}) : entry;
    const rawBody = typeof resolved.body === 'function' ? resolved.body({path, requests}) : resolved.body;
    const headers = typeof resolved.headers === 'function' ? resolved.headers({path, requests}) : resolved.headers;
    const body = rawBody === undefined ? Buffer.alloc(0) : Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(JSON.stringify(rawBody));
    response.writeHead(resolved.status ?? 200, {'content-type': resolved.type ?? (Buffer.isBuffer(rawBody) ? 'application/octet-stream' : 'application/json'), ...headers});
    response.end(body);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => [...requests],
    close: () => new Promise((done, fail) => { server.close(error => error ? fail(error) : done()); server.closeAllConnections(); })
  })));
}

const layout = (overrides = {}) => ({
  generation: 'v1', recordBytes: 18, littleEndian: true, scale: [0.01, 0.01, 0.01], offset: [100, 200, 0],
  extras: [{name: 'temperature', offset: 16, type: 'u16', unit: 'degC', missing: 65535}],
  ...overrides
});

function point({x = 100, y = 200, z = 300, intensity = 10, classification = 2, flags = 0, extra = 0xffff, extra2, recordBytes = 18} = {}) {
  const bytes = Buffer.alloc(recordBytes);
  bytes.writeInt32LE(x, 0); bytes.writeInt32LE(y, 4); bytes.writeInt32LE(z, 8);
  bytes.writeUInt16LE(intensity, 12);
  bytes.writeUInt8(classification, 14);
  bytes.writeUInt8(flags, 15);
  if (extra !== null) bytes.writeUInt16LE(extra, 16);
  if (extra2 !== undefined) bytes.writeUInt16LE(extra2, 18);
  return bytes;
}

async function run(t, routes) {
  const directory = await mkdtemp(join(tmpdir(), 'source-edge-'));
  const source = await startRoutes(routes);
  t.after(async () => {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  });
  const archive = await openArchive(directory);
  const result = await collect({baseUrl: source.baseUrl, archive, mode: 'source'});
  return {result, archive, requests: source.requests()};
}

test('未封存的目录不能报告完整，但已领取的安全部分仍保留', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: false}},
    '/layout': {body: layout()},
    '/blocks/b1': {body: point({flags: 1}), headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].withheld, true);
  assert.ok(result.issues.some(issue => issue.code === 'delivery-not-sealed'));
});

test('单块503只影响该块，其余块按同一布局独立保留', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1', '/blocks/b2'], sealed: true}},
    '/layout': {body: layout()},
    '/blocks/b1': {status: 503, body: ''},
    '/blocks/b2': {body: Buffer.concat([point({x: 500}), point({x: 600})]), headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records.map(record => record.pointId), ['d9/b2/0', 'd9/b2/1']);
  assert.deepEqual(result.records.map(record => record.byteOffset), [0, 18]);
  assert.ok(result.issues.some(issue => issue.code === 'block-status' && issue.status === 503));
});

test('布局缺失时不按未知语法解释块，也不产生点记录', async t => {
  const {result, requests} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true}},
    '/layout': {status: 500, body: '布局暂不可用'},
    '/blocks/b1': {body: point(), headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.ok(result.issues.some(issue => issue.code === 'layout-status'));
});

test('块目录缺布局链接时保留缺口且不猜测', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', blocks: ['/blocks/b1'], sealed: true}},
    '/blocks/b1': {body: point(), headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.ok(result.issues.some(issue => issue.code === 'survey-invalid-layout-link'));
});

test('块的 generation 与布局不一致时整块不解释，另一块正常保留', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/old', '/blocks/new'], sealed: true}},
    '/layout': {body: layout({generation: 'v2', offset: [0, 0, 0], scale: [1, 1, 1]})},
    '/blocks/old': {body: point({x: 1, y: 2, z: 3}), headers: {'X-Generation': 'v1'}},
    '/blocks/new': {body: point({x: 7, y: 8, z: 9}), headers: {'X-Generation': 'v2'}}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records.map(record => record.pointId), ['d9/new/0']);
  assert.deepEqual(result.records[0].xyz, [7, 8, 9]);
  assert.ok(result.issues.some(issue => issue.code === 'block-generation-mismatch' && issue.generation === 'v1'));
});

test('块响应缺少 X-Generation 时不假定与布局同版', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true}},
    '/layout': {body: layout()},
    '/blocks/b1': {body: point()}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.ok(result.issues.some(issue => issue.code === 'block-generation-missing'));
});

test('截断块不提交任何正常点记录，也不丢弃原文证据', async t => {
  const {result, archive} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true}},
    '/layout': {body: layout()},
    '/blocks/b1': {body: Buffer.concat([point(), point({x: 700}).subarray(0, 5)]), headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  const issue = result.issues.find(item => item.code === 'block-truncated');
  assert.equal(issue.completeByteLength, 18);
  assert.equal(issue.remainderBytes, 5);
  const snapshot = archive.snapshot();
  assert.ok(snapshot.evidence.some(item => item.url.endsWith('/blocks/b1')));
  const receipt = snapshot.evidence.find(item => item.url.endsWith('/blocks/b1'));
  assert.ok((await archive.raw(receipt.hash)).length > 18);
});

test('跨 origin 的块链接不被访问，并留下可复核缺口', async t => {
  const {result, requests} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['https://example.invalid/blocks/b1'], sealed: true}},
    '/layout': {body: layout()}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.ok(result.issues.some(issue => issue.code === 'block-link-cross-origin'));
  assert.deepEqual(requests, ['/survey', '/layout']);
});

test('survey 非法 JSON 与 JSON null 分属不同缺口，且都保留原文', async t => {
  const {result, requests} = await run(t, {
    '/survey': {body: Buffer.from('not-json'), type: 'application/json'}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.issues.map(issue => issue.code), ['survey-invalid-json']);
  assert.deepEqual(requests, ['/survey']);
  assert.equal(result.evidenceCount, 1);

  const nullSurvey = await run(t, {'/survey': {body: null}});
  assert.equal(nullSurvey.result.complete, false);
  assert.deepEqual(nullSurvey.result.issues.map(issue => issue.code), ['survey-invalid']);
});

test('空的有效交付与错误状态可区分：封存且无块时完整但不含点', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: [], sealed: true}},
    '/layout': {body: layout()}
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.issues, []);
});

test('每次交付按自己的布局解释，原点调整后不沿用上一版', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'source-delivery-'));
  const state = {layout: layout({generation: 'v1', offset: [100, 200, 0]})};
  const source = await startRoutes({
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true}},
    '/layout': {body: () => state.layout},
    '/blocks/b1': {body: () => point({x: 100, y: 200, z: 300}), headers: () => ({'X-Generation': state.layout.generation})}
  });
  t.after(async () => {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  });
  const first = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
  assert.deepEqual(first.records[0].xyz, [101, 202, 3]);
  state.layout = layout({generation: 'v2', offset: [-50, -60, -70], scale: [1, 1, 1]});
  const second = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
  assert.equal(second.complete, true);
  assert.deepEqual(second.records[0].xyz, [50, 140, 230]);
  assert.equal(second.records[0].generation, 'v2');
  const reopened = await openArchive(directory);
  const revisions = reopened.snapshot().records.filter(record => record.id === 'd9/b1/0');
  assert.equal(revisions.length, 2, '两版布局下的同一点留下两条可追溯修订');
});

test('分类标记、扩展量纲、缺失原因和字节范围逐点可追溯', async t => {
  const first = point({x: 1, classification: 6, flags: 1, extra: 0, extra2: 5, recordBytes: 20});
  const second = point({x: 2, classification: 2, flags: 0, extra: 0xffff, extra2: 6, recordBytes: 20});
  const bytes = Buffer.concat([first, second]);
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true}},
    '/layout': {body: layout({recordBytes: 20, extras: [
      {name: 'temperature', offset: 16, type: 'u16', unit: 'degC', missing: 65535},
      {name: 'reflectance', offset: 18, type: 'u16', unit: 'percent', missing: 65534}
    ]})},
    '/blocks/b1': {body: bytes, headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, true);
  const [withheld, present] = result.records;
  assert.equal(withheld.withheld, true);
  assert.equal(withheld.classification, 6);
  assert.deepEqual(withheld.extras.temperature, {value: 0, unit: 'degC'});
  assert.deepEqual(withheld.extras.reflectance, {value: 5, unit: 'percent'});
  assert.equal(present.withheld, false);
  assert.deepEqual(present.extras.temperature, {value: null, unit: 'degC', reason: 'source-missing'});
  assert.deepEqual(present.extras.reflectance, {value: 6, unit: 'percent'});
  assert.equal(withheld.byteOffset, 0);
  assert.equal(withheld.byteLength, 20);
  assert.equal(present.byteOffset, 20);
  assert.equal(present.block, 'b1');
  assert.equal(present.blockSha256.length, 64);
});

test('扩展字节范围重叠时布局不可解释，不生成点记录', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true}},
    '/layout': {body: layout({recordBytes: 20, extras: [
      {name: 'temperature', offset: 16, type: 'u16', unit: 'degC', missing: 65535},
      {name: 'reflectance', offset: 17, type: 'u16', unit: 'percent', missing: 65534}
    ]})},
    '/blocks/b1': {body: point({recordBytes: 20}), headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.ok(result.issues.some(issue => issue.code === 'layout-overlapping-extras'));
});

test('recordBytes=18 且未列 extras 时套用来源声明的默认扩展，0 为有效值', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true}},
    '/layout': {body: {generation: 'v1', recordBytes: 18, littleEndian: true, scale: [1, 1, 1], offset: [0, 0, 0]}},
    '/blocks/b1': {body: point({extra: 0}), headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, true);
  assert.deepEqual(result.records[0].extras.temperature, {value: 0, unit: 'degC'});
});

test('未声明类型的扩展不被猜成有效数值，布局判为不可解释', async t => {
  const {result} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: true}},
    '/layout': {body: layout({extras: [{name: 'pressure', offset: 16, type: 'f32', unit: 'hPa', missing: -1}]})},
    '/blocks/b1': {body: Buffer.concat([point(), Buffer.alloc(2)]), headers: {'X-Generation': 'v1'}}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.ok(result.issues.some(issue => issue.code === 'layout-unsupported-extra-type'));
});

test('来源缺块且 sealed=false 时目录与布局缺口同时可达', async t => {
  const {result, requests} = await run(t, {
    '/survey': {body: {delivery: 'd9', layout: '/layout', blocks: ['/blocks/b1'], sealed: false}},
    '/layout': {status: 503, body: ''},
    '/blocks/b1': {status: 503, body: ''}
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.records, []);
  assert.equal(result.evidenceCount, 2, 'survey 与失败的布局响应都保留原文');
  const codes = result.issues.map(issue => issue.code);
  assert.ok(codes.includes('delivery-not-sealed'));
  assert.ok(codes.includes('layout-status'));
  assert.deepEqual(requests, ['/survey', '/layout'], '没有布局时不解释块，也不盲目遍历');
});

