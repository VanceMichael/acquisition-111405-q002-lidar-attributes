// 分块点云领取：按本次交付自己声明的布局解释坐标、分类标记与扩展属性。
//
// 关键取舍（与 docs/source-contract.md 对齐）：
// * 只用本次交付声明的字段解释字节；未声明的字段与类型一律不猜。
// * 块代次（X-Generation）必须与布局 generation 相同，否则该块的字节拒绝解释，
//   不会把不同版本的点拼进同一份结果，更不会在此之上宣称领取成功。
// * 目录、布局、块任一环节未发布/不可用/被截断时，只保留可安全解释的部分，
//   并令 complete=false，绝不宣称领取完整。
// * 每个点保留来源交付、块标识、块摘要与块内字节范围，便于逐点回溯。

import {createHash} from 'node:crypto';

const HEADER_BYTES = 16;
const DEFAULT_RECORD_BYTES = 18;
// recordBytes=18 的默认扩展：u16 temperature，65535 为缺失，0 为有效值。
const DEFAULT_EXTRAS = Object.freeze([
  Object.freeze({name: 'temperature', offset: 16, type: 'u16', unit: 'degC', missing: 65535}),
]);
const TYPE_WIDTH = Object.freeze({u16: 2, i16: 2});
const TYPE_RANGE = Object.freeze({u16: [0, 0xffff], i16: [-0x8000, 0x7fff]});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTriple = value => Array.isArray(value) && value.length === 3
  && value.every(item => typeof item === 'number' && Number.isFinite(item));

function note(code, url, message, details = {}) {
  return {code, url, message, ...details};
}

// 相对链接一律基于来源 origin 解析；越界链接只登记问题，不发请求。
function sourceUrl(transport, reference, role, issues) {
  if (typeof reference !== 'string' || !reference.trim()) {
    issues.push(note('source-link-missing', transport.origin, `交付目录缺少可用的${role}链接`));
    return null;
  }
  let url;
  try {
    url = new URL(reference, transport.origin);
  } catch {
    issues.push(note('source-link-invalid', transport.origin, `${role}链接不是有效地址：${reference}`));
    return null;
  }
  if (url.origin !== transport.origin) {
    issues.push(note('source-link-out-of-scope', transport.origin, `${role}链接指向来源以外的站点：${reference}`));
    return null;
  }
  return url.href;
}

function blockIdentifier(href, index) {
  const segment = new URL(href).pathname.split('/').filter(Boolean).pop();
  if (segment) {
    try { return decodeURIComponent(segment); }
    catch { return segment; }
  }
  return `block-${index}`;
}

