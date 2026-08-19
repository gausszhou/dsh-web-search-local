# dsh-web-search-local

为 [DeepSeek Harness](https://www.deepseek.com/harness/)（dsh）`ctx.web` 接口提供的**无密钥多引擎网页搜索与抓取 provider**。适用于**任何模型后端——包括完全本地模型**，**无需 API Key，也不依赖 DeepSeek 的服务端搜索**。

[![npm 版本](https://img.shields.io/npm/v/@gausszhou/dsh-web-search-local.svg)](https://www.npmjs.com/package/@gausszhou/dsh-web-search-local)
[![npm 月下载量](https://img.shields.io/npm/dm/@gausszhou/dsh-web-search-local.svg)](https://www.npmjs.com/package/@gausszhou/dsh-web-search-local)
[![累计下载量](https://img.shields.io/npm/dt/@gausszhou/dsh-web-search-local.svg)](https://www.npmjs.com/package/@gausszhou/dsh-web-search-local)
[![开源协议](https://img.shields.io/npm/l/@gausszhou/dsh-web-search-local.svg)](./LICENSE)

## 为什么需要它

dsh 内置的 `web_search` 工具与模型无关：它只调用 `ctx.web.search()`。依赖 DeepSeek 的是它的*默认搜索 provider*（`dsh-web-search-deepseek`），该 provider 会把每次查询带上 `DEEPSEEK_API_KEY` 发给 DeepSeek 的 `web_search_20250305` 服务端工具。一旦切换到本地模型（如 Ollama），这个 provider 没有 key，搜索就失效了。

本包注册两个由插件自己发 HTTP 请求的 provider：

| provider id | 能力 | 引擎 |
| --- | --- | --- |
| `local-multi` | `web_search` | 三层顺序执行——SearXNG（配置时）→ Google/DuckDuckGo/Mojeek（国外层）→ Bing/Baidu/Sogou/360（国内层）；**同层引擎并行请求**并 **round-robin 合并结果**；一层无结果则降级到下一层 |
| `local-fetch` | `web_fetch` | 直接 GET，字符集感知解码（含 gbk），返回 html/text 正文 |

## 代理 / VPN 支持

Node 进程**不会**自动使用操作系统/浏览器的代理。如果 DuckDuckGo 等引擎在你的网络环境下不可达，provider 会自动解析代理：

1. `proxyUrl` 配置（显式指定，或设为 `'off'` 强制直连）
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量
3. 探测常见本地 HTTP 代理端口（`7890` Clash、`7897`、`10809` v2rayN、`1080`、……）

之后每个请求都会走代理（https 用 CONNECT 隧道，http 用绝对形式）。如果隧道在传输层挂掉，请求会回退为直连——这样即使 VPN 掉线，Bing/Baidu 依然可用。

## 安装

### 通过 npm

> 已发布至 [npm registry](https://www.npmjs.com/package/@gausszhou/dsh-web-search-local)。

```bash
npm install @gausszhou/dsh-web-search-local
```

然后在你的 profile 的 `cordis.patch.yml`（web profile 即 `$DSH_HOME/profiles/web/cordis.patch.yml`）中加入：

```yaml
- id: web
  config:
    searchProvider: local-multi
    fetchProvider: local-fetch

- id: web-search-deepseek
  disabled: true

- insert:
    - id: web-search-local
      name: '@gausszhou/dsh-web-search-local'
      config:
        engines: [searxng, google, duckduckgo, mojeek, bing, baidu, sogou, 360]
```

### 本地目录 / 文件路径

把本包放到 dsh 进程可读的任意位置，例如 `$DSH_HOME/profiles/web/plugins/web-search-local/`（Windows：`C:\Users\<you>\.dsh\profiles\web\plugins\web-search-local\`）。然后在你的 profile 的 `cordis.patch.yml`（web profile 即 `$DSH_HOME/profiles/web/cordis.patch.yml`）中加入：

```yaml
- id: web
  config:
    searchProvider: local-multi
    fetchProvider: local-fetch

- id: web-search-deepseek
  disabled: true

- insert:
    - id: web-search-local
      name: 'file:///C:/Users/<you>/.dsh/profiles/web/plugins/web-search-local/index.js'
      config:
        engines: [searxng, google, duckduckgo, mojeek, bing, baidu, sogou, 360]
```

3. 重启 dsh。`web_search` 现在返回纯来源列表（无服务端摘要），且适用于任何模型。

## 配置

```yaml
config:
  engines: [searxng, google, duckduckgo, mojeek, bing, baidu, sogou, 360]  # 成员列表（执行按层：searxng → 国外 → 国内，层内并行）
  skipWithoutProxy: [google, duckduckgo, mojeek] # 无代理时直接跳过的引擎（[] = 总是尝试）
  searxngBaseUrl: 'http://127.0.0.1:8080'   # 可选；设置后优先执行
  proxyUrl: ''                              # '' 自动 | 'off' 直连 | 'http://host:port' 显式指定
  searchTimeoutMs: 12000
  fetchTimeoutMs: 20000
  maxFetchBytes: 1048576
  maxSources: 12
  cacheTtlMs: 300000                        # 内存结果缓存
  engineMinIntervalMs: 1500                 # 引擎请求最小间隔（防限流）
  engineCooldownMs: 600000                  # 验证墙/验证码后熔断冷却（0 = 关闭）
  engineRetryCooldownMs: 60000              # 普通失败后冷却（0 = 关闭）
  userAgent: '<浏览器风格的 UA>'
```

默认引擎列表**分三层、按序执行，同层引擎并行请求并合并**：

1. **searxng**——配置了 `searxngBaseUrl` 的私有 SearXNG 实例本身就是元搜索聚合，有结果就直接返回，跳过下面两层
2. **国外层**——Google、DuckDuckGo、Mojeek（大陆需要代理；无代理时整体直接跳过，见 `skipWithoutProxy`）
3. **国内层**——Bing、Baidu、Sogou、360（直连可用，无需 VPN/代理）

一层无结果（空、被墙或跳过的引擎）就降级到下一层，所以国外层永远不会拖垮可直连的国内层。`google` 引擎易被反爬（consent 墙、`sorry/` 机器人检测、`enablejs` JS 墙）；要稳定拿到 Google 结果，使用启用了 google 引擎的 SearXNG 实例。在开放网络（全球引擎可直连）上，把 `skipWithoutProxy` 设为 `[]`。

私有 [SearXNG](https://docs.searxng.org/) 实例（Docker：`docker run -p 8080:8080 searxng/searxng`）是所有引擎中最稳健的：元搜索聚合、JSON API、无需逐引擎爬取。

## 限流韧性

搜索引擎（尤其是 DuckDuckGo）会限流脚本。以下三个机制让单引擎配置也能稳定使用：

- **节流**——按引擎计：同一引擎在 `engineMinIntervalMs` 内不会被调用两次（防限流），同层不同引擎则一起启动。
- **熔断**——引擎出现机器人墙（`blocked by captcha` / `anomaly check` / 百度的 `verification wall`，或 HTTP 403/429）时，在 `engineCooldownMs`（默认 10 分钟）内跳过；普通失败（传输、HTTP 错误）只触发更短的 `engineRetryCooldownMs`（默认 60 秒）。冷却期间引擎被跳过，原因会聚合进错误信息。
- **DuckDuckGo lite 兜底**——`html.duckduckgo.com` 端点被机器人墙拦截时，同一查询会改走 `lite.duckduckgo.com/lite/` 重试一次（该端点对脚本更宽容）。若 lite 端点也被墙，引擎会报告 `blocked by anomaly check (html and lite)` 并触发长冷却 `engineCooldownMs`，而不是每次搜索都反复冲击两个端点。

被墙的引擎不会让整个搜索失败（前提是还有其他引擎）；单引擎模式下会快速失败并给出 "cooling down" 原因，而不是反复冲击被墙端点。

## 模型指定引擎

模型可以在每次搜索时指定用哪个引擎，两种途径：

1. **工具**——在官方 `web_search` 之外，本插件注册了 `web_search_engine`，带两个可选参数：
   - `engine`：单个引擎——`searxng`、`google`、`duckduckgo`、`mojeek`、`bing`、`baidu`、`sogou`、`360`
   - `engines`：有序的引擎优先级列表
   两者都不传时，调用降级为配置的默认三层引擎链，与 `web_search` 完全一致。
2. **provider 请求**——任何直接调用 `ctx.web.search({ query, engine })` 或 `ctx.web.search({ query, engines })` 的调用方都获得同样的覆盖；未知引擎名会抛 `WEB_PROVIDER_ERROR` 并列出合法 id。

显式覆盖会**完全替换**配置的引擎链（包括 SearXNG 自动前置）——模型的明确选择优先。指定的引擎同样按 searxng / 国外 / 国内三层分组、层内并行合并（与默认链一致）；只指定一个引擎就是单跑。节奏控制、熔断和 `skipWithoutProxy` 对指定引擎同样生效，所以指定了但不可达的引擎会快速失败，而不会拖垮整个搜索。

## 回退到 DeepSeek 搜索

从 `cordis.patch.yml` 中移除 `web` 覆盖项、`web-search-deepseek` 禁用项以及插入的那一行即可。

## 注意事项

- 引擎靠正则抓取纯 HTML；上游改版可能导致某个引擎失效——链路会自动落到下一个引擎。所有引擎的错误会聚合进抛出的异常信息。搜狗的 `/link?url=` 加密跳转会在服务端解析（跳转页正文内嵌真实地址）；360 的跳转链接在锚点的 `data-mdurl` 属性里直接暴露真实地址，解析器直接读取。
- `google` 引擎用双布局解析器抓取 HTML 结果页（基础 `gbv=1` 标记与现代 JS 时代标记），并发送 CONSENT/SOCS Cookie 绕过欧盟 consent 墙。Google 经常对脚本返回"需要启用 JavaScript"墙（`/httpservice/retry/enablejs`）或 `sorry/` 验证码而不是结果——两者都会被检测并触发长熔断冷却（带明确原因），国外层随即降级到国内层。要稳定拿到 Google 结果，使用启用了 google 引擎的 SearXNG 实例。
- 返回结构与官方 provider 一致：`web_search` 返回 `{ sources: [{ url, title?, snippet?, publishedAt? }], truncated }`。层内引擎并行请求，来源**round-robin 合并、去重、截断到 `maxSources` 条**（合并结果超过上限时 `truncated` 置 true）；一层无结果则降级到下一层。`publishedAt` 是尽力而为的 `YYYY-MM-DD` 日期，当引擎页面出现日期时填充（SearXNG 的 `publishedDate`，或 Bing/Baidu/Sogou/360 结果块中的日期文本），否则省略该字段——与官方 `page_age` 相同的可选语义。
- 无第三方运行时依赖：只用 `fetch` + `node:http/https/net/tls`，外加 dsh 自带的 `@deepseek-ai/dsh-web`（以 `peerDependency` 声明；每个 dsh profile 都已内置）。
- 错误遵循 seam 的 provider 契约：失败时抛 `WebError`，code 为 `WEB_PROVIDER_ERROR`（引擎/传输/超时，引擎错误会聚合进 message）或 `WEB_ABORTED`（调用方取消）——与官方 provider 使用同一套错误词汇。
- `web_fetch` 需要 `tool-web` 的 `fetch: true`；自带的 `standard` agent 预设默认是 `fetch: false`——把预设复制到 `$DSH_HOME/.agent-presets/` 并在那里打开开关。

## 许可证

MIT
