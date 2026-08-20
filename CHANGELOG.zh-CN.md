# 更新日志（Changelog）

本项目所有重要变更均记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]（未发布）

## [0.1.5] - 2026-08-20

### 修复

- **`web_search_engine` 工具导致 dsh web 加载即崩（502）。** 工具定义中引用了
  重构时改名前的变量 `presentResult`（现为 `presentSearchResult`），导致插件
  加载时抛出 `presentResult is not defined`。
- **工具输出 schema 被 DSH 引擎拒绝（`UNSUPPORTED_SCHEMA`）。** 输出 JSON
  schema 在 string/array/boolean 属性上使用了 `required: true`；DSH 仅接受
  对象级的 `required: [...]` 数组。已改为对象级 `required: ['sources', 'truncated']`
  （根对象）与 `required: ['url']`（来源项）。

### 新增

- 回归测试（`tests/test-p0-tool.mjs`）：驱动插件注册并对 mock ctx 校验，
  并用真实的 `@deepseek-ai/dsh-tools` schema 校验器验证输出 schema。
- `CHANGELOG.md` / `CHANGELOG.zh-CN.md`。

### 变更

- 将 `test` 拆分为按套件执行的脚本（`test:p0`、`test:p1`、`test:p2`），并新增
  标准 `prepublishOnly` 钩子：`npm publish` 前自动运行离线测试套件。

## [0.1.4] - 2026-08-20

### 变更

- 强制国内引擎（bing、baidu、sogou、360）与私有 SearXNG 实例直连；代理仅应用于
  全球引擎（google、duckduckgo、mojeek）。

## [0.1.3] - 2026-08-20

### 新增

- 分层搜索：searxng / 全球 / 国内 三层，层内引擎并行、结果合并；某层无结果时
  自动降级到下一层。

## [0.1.2] - 2026-08-20

### 新增

- `web_search_engine` 工具：允许模型在单次调用中指定搜索引擎（`engine` 或有序
  `engines`），同时支持请求级覆盖。

## [0.1.1] - 2026-08-20

### 新增

- Google 引擎、`publishedAt` 对齐、按代理门控跳过；测试拆分为 P0/P1/P2。

## [0.1.0] - 2026-08-17

### 新增

- 首个版本：面向 dsh `ctx.web` 无缝集成的免密钥多引擎网页搜索 + 页面抓取
  Provider（无 DeepSeek 依赖），并支持自动代理解析。

[Unreleased]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gausszhou/dsh-web-search-local/releases/tag/v0.1.0