// 把布局 JSON 解释成明确的字段字典。坐标映射无法确定时返回 null：
// 宁可报告未决，也不按默认布局臆测坐标与原点。
function interpretLayout(payload, url, issues) {
  if (!isObject(payload)) {
    issues.push(note('layout-invalid', url, '布局不是对象'));
    return null;
  }
  const {generation} = payload;
  if (typeof generation !== 'string' || !generation.trim()) {
    issues.push(note('layout-invalid', url, '布局缺少generation，无法确认本次交付的版本'));
    return null;
  }
  const recordBytes = payload.recordBytes ?? DEFAULT_RECORD_BYTES;
  if (!Number.isInteger(recordBytes) || recordBytes < HEADER_BYTES) {
    issues.push(note('layout-invalid', url, `recordBytes必须是不小于${HEADER_BYTES}的整数`, {generation}));
    return null;
  }
  if (payload.littleEndian !== true) {
    issues.push(note('layout-invalid', url, '只实现littleEndian=true声明的小端布局', {generation}));
    return null;
  }
  if (!isTriple(payload.scale)) {
    issues.push(note('layout-invalid', url, 'scale必须是三个有限数', {generation}));
    return null;
  }
  if (!isTriple(payload.offset)) {
    issues.push(note('layout-invalid', url, 'offset必须是三个有限数', {generation}));
    return null;
  }

  const declared = payload.extras;
  if (declared !== undefined && !Array.isArray(declared)) {
    issues.push(note('layout-invalid', url, 'extras必须是数组', {generation}));
    return null;
  }
  // recordBytes=18 的默认扩展是u16 temperature；extras 缺省或为空时套用该默认，
  // 只有显式列出条目时才完全按声明解释。
  const list = declared === undefined || declared.length === 0
    ? (recordBytes === DEFAULT_RECORD_BYTES ? DEFAULT_EXTRAS : [])
    : declared;

  const extras = [];
  const names = new Set();
  for (const [index, entry] of list.entries()) {
    const where = {generation, extraIndex: index};
    if (!isObject(entry)) {
      issues.push(note('extra-invalid', url, '扩展属性条目不是对象', where));
      continue;
    }
    const {name, type, offset, unit} = entry;
    if (typeof name !== 'string' || !name.trim()) {
      issues.push(note('extra-invalid', url, '扩展属性缺少名称', where));
      continue;
    }
    if (names.has(name)) {
      issues.push(note('extra-invalid', url, `扩展属性名称重复：${name}`, {...where, name}));
      continue;
    }
    if (!Object.hasOwn(TYPE_WIDTH, type)) {
      // 未声明的类型不解释成业务事实，只留下未决问题。
      issues.push(note('extra-type-unsupported', url, `未支持的扩展属性类型：${String(type)}`, {...where, name}));
      continue;
    }
    const width = TYPE_WIDTH[type];
    if (!Number.isInteger(offset) || offset < HEADER_BYTES || offset + width > recordBytes) {
      issues.push(note('extra-invalid', url, `扩展属性${name}的offset越出记录范围`, {...where, name, offset}));
      continue;
    }
    let unitValue = null;
    if (unit !== undefined && unit !== null) {
      if (typeof unit !== 'string' || !unit.trim()) {
        issues.push(note('extra-invalid', url, `扩展属性${name}的unit不是有效字符串`, {...where, name}));
        continue;
      }
      unitValue = unit;
    }
    let missing = null;
    if (entry.missing !== undefined && entry.missing !== null) {
      const [minimum, maximum] = TYPE_RANGE[type];
      if (!Number.isInteger(entry.missing) || entry.missing < minimum || entry.missing > maximum) {
        issues.push(note('extra-invalid', url, `扩展属性${name}的missing超出${type}范围`, {...where, name}));
        continue;
      }
      missing = entry.missing;
    }
    names.add(name);
    extras.push({name, type, offset, width, unit: unitValue, missing});
  }

  extras.sort((left, right) => left.offset - right.offset);
  const kept = [];
  for (const extra of extras) {
    if (kept.some(previous => extra.offset < previous.offset + previous.width)) {
      issues.push(note('extra-invalid', url, `扩展属性${extra.name}与其他条目字节范围重叠`, {generation, name: extra.name}));
      continue;
    }
    kept.push(extra);
  }

  // 记录里每一字节都应有声明来源；出现未解释的字节说明属性说明尚未发布完整。
  let cursor = HEADER_BYTES;
  const unexplained = [];
  for (const extra of kept) {
    if (extra.offset > cursor) unexplained.push({offset: cursor, length: extra.offset - cursor});
    cursor = Math.max(cursor, extra.offset + extra.width);
  }
  if (cursor < recordBytes) unexplained.push({offset: cursor, length: recordBytes - cursor});
  if (unexplained.length) {
    issues.push(note('layout-unexplained-bytes', url, '布局未解释记录中的全部字节', {
      generation, recordBytes, unexplained,
    }));
  }

  return {
    generation,
    recordBytes,
    littleEndian: true,
    scale: [...payload.scale],
    offset: [...payload.offset],
    extras: kept,
  };
}

function readExtra(record, extra) {
  const raw = extra.type === 'u16'
    ? record.readUInt16LE(extra.offset)
    : record.readInt16LE(extra.offset);
  if (extra.missing !== null && raw === extra.missing) {
    return {value: null, unit: extra.unit, reason: 'source-missing'};
  }
  return {value: raw, unit: extra.unit};
}

function decodeBlock({bytes, blockId, blockUrl, blockDigest, delivery, layout, issues}) {
  if (bytes.length % layout.recordBytes !== 0) {
    // 截断块：不得提交该块的正常点记录，只保留原文证据与可复核的缺口。
    issues.push(note('block-truncated', blockUrl, '块长不是recordBytes的整数倍', {
      delivery, block: blockId, generation: layout.generation,
      recordBytes: layout.recordBytes, bytes: bytes.length,
    }));
    return [];
  }
  const count = bytes.length / layout.recordBytes;
  const records = [];
  for (let ordinal = 0; ordinal < count; ordinal++) {
    const byteOffset = ordinal * layout.recordBytes;
    const record = bytes.subarray(byteOffset, byteOffset + layout.recordBytes);
    const rawX = record.readInt32LE(0);
    const rawY = record.readInt32LE(4);
    const rawZ = record.readInt32LE(8);
    const intensity = record.readUInt16LE(12);
    const classification = record.readUInt8(14);
    const flags = record.readUInt8(15);
    const withheld = (flags & 0b1) === 1;
    const extras = {};
    for (const extra of layout.extras) extras[extra.name] = readExtra(record, extra);
    const pointId = `${delivery}/${blockId}/${ordinal}`;
    records.push({
      id: pointId,
      pointId,
      delivery,
      block: blockId,
      ordinal,
      xyz: [
        rawX * layout.scale[0] + layout.offset[0],
        rawY * layout.scale[1] + layout.offset[1],
        rawZ * layout.scale[2] + layout.offset[2],
      ],
      raw: {x: rawX, y: rawY, z: rawZ},
      intensity,
      classification,
      flags,
      // withheld 只是标记，不代表删除：点仍作为记录保留。
      withheld,
      extras,
      byteOffset,
      byteLength: layout.recordBytes,
      layoutGeneration: layout.generation,
      // 逐点回溯：来自哪次交付、哪个块、块的原文摘要与块内字节范围。
      source: {
        delivery, block: blockId, layoutGeneration: layout.generation,
        blockUrl, blockSha256: blockDigest, byteOffset, byteLength: layout.recordBytes,
      },
    });
  }
  return records;
}

