# dsh-web-search-local

为 [DeepSeek Harness](https://www.deepseek.com/harness/)（dsh）`ctx.web` 接口提供的**无密钥多引擎网页搜索与抓取 provider**。适用于**任何模型后端——包括完全本地模型**，**无需 API Key，也不依赖 DeepSeek 的服务端搜索**。

## 为什么需要它

dsh 内置的 `web_search` 工具与模型无关：它只调用 `ctx.web.search()`。依赖 DeepSeek 的是它的*默认搜索 provider*（`dsh-web-search-deepseek`），该 provider 会把每次查询带上 `DEEPSEEK_API_KEY` 发给 DeepSeek 的 `web_search_20250305` 服务端工具。一旦切换到本地模型（如 Ollama），这个 provider 没有 key，搜索就失效了。

本包注册两个由插件自己发 HTTP 请求的 provider：

| provider id | 能力 | 引擎 |
| --- | --- | --- |
| `local-multi` | `web_search` | SearXNG（可选，配置后优先执行）→ Bing → DuckDuckGo → Mojeek → Baidu；第一个出结果的引擎胜出 |
| `local-fetch` | `web_fetch` | 直接 GET，字符集感知解码（含 gbk），返回 html/text 正文 |

## 代理 / VPN 支持

Node 进程**不会**自动使用操作系统/浏览器的代理。如果 DuckDuckGo 等引擎在你的网络环境下不可达，provider 会自动解析代理：

1. `proxyUrl` 配置（显式指定，或设为 `'off'` 强制直连）
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量
3. 探测常见本地 HTTP 代理端口（`7890` Clash、`7897`、`10809` v2rayN、`1080`、……）

之后每个请求都会走代理（https 用 CONNECT 隧道，http 用绝对形式）。如果隧道在传输层挂掉，请求会回退为直连——这样即使 VPN 掉线，Bing/Baidu 依然可用。

## 安装

### 通过 npm（发布后推荐）

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
        engines: [bing, duckduckgo, mojeek, baidu]
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
        engines: [bing, duckduckgo, mojeek, baidu]
```

3. 重启 dsh。`web_search` 现在返回纯来源列表（无服务端摘要），且适用于任何模型。

## 配置

```yaml
config:
  engines: [bing, duckduckgo, mojeek, baidu]   # 优先级顺序
  searxngBaseUrl: 'http://127.0.0.1:8080'      # 可选；设置后优先执行
  proxyUrl: ''                                  # '' 自动 | 'off' 直连 | 'http://host:port' 显式指定
  searchTimeoutMs: 12000
  fetchTimeoutMs: 20000
  maxFetchBytes: 1048576
  maxSources: 12
  cacheTtlMs: 300000                            # 内存结果缓存
  engineMinIntervalMs: 1500                     # 引擎请求最小间隔（防限流）
  engineCooldownMs: 600000                      # 验证墙/验证码后熔断冷却（0 = 关闭）
  engineRetryCooldownMs: 60000                  # 普通失败后冷却（0 = 关闭）
  userAgent: '<浏览器风格的 UA>'
```

私有 [SearXNG](https://docs.searxng.org/) 实例（Docker：`docker run -p 8080:8080 searxng/searxng`）是所有引擎中最稳健的：元搜索聚合、JSON API、无需逐引擎爬取。

## 限流韧性

搜索引擎（尤其是 DuckDuckGo）会限流脚本。以下三个机制让单引擎配置也能稳定使用：

- **节流**——引擎调用串行化，每次间隔至少 `engineMinIntervalMs`，多引擎链不会猛打同一主机。
- **熔断**——引擎出现机器人墙（`blocked by captcha` / `anomaly check` / 百度的 `verification wall`，或 HTTP 403/429）时，在 `engineCooldownMs`（默认 10 分钟）内跳过；普通失败（传输、HTTP 错误）只触发更短的 `engineRetryCooldownMs`（默认 60 秒）。冷却期间引擎被跳过，原因会聚合进错误信息。
- **DuckDuckGo lite 兜底**——`html.duckduckgo.com` 端点被机器人墙拦截时，同一查询会改走 `lite.duckduckgo.com/lite/` 重试一次（该端点对脚本更宽容）。若 lite 端点也被墙，引擎会报告 `blocked by anomaly check (html and lite)` 并触发长冷却 `engineCooldownMs`，而不是每次搜索都反复冲击两个端点。

被墙的引擎不会让整个搜索失败（前提是还有其他引擎）；单引擎模式下会快速失败并给出 "cooling down" 原因，而不是反复冲击被墙端点。

## 回退到 DeepSeek 搜索

从 `cordis.patch.yml` 中移除 `web` 覆盖项、`web-search-deepseek` 禁用项以及插入的那一行即可。

## 注意事项

- 引擎靠正则抓取纯 HTML；上游改版可能导致某个引擎失效——链路会自动落到下一个引擎。所有引擎的错误会聚合进抛出的异常信息。
- 无第三方运行时依赖：只用 `fetch` + `node:http/https/net/tls`，外加 dsh 自带的 `@deepseek-ai/dsh-web`（以 `peerDependency` 声明；每个 dsh profile 都已内置）。
- 错误遵循 seam 的 provider 契约：失败时抛 `WebError`，code 为 `WEB_PROVIDER_ERROR`（引擎/传输/超时，引擎错误会聚合进 message）或 `WEB_ABORTED`（调用方取消）——与官方 provider 使用同一套错误词汇。
- `web_fetch` 需要 `tool-web` 的 `fetch: true`；自带的 `standard` agent 预设默认是 `fetch: false`——把预设复制到 `$DSH_HOME/.agent-presets/` 并在那里打开开关。

## 许可证

MIT
