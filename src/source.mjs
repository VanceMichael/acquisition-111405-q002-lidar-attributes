import {createTransport} from './transport.mjs';

// 规范化二进制子集：每点前 16 字节为 int32 x/y/z、uint16 intensity、
// uint8 classification、uint8 flags（bit0 = withheld，不表示删除），
// 之后是布局声明的扩展属性。仅支持 littleEndian=true 与 u16/i16 扩展。
const BASE_RECORD_BYTES = 16;

const EXTRA_TYPES = {
  u16: {size: 2, read: (bytes, offset) => bytes.readUInt16LE(offset)},
  i16: {size: 2, read: (bytes, offset) => bytes.readInt16LE(offset)}
};

function surveyProblems(survey) {
  if (!survey || typeof survey !== 'object' || Array.isArray(survey)) return ['交付目录不是可解析的对象'];
  const problems = [];
  if (typeof survey.delivery !== 'string' || !survey.delivery.trim()) problems.push('交付缺少有效的 delivery 标识');
  if (typeof survey.layout !== 'string' || !survey.layout) problems.push('交付缺少布局链接 layout');
  if (!Array.isArray(survey.blocks) || survey.blocks.some(item => typeof item !== 'string' || !item)) {
    problems.push('交付块目录 blocks 必须是字符串数组');
  }
  return problems;
}

function layoutProblems(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return ['属性说明不是可解析的对象'];
  const problems = [];
  if (typeof layout.generation !== 'string' || !layout.generation) problems.push('属性说明缺少世代标识 generation');
  if (!Number.isInteger(layout.recordBytes) || layout.recordBytes < BASE_RECORD_BYTES) {
    problems.push(`记录长度 recordBytes=${layout.recordBytes} 无效，至少容纳 ${BASE_RECORD_BYTES} 字节基础记录`);
  }
  if (layout.littleEndian !== true) problems.push('属性说明未声明 littleEndian=true，超出可解释的规范化子集');
  for (const key of ['scale', 'offset']) {
    const value = layout[key];
    if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
      problems.push(`属性说明 ${key} 必须是三个有限数`);
    }
  }
  if (!Array.isArray(layout.extras)) {
    problems.push('属性说明 extras 必须是数组');
  } else {
    const names = new Set();
    for (const extra of layout.extras) {
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
        problems.push('扩展属性条目不是对象');
        continue;
      }
      const named = typeof extra.name === 'string' && extra.name;
      const label = named ? extra.name : '(未命名)';
      if (!named) problems.push('扩展属性缺少名称');
      else if (names.has(label)) problems.push(`扩展属性名称重复：${label}`);
      else names.add(label);
      const size = EXTRA_TYPES[extra.type]?.size ?? 2;
      if (!Number.isInteger(extra.offset) || extra.offset < BASE_RECORD_BYTES
        || (Number.isInteger(layout.recordBytes) && extra.offset + size > layout.recordBytes)) {
        problems.push(`扩展属性 ${label} 偏移 ${extra.offset} 超出记录范围`);
      }
      if (!(extra.type in EXTRA_TYPES)) problems.push(`扩展属性 ${label} 类型不受支持：${extra.type}`);
      if ('unit' in extra && typeof extra.unit !== 'string') problems.push(`扩展属性 ${label} 的 unit 必须是字符串`);
      if ('missing' in extra && !Number.isFinite(extra.missing)) problems.push(`扩展属性 ${label} 的 missing 必须是有限数`);
    }
  }
  return problems;
}

function blockIdFromPath(path) {
  try {
    const {pathname} = new URL(path, 'http://source.invalid');
    const segments = pathname.split('/').filter(Boolean);
    return segments.length ? decodeURIComponent(segments[segments.length - 1]) : '';
  } catch {
    return '';
  }
}