export async function collectSource({transport, archive}) {
  const issues = [];
  const records = [];
  let delivery = null;
  let layout = null;
  let sealed = false;

  const finalize = async extra => {
    const result = {
      delivery,
      layoutGeneration: layout?.generation ?? null,
      sealed,
      records,
      complete: sealed && issues.length === 0,
      issues,
      evidenceCount: transport.exchanges.length,
      ...extra,
    };
    // 未决时的结果也要落库：已收的安全独立部分与问题都保留给复核。
    await archive.commit({records, exchanges: transport.exchanges, issues});
    return result;
  };

  function requestOrIssue(href, code, role) {
    return transport.request(href).catch(error => {
      issues.push(note(code, href, error.message, {role}));
      return null;
    });
  }

  const surveyUrl = sourceUrl(transport, '/survey', '交付目录', issues);
  if (!surveyUrl) return finalize();

  const surveyResponse = await requestOrIssue(surveyUrl, 'survey-request-failed', '交付目录');
  if (!surveyResponse) return finalize();
  if (!surveyResponse.ok) {
    issues.push(note('survey-unavailable', surveyUrl, `交付目录响应${surveyResponse.status}`, {
      status: surveyResponse.status,
    }));
    return finalize();
  }

  let survey;
  try { survey = surveyResponse.json(); }
  catch {
    issues.push(note('survey-invalid', surveyUrl, '交付目录不是有效JSON'));
    return finalize();
  }
  if (!isObject(survey)) {
    issues.push(note('survey-invalid', surveyUrl, '交付目录不是对象'));
    return finalize();
  }

  if (typeof survey.delivery === 'string' && survey.delivery.trim()) delivery = survey.delivery;
  else issues.push(note('survey-invalid', surveyUrl, '交付目录缺少delivery标识'));

  // 未 sealed 说明目录可能仍在发布：已收部分照常解释，但不宣称完整。
  sealed = survey.sealed === true;
  if (!sealed) {
    issues.push(note('survey-unsealed', surveyUrl, '来源未声明sealed=true，目录可能仍在发布', {delivery}));
  }

  const layoutUrl = sourceUrl(transport, survey.layout, '布局', issues);
  if (layoutUrl) {
    const layoutResponse = await requestOrIssue(layoutUrl, 'layout-request-failed', '布局');
    if (!layoutResponse) {
      // 已登记问题，继续走后续的完整性判定。
    } else if (!layoutResponse.ok) {
      issues.push(note('layout-unavailable', layoutUrl, `布局响应${layoutResponse.status}`, {
        delivery, status: layoutResponse.status,
      }));
    } else {
      let payload;
      try { payload = layoutResponse.json(); }
      catch {
        issues.push(note('layout-invalid', layoutUrl, '布局不是有效JSON', {delivery}));
        payload = undefined;
      }
      if (payload !== undefined) layout = interpretLayout(payload, layoutUrl, issues);
    }
  }

  if (!Array.isArray(survey.blocks)) {
    issues.push(note('survey-invalid', surveyUrl, '交付目录缺少blocks数组', {delivery}));
  } else if (layout && survey.blocks.length > 0) {
    // 没有可确认的布局就不解释块字节：坐标、分类与扩展属性都无从对应。
    const seen = new Set();
    for (const [index, reference] of survey.blocks.entries()) {
      const blockUrl = sourceUrl(transport, reference, '分块', issues);
      if (!blockUrl || seen.has(blockUrl)) continue;
      seen.add(blockUrl);
      const blockId = blockIdentifier(blockUrl, index);

      const response = await requestOrIssue(blockUrl, 'block-request-failed', '分块');
      if (!response) continue;
      if (!response.ok) {
        issues.push(note('block-unavailable', blockUrl, `分块响应${response.status}`, {
          delivery, block: blockId, status: response.status,
        }));
        continue;
      }
      const generation = response.headers.get('x-generation');
      if (generation !== layout.generation) {
        // 代次不一致即另一版本布局：拒绝解释该块，绝不与本次交付的点混拼。
        issues.push(note('block-generation-mismatch', blockUrl, '分块代次与布局generation不一致', {
          delivery, block: blockId, generation: generation ?? null, expected: layout.generation,
        }));
        continue;
      }
      const blockDigest = createHash('sha256').update(response.bytes).digest('hex');
      records.push(...decodeBlock({
        bytes: response.bytes, blockId, blockUrl, blockDigest, delivery, layout, issues,
      }));
    }
  }

  // sealed=true 且分块合法但为空，属于与缺数据相区分的空有效结果：
  // 没有缺块、没有未决解释，records=[] 且 complete=true。

  return finalize();
}
