# 来源与既有应用契约

## 新来源

GET /survey 返回 delivery、layout、blocks 和 sealed。GET layout 返回 generation、recordBytes、littleEndian=true、scale、offset、extras。每点前16字节依次为int32 x/y/z、uint16 intensity、uint8 classification、uint8 flags；flags bit0表示withheld，不表示删除。extras条目给出name、offset、type(u16/i16)、unit、missing；块为原始字节，块响应X-Generation必须与布局generation一致。GET /blocks/<id>可返回503，sealed=false或尚缺块时不可报告完整。recordBytes=18 的默认扩展值为u16 temperature，65535为缺失；零为有效值。记录pointId=<delivery>/<block>/<ordinal>、xyz、withheld、extras及byteOffset。 扩展缺失输出value=null并保留reason=source-missing；块长不是recordBytes整数倍属于截断，不得提交该块的正常点记录。

本地来源只实现以上明确子集，不要求补全同类公开标准。未声明的字段与语法不得自动解释成有效业务事实。样本中的所有人员、账户、样本、设备与文件内容均为合成资料，无生产访问凭据。

## 接收接口

既有调用是 `collect({baseUrl, archive, mode})`。`mode` 默认为 `legacy`；新增来源使用 `source`。返回 `{records, complete, issues, evidenceCount}`：`records` 为本次业务结果，`complete` 表示本次领取及解释是否有未决缺口，`issues` 为带来源位置的可复核问题，`evidenceCount` 为实际接收的原文数。新结果可增加字段，示例不是封闭 schema。

每个落库记录的 `id` 必须非空且稳定，由业务身份决定；业务所需的多身份关系不能都压缩进 `id`。`archive.commit` 接受 `records`、`exchanges` 与 `issues`；原文在 `raw/` 以 SHA-256 寻址，索引引用原文与记录修订。既有归档索引 schema=1 可以扩展，但旧摘要记录必须仍可读取。

应用不得伪造原文，也不能把摘要模式当成新来源成功。HTTP 相对链接基于来源 origin 解析，不能访问其他站点。错误状态、缺数据和空的有效结果应区分。来源解释未决时 `complete=false`，已收的安全独立部分可以保留。

## 可运行资料

`fixtures/scenarios.json` 提供来源响应及预期业务片段；`expected`/`forbidden` 只供回归断言，采集代码不得读取该文件。来源用真实 HTTP 发送数据，二进制夹具由 `$hex` 或 `$octets` 编码，接收方不会看到这些包装键。`/__requests` 是本地测试用请求审计接口，不是资料源。

连续相同 method/path 响应可按数组次序变化，最后一次响应保持；`after` 表达来源步骤先后，`once` 为单次凭证。POST 搜索会按来源能力拒绝不支持的条件。接收端不需要实现来源服务，也不得删改来源限制来通过测试。

上述契约和题面决定功能范围。公开回归提供正常与有冲突/缺口的样例，并未穷举所有组合；应补充与实际设计相符的边界验证。运行与演示不连接新闻站点或其他线上服务。

## 接收端解释规则（`src/source.mjs`）

一次 `source` 领取只使用本次交付的目录与布局，先读 `/survey`，再读该目录指向的布局，然后逐块领取。块与布局不会混用版本：块响应缺少 `X-Generation` 或与布局 `generation` 不一致时，整块不解释，并在 `issues` 留下 `block-generation-missing` / `block-generation-mismatch`。下一版原点或比例调整后重新领取，会按新布局重新生成记录修订，不复用上一版坐标。

每条点记录带 `pointId`（同时是稳定 `id`）、`delivery`、`block`、`blockSha256`、`generation`、`ordinal`、`byteOffset`、`byteLength`，可直接定位到原文块中的字节范围；`xyz` 已按本次布局的 `scale`/`offset` 换算，`withheld` 来自 flags bit0（扣留不等于删除），扩展输出 `{value, unit}`，缺失时 `value=null` 且 `reason=source-missing`。

会令 `complete=false` 的情形包括：`sealed` 不是 true、目录缺布局链接、布局字段非法或类型不在声明的子集内、扩展范围越界或重叠、块 503/不可领取、块 generation 不一致、块长不是 `recordBytes` 整数倍（截断时该块不提交任何点记录）。块目录与属性说明没有同时发布时，不猜测缺失的一半：没有布局就完全不解释块。已领取且相互独立的安全部分（其余块、布局原文、失败响应原文）仍会归档并保留下次复核依据；`issues` 的 `code`、`url`、`status` 等字段即复核位置。

布局未声明 `extras` 且 `recordBytes=18` 时套用契约里的默认 `temperature` 扩展；显式 `extras`（含空数组）按原样解释，不追加默认项。
