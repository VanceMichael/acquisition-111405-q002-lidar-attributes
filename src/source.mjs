import {createHash} from 'node:crypto';

// 来源只承诺这里声明过的二进制子集：小端、16 字节定长基础记录，
// 以及布局里逐项声明的 2 字节扩展。未声明的语法不在这里猜。
const BASE_BYTES = 16;
const EXTRA_TYPES = {
  u16: {bytes: 2, read: (bytes, offset) => bytes.readUInt16LE(offset), minimum: 0, maximum: 0xffff},
  i16: {bytes: 2, read: (bytes, offset) => bytes.readInt16LE(offset), minimum: -0x8000, maximum: 0x7fff}
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const finiteVector = value => Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item));

function resolveHref(origin, link) {
  try {
    return new URL(link, origin).href;
  } catch {
    return String(link);
  }
}

function blockIdFromHref(href) {
  try {
    const segments = new URL(href).pathname.split('/').filter(Boolean);
    return segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
  } catch {
    return '';
  }
}

const NOT_RECEIVED = Symbol('not-received');

async function fetchJson(transport, link, label, issues) {
  const url = resolveHref(transport.origin, link);
  let response;
  try {
    response = await transport.request(link);
  } catch (error) {
    issues.push({code: `${label}-unavailable`, url, message: `${label} 无法领取：${error.message}`});
    return NOT_RECEIVED;
  }
  if (!response.ok) {
    issues.push({code: `${label}-status`, url, status: response.status, message: `${label} 返回 HTTP ${response.status}`});
    return NOT_RECEIVED;
  }
  try {
    return response.json();
  } catch {
    issues.push({code: `${label}-invalid-json`, url, status: response.status, message: `${label} 不是可解释的 JSON`});
    return NOT_RECEIVED;
  }
}

function validateExtras(extras, recordBytes, issues) {
  const parsed = [];
  const names = new Set();
  const declared = extras !== undefined && extras !== null;
  // 来源契约给 18 字节记录声明了默认扩展：offset 16 的 u16 temperature，
  // 65535 为缺失、0 为有效值。仅在布局未声明 extras 时套用；显式 [] 表示没有扩展。
  if (!declared && recordBytes === 18) {
    return [{name: 'temperature', offset: 16, bytes: 2, type: 'u16', unit: 'degC', missing: 65535, read: EXTRA_TYPES.u16.read}];
  }
  if (!declared) {
    issues.push({code: 'layout-invalid-extras', message: '布局缺少 extras 数组'});
    return parsed;
  }
  if (!Array.isArray(extras)) {
    issues.push({code: 'layout-invalid-extras', message: '布局 extras 不是数组'});
    return parsed;
  }
  for (const [index, extra] of extras.entries()) {
    const location = {extraIndex: index};
    if (!isObject(extra) || !nonEmptyString(extra.name)) {
      issues.push({code: 'layout-invalid-extra', ...location, message: '扩展缺少有效名称'});
      continue;
    }
    if (names.has(extra.name)) {
      issues.push({code: 'layout-duplicate-extra', ...location, name: extra.name, message: '扩展名称重复'});
      continue;
    }
    names.add(extra.name);
    const type = isObject(EXTRA_TYPES[extra.type]) ? EXTRA_TYPES[extra.type] : null;
    if (!type) {
      issues.push({code: 'layout-unsupported-extra-type', ...location, name: extra.name, type: extra.type, message: '扩展类型不在来源声明的子集内'});
      continue;
    }
    if (!Number.isInteger(extra.offset) || extra.offset < BASE_BYTES || extra.offset + type.bytes > recordBytes) {
      issues.push({code: 'layout-invalid-extra-range', ...location, name: extra.name, offset: extra.offset, recordBytes, message: '扩展字节范围越过记录或覆盖基础字段'});
      continue;
    }
    if (!nonEmptyString(extra.unit)) {
      issues.push({code: 'layout-invalid-extra-unit', ...location, name: extra.name, message: '扩展缺少量纲'});
      continue;
    }
    let missing;
    if (extra.missing !== undefined && extra.missing !== null) {
      if (!Number.isInteger(extra.missing) || extra.missing < type.minimum || extra.missing > type.maximum) {
        issues.push({code: 'layout-invalid-extra-missing', ...location, name: extra.name, missing: extra.missing, message: '扩展缺失标记超出该类型范围'});
        continue;
      }
      missing = extra.missing;
    }
    const overlap = parsed.find(previous =>
      extra.offset < previous.offset + previous.bytes && previous.offset < extra.offset + type.bytes);
    if (overlap) {
      issues.push({code: 'layout-overlapping-extras', ...location, name: extra.name, other: overlap.name, message: '扩展字节范围重叠'});
      continue;
    }
    parsed.push({name: extra.name, offset: extra.offset, bytes: type.bytes, type: extra.type, unit: extra.unit, missing, read: type.read});
  }
  return parsed;
}