function parseBlock({bytes, layout, delivery, blockId}) {
  const records = [];
  const count = Math.floor(bytes.length / layout.recordBytes);
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const byteOffset = ordinal * layout.recordBytes;
    const xyz = [0, 1, 2].map(axis => bytes.readInt32LE(byteOffset + axis * 4) * layout.scale[axis] + layout.offset[axis]);
    const extras = {};
    for (const extra of layout.extras) {
      const raw = EXTRA_TYPES[extra.type].read(bytes, byteOffset + extra.offset);
      const unit = typeof extra.unit === 'string' ? extra.unit : null;
      extras[extra.name] = Number.isFinite(extra.missing) && raw === extra.missing
        ? {value: null, unit, reason: 'source-missing'}
        : {value: raw, unit};
    }
    const pointId = `${delivery}/${blockId}/${ordinal}`;
    records.push({
      id: pointId,
      pointId,
      delivery,
      block: blockId,
      ordinal,
      generation: layout.generation,
      xyz,
      intensity: bytes.readUInt16LE(byteOffset + 12),
      classification: bytes.readUInt8(byteOffset + 14),
      withheld: Boolean(bytes.readUInt8(byteOffset + 15) & 1),
      extras,
      byteOffset,
      byteLength: layout.recordBytes
    });
  }
  return records;
}

// source 模式：领取交付目录、当次布局与分块点资料，按该次交付自己的布局解释。
// 任何未决缺口（未封存、缺块、世代不一致、截断、布局不可用）都使 complete=false，
// 已收的安全独立部分仍然保留并归档，绝不拼出跨版本点云再宣称领取成功。
export async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const records = [];
  const issues = [];
  let complete = true;
  const gap = (code, source, message, detail = {}) => {
    complete = false;
    issues.push({code, source, message, ...detail});
  };

  let survey = null;
  try {
    const response = await transport.request('/survey');
    if (!response.ok) gap('survey-unavailable', '/survey', `交付目录返回状态 ${response.status}`, {status: response.status});
    else survey = response.json();
  } catch (error) {
    gap('survey-unavailable', '/survey', `交付目录领取失败：${error.message}`);
  }
  const structuralProblems = survey ? surveyProblems(survey) : [];
  for (const problem of structuralProblems) gap('survey-invalid', '/survey', problem);
  const usableSurvey = survey && !structuralProblems.length ? survey : null;

  let layout = null;
  if (usableSurvey) {
    if (usableSurvey.sealed !== true) gap('delivery-unsealed', '/survey', '交付尚未封存（sealed!=true），点资料可能继续变化');
    try {
      const response = await transport.request(usableSurvey.layout);
      if (!response.ok) gap('layout-unavailable', usableSurvey.layout, `属性说明返回状态 ${response.status}`, {status: response.status});
      else layout = response.json();
    } catch (error) {
      gap('layout-unavailable', usableSurvey.layout, `属性说明领取失败：${error.message}`);
    }
  }
  const interpretationProblems = layout ? layoutProblems(layout) : [];
  for (const problem of interpretationProblems) gap('layout-invalid', usableSurvey.layout, problem);
  const usableLayout = layout && !interpretationProblems.length ? layout : null;

  if (usableSurvey && usableLayout) {
    const seen = new Set();
    for (const blockPath of usableSurvey.blocks) {
      if (seen.has(blockPath)) continue;
      seen.add(blockPath);
      let response;
      try {
        response = await transport.request(blockPath);
      } catch (error) {
        gap('block-unavailable', blockPath, `块领取失败：${error.message}`);
        continue;
      }
      if (!response.ok) {
        gap('block-unavailable', blockPath, `块返回状态 ${response.status}`, {status: response.status});
        continue;
      }
      const generation = response.headers.get('x-generation');
      if (generation !== usableLayout.generation) {
        gap('generation-mismatch', blockPath,
          `块世代 ${generation ?? '(缺失)'} 与布局世代 ${usableLayout.generation} 不一致，拒绝跨版本拼接`,
          {layoutGeneration: usableLayout.generation, blockGeneration: generation});
        continue;
      }
      const bytes = response.bytes;
      if (bytes.length % usableLayout.recordBytes !== 0) {
        gap('block-truncated', blockPath,
          `块长度 ${bytes.length} 不是记录长度 ${usableLayout.recordBytes} 的整数倍，按截断处理，整块不提交`,
          {byteLength: bytes.length, recordBytes: usableLayout.recordBytes});
        continue;
      }
      const blockId = blockIdFromPath(blockPath);
      if (!blockId) {
        gap('block-identity', blockPath, '无法从块链接解析块标识');
        continue;
      }
      records.push(...parseBlock({bytes, layout: usableLayout, delivery: usableSurvey.delivery, blockId}));
    }
  }

  await archive.commit({records, exchanges: transport.exchanges, issues});
  return {records, complete, issues, evidenceCount: transport.exchanges.length};
}
