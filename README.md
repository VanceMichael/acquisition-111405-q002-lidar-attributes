# 测绘点云的属性字典与分块资料领取

这是资料接收服务的独立工作副本。支持人工摘要（`legacy`）与测绘新来源（`source`）两条领取通路：新来源按每次交付自己的布局解释分块点资料，输出逐点坐标、分类标记、扣留状态、扩展属性及量纲，并记录每点来自哪个块、在块内的字节范围，可回溯到内容寻址的原文。新来源尚未解决缺块、跨版本或不完整目录时以 `complete=false` 和 `issues` 明确报告，不把部分结果说成成功。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是产品基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查；其中也包含 `test/source.test.mjs` 对新来源的边界验证（缺块、跨版本块、截断、未封存、空结果与错误状态、逐点字节范围可追溯）。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收，与基线一起通过。交付时执行 `npm run verify:complete` 一次跑完全部通路。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `attributes`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-lidar-attributes:local .
docker run --rm --network none acquisition-lidar-attributes:local
docker run --rm --network none acquisition-lidar-attributes:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑全部测试与摘要演示；`npm run demo:feature` 演示新来源的完整分块点资料领取。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；既有 `legacy` 模式保留，`source` 模式走新来源。
- `src/source.mjs` 负责新来源的目录、布局与分块解释，解释规则见 `docs/source-contract.md`。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分；`test/source.test.mjs` 补充边界验证。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