function validateLayout(payload) {
  const issues = [];
  if (!isObject(payload)) {
    return {issues: [{code: 'layout-invalid', message: '布局不是对象'}]};
  }
  if (!nonEmptyString(payload.generation)) {
    issues.push({code: 'layout-invalid-generation', message: '布局缺少 generation'});
  }
  if (!Number.isInteger(payload.recordBytes) || payload.recordBytes < BASE_BYTES) {
    issues.push({code: 'layout-invalid-record-bytes', recordBytes: payload.recordBytes, message: 'recordBytes 不是不小于基础记录长度的整数'});
  }
  if (payload.littleEndian !== true) {
    issues.push({code: 'layout-unsupported-endianness', littleEndian: payload.littleEndian, message: '来源子集只声明了小端布局'});
  }
  if (!finiteVector(payload.scale)) {
    issues.push({code: 'layout-invalid-scale', message: '布局 scale 不是三个有限数'});
  }
  if (!finiteVector(payload.offset)) {
    issues.push({code: 'layout-invalid-offset', message: '布局 offset 不是三个有限数'});
  }
  const extras = validateExtras(payload.extras, payload.recordBytes, issues);
  if (issues.length) return {issues};
  return {
    layout: {
      generation: payload.generation,
      recordBytes: payload.recordBytes,
      scale: payload.scale,
      offset: payload.offset,
      extras
    },
    issues
  };
}

function decodePoint({bytes, byteOffset, ordinal, layout, delivery, block, blockSha256}) {
  const x = bytes.readInt32LE(byteOffset);
  const y = bytes.readInt32LE(byteOffset + 4);
  const z = bytes.readInt32LE(byteOffset + 8);
  const flags = bytes.readUInt8(byteOffset + 15);
  const extras = {};
  for (const extra of layout.extras) {
    const raw = extra.read(bytes, byteOffset + extra.offset);
    extras[extra.name] = extra.missing !== undefined && raw === extra.missing
      ? {value: null, unit: extra.unit, reason: 'source-missing'}
      : {value: raw, unit: extra.unit};
  }
  const pointId = `${delivery}/${block.id}/${ordinal}`;
  return {
    id: pointId,
    pointId,
    delivery,
    block: block.id,
    blockSha256,
    generation: layout.generation,
    ordinal,
    byteOffset,
    byteLength: layout.recordBytes,
    xyz: [
      x * layout.scale[0] + layout.offset[0],
      y * layout.scale[1] + layout.offset[1],
      z * layout.scale[2] + layout.offset[2]
    ],
    intensity: bytes.readUInt16LE(byteOffset + 12),
    classification: bytes.readUInt8(byteOffset + 14),
    flags,
    withheld: (flags & 1) === 1,
    extras
  };
}

/**
 * 领取并解释一次 source 交付。所有缺口都收进 issues，由调用方决定是否落库；
 * 返回的 complete 只在本轮领取和解释没有未决缺口时为 true。
 */
