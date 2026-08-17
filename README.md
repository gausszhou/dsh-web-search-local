# dsh-web-search-local

**English** | [简体中文](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/@gausszhou/dsh-web-search-local.svg)](https://www.npmjs.com/package/@gausszhou/dsh-web-search-local)
[![npm downloads](https://img.shields.io/npm/dm/@gausszhou/dsh-web-search-local.svg)](https://www.npmjs.com/package/@gausszhou/dsh-web-search-local)
[![total downloads](https://img.shields.io/npm/dt/@gausszhou/dsh-web-search-local.svg)](https://www.npmjs.com/package/@gausszhou/dsh-web-search-local)
[![license](https://img.shields.io/npm/l/@gausszhou/dsh-web-search-local.svg)](./LICENSE)

Keyless, multi-engine web search + page fetch providers for the [DeepSeek Harness](https://www.deepseek.com/harness/) (dsh) `ctx.web` seam. Works with **any model backend — including fully local models** — with **no API keys and no dependency on DeepSeek's server-side search**.

## Why

dsh's built-in `web_search` tool is model-agnostic: it only calls `ctx.web.search()`. What depends on DeepSeek is the *default search provider* (`dsh-web-search-deepseek`), which sends each query to DeepSeek's `web_search_20250305` server tool with `DEEPSEEK_API_KEY`. Switch to a local model (Ollama etc.) and that provider has no key, so search dies.

This package registers two providers that do the HTTP themselves:

| provider id | capability | engines |
| --- | --- | --- |
| `local-multi` | `web_search` | SearXNG (optional, runs first when configured) → Bing → Baidu → Sogou → 360; DuckDuckGo & Mojeek remain available for proxy-enabled networks; the first engine with results wins |
| `local-fetch` | `web_fetch` | direct GET, charset-aware decoding (incl. gbk), html/text bodies |

## Proxy / VPN support

A node process does **not** use the OS/browser proxy. If engines like DuckDuckGo are unreachable in your network, the provider resolves a proxy automatically:

1. `proxyUrl` config (explicit, or `'off'` to force direct)
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` environment variables
3. a probe of common local HTTP proxy ports (`7890` Clash, `7897`, `10809` v2rayN, `1080`, …)

Every request then goes through the proxy (CONNECT tunnel for https, absolute-form for http). If the tunnel dies at transport level, the request falls back to direct — so Bing/Baidu keep working even when the VPN is down.

## Install

### From npm

> Published on the [npm registry](https://www.npmjs.com/package/@gausszhou/dsh-web-search-local).

```bash
npm install @gausszhou/dsh-web-search-local
```

Then add to your profile's `cordis.patch.yml` (`$DSH_HOME/profiles/web/cordis.patch.yml` for the web profile):

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
        engines: [bing, baidu, sogou, 360]
```

### From a local checkout / file path

Put this package anywhere the dsh process can read, e.g. `$DSH_HOME/profiles/web/plugins/web-search-local/` (Windows: `C:\Users\<you>\.dsh\profiles\web\plugins\web-search-local\`). Add to your profile's `cordis.patch.yml` (`$DSH_HOME/profiles/web/cordis.patch.yml` for the web profile):

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
        engines: [bing, baidu, sogou, 360]
```

3. Restart dsh. `web_search` now returns plain source lists (no server-side summary) and works with any model.

## Configuration

```yaml
config:
  engines: [bing, baidu, sogou, 360]        # priority order (default = mainland-China friendly)
  searxngBaseUrl: 'http://127.0.0.1:8080'   # optional; runs first when set
  proxyUrl: ''                              # '' auto | 'off' | 'http://host:port'
  searchTimeoutMs: 12000
  fetchTimeoutMs: 20000
  maxFetchBytes: 1048576
  maxSources: 12
  cacheTtlMs: 300000                        # in-memory result cache
  engineMinIntervalMs: 1500                 # min gap between engine calls (anti rate-limit)
  engineCooldownMs: 600000                  # skip engine after captcha/anomaly/verification-wall (0 = off)
  engineRetryCooldownMs: 60000              # skip engine after generic failure (0 = off)
  userAgent: '<browser-like UA>'
```

The default engine list is tuned for **mainland-China networks**: Bing, Baidu, Sogou and 360 are reachable directly, with no VPN/proxy required. DuckDuckGo and Mojeek are blocked/unreliable there — if you have a proxy (`proxyUrl` or `HTTPS_PROXY`), add them back, e.g. `engines: [bing, baidu, duckduckgo]`.

A private [SearXNG](https://docs.searxng.org/) instance (Docker: `docker run -p 8080:8080 searxng/searxng`) is the most robust engine of all: meta-search aggregation, a JSON API, no per-engine scraping.

## Rate-limit resilience

Search engines (especially DuckDuckGo) throttle scripts. Three mechanisms keep a single-engine setup usable:

- **Pacing** — engine calls are serialized with a minimum `engineMinIntervalMs` gap, so a multi-engine chain does not hammer one host.
- **Circuit breaker** — when an engine reports a bot wall (`blocked by captcha` / `anomaly check` / Baidu's `verification wall`, or HTTP 403/429), it is skipped for `engineCooldownMs` (default 10 min); generic failures (transport, HTTP errors) only trip the shorter `engineRetryCooldownMs` (default 60 s). While cooling down the engine is skipped and the failure is reported in the aggregated error.
- **DuckDuckGo lite fallback** — if the `html.duckduckgo.com` endpoint is bot-walled, the same query is retried once against `lite.duckduckgo.com/lite/`, which is more tolerant of scripts. If the lite endpoint is walled too, the engine reports `blocked by anomaly check (html and lite)` and trips the long `engineCooldownMs` breaker instead of hammering both endpoints on every search.

A blocked engine never makes the whole search fail if other engines remain; with a single engine it fails fast with a "cooling down" reason instead of hammering the walled endpoint.

## Revert to DeepSeek search

Remove the `web` override, the `web-search-deepseek` disable, and the inserted row from `cordis.patch.yml`.

## Notes

- Engines are plain-HTML scraped with regex; markup changes upstream can break an engine — the chain simply falls through to the next one. Errors from every engine are aggregated into the thrown message. Sogou's masked `/link?url=` wrappers are resolved server-side (the stub page embeds the real target); 360's wrappers expose the real URL in the anchor's `data-mdurl` attribute, which the parser reads directly.
- No third-party runtime dependencies: `fetch` + `node:http/https/net/tls` only, plus the dsh-provided `@deepseek-ai/dsh-web` (declared as a `peerDependency`; every dsh profile already ships it).
- Errors follow the seam's provider contract: failures throw `WebError` with `WEB_PROVIDER_ERROR` (engine/transport/timeout, engine errors aggregated) or `WEB_ABORTED` (caller cancellation) — the same vocabulary the official providers use.
- `web_fetch` needs `tool-web`'s `fetch: true`; the shipped `standard` agent preset ships with `fetch: false` — copy the preset to `$DSH_HOME/.agent-presets/` and flip it there.

## License

MIT