export async function collectSource({transport}) {
  const records = [];
  const issues = [];
  let complete = true;

  const survey = await fetchJson(transport, '/survey', 'survey', issues);
  if (survey === NOT_RECEIVED) return {records, complete: false, issues};
  if (!isObject(survey)) {
    issues.push({code: 'survey-invalid', message: 'survey 不是对象'});
    return {records, complete: false, issues};
  }

  if (!nonEmptyString(survey.delivery)) {
    issues.push({code: 'survey-invalid-delivery', message: 'survey 缺少有效 delivery'});
    return {records, complete: false, issues};
  }
  const delivery = survey.delivery;

  const layoutLink = nonEmptyString(survey.layout) ? survey.layout : null;
  if (!layoutLink) {
    issues.push({code: 'survey-invalid-layout-link', url: resolveHref(transport.origin, '/survey'), message: 'survey 缺少布局链接'});
    complete = false;
  }

  if (!Array.isArray(survey.blocks)) {
    issues.push({code: 'survey-invalid-blocks', message: 'survey 缺少块目录数组'});
    complete = false;
  }
  if (survey.sealed !== true) {
    issues.push({code: 'delivery-not-sealed', sealed: survey.sealed, message: '来源未封存该次交付，目录可能仍会变化'});
    complete = false;
  }

  const blocks = [];
  const seenHrefs = new Set();
  for (const [index, link] of (Array.isArray(survey.blocks) ? survey.blocks : []).entries()) {
    if (!nonEmptyString(link)) {
      issues.push({code: 'block-link-invalid', blockIndex: index, message: '块目录条目不是有效链接'});
      complete = false;
      continue;
    }
    const href = resolveHref(transport.origin, link);
    let parsed;
    try {
      parsed = new URL(href);
    } catch {
      issues.push({code: 'block-link-invalid', blockIndex: index, url: href, message: '块链接无法解析'});
      complete = false;
      continue;
    }
    if (parsed.origin !== transport.origin) {
      issues.push({code: 'block-link-cross-origin', blockIndex: index, url: href, message: '块链接越过来源 origin，未访问'});
      complete = false;
      continue;
    }
    if (seenHrefs.has(href)) continue;
    seenHrefs.add(href);
    const id = blockIdFromHref(href);
    if (!id) {
      issues.push({code: 'block-link-invalid', blockIndex: index, url: href, message: '块链接无法得到块标识'});
      complete = false;
      continue;
    }
    blocks.push({id, href, link});
  }

  let layout = null;
  if (layoutLink) {
    const payload = await fetchJson(transport, layoutLink, 'layout', issues);
    if (payload !== NOT_RECEIVED) {
      const validated = validateLayout(payload);
      if (validated.issues.length) {
        issues.push(...validated.issues.map(item => ({...item, url: resolveHref(transport.origin, layoutLink)})));
      } else {
        layout = validated.layout;
      }
    }
  }

  if (!layout) {
    complete = false;
    return {records, complete, issues};
  }

  // 没有布局就不能安全解释块；有布局则逐块领取，块间互不借用版本。
  const seenPointIds = new Set();
  for (const block of blocks) {
    let response;
    try {
      response = await transport.request(block.link);
    } catch (error) {
      issues.push({code: 'block-unavailable', url: block.href, block: block.id, message: `块无法领取：${error.message}`});
      complete = false;
      continue;
    }
    if (!response.ok) {
      issues.push({code: 'block-status', url: block.href, block: block.id, status: response.status, message: `块返回 HTTP ${response.status}`});
      complete = false;
      continue;
    }
    const inheritedGeneration = response.headers.get('x-generation');
    if (!nonEmptyString(inheritedGeneration)) {
      issues.push({code: 'block-generation-missing', url: block.href, block: block.id, expectedGeneration: layout.generation, message: '块响应未声明 X-Generation，无法与布局对齐'});
      complete = false;
      continue;
    }
    if (inheritedGeneration !== layout.generation) {
      issues.push({
        code: 'block-generation-mismatch', url: block.href, block: block.id,
        expectedGeneration: layout.generation, generation: inheritedGeneration,
        message: '块属于另一版布局，未按本次布局解释'
      });
      complete = false;
      continue;
    }
    const bytes = response.bytes;
    const remainder = bytes.length % layout.recordBytes;
    if (remainder !== 0) {
      issues.push({
        code: 'block-truncated', url: block.href, block: block.id, generation: layout.generation,
        byteLength: bytes.length, recordBytes: layout.recordBytes, remainderBytes: remainder,
        completeByteLength: bytes.length - remainder,
        message: '块长度不是 recordBytes 整数倍，未提交该块的点记录'
      });
      complete = false;
      continue;
    }
    const count = bytes.length / layout.recordBytes;
    const blockSha256 = createHash('sha256').update(bytes).digest('hex');
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const byteOffset = ordinal * layout.recordBytes;
      const pointId = `${delivery}/${block.id}/${ordinal}`;
      if (seenPointIds.has(pointId)) {
        issues.push({code: 'point-id-duplicate', url: block.href, block: block.id, ordinal, pointId, message: '块目录产生重复点标识'});
        complete = false;
        continue;
      }
      seenPointIds.add(pointId);
      records.push(decodePoint({bytes, byteOffset, ordinal, layout, delivery, block, blockSha256}));
    }
  }

  return {records, complete, issues};
}
