# dsh-web-search-local

Keyless, multi-engine web search + page fetch providers for the [DeepSeek Harness](https://www.deepseek.com/harness/) (dsh) `ctx.web` seam. Works with **any model backend — including fully local models** — with **no API keys and no dependency on DeepSeek's server-side search**.

## Why

dsh's built-in `web_search` tool is model-agnostic: it only calls `ctx.web.search()`. What depends on DeepSeek is the *default search provider* (`dsh-web-search-deepseek`), which sends each query to DeepSeek's `web_search_20250305` server tool with `DEEPSEEK_API_KEY`. Switch to a local model (Ollama etc.) and that provider has no key, so search dies.

This package registers two providers that do the HTTP themselves:

| provider id | capability | engines |
| --- | --- | --- |
| `local-multi` | `web_search` | SearXNG (optional, runs first when configured) → Bing → DuckDuckGo → Mojeek → Baidu; the first engine with results wins |
| `local-fetch` | `web_fetch` | direct GET, charset-aware decoding (incl. gbk), html/text bodies |

## Proxy / VPN support

A node process does **not** use the OS/browser proxy. If engines like DuckDuckGo are unreachable in your network, the provider resolves a proxy automatically:

1. `proxyUrl` config (explicit, or `'off'` to force direct)
2. `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` environment variables
3. a probe of common local HTTP proxy ports (`7890` Clash, `7897`, `10809` v2rayN, `1080`, …)

Every request then goes through the proxy (CONNECT tunnel for https, absolute-form for http). If the tunnel dies at transport level, the request falls back to direct — so Bing/Baidu keep working even when the VPN is down.

## Install

1. Put this package anywhere the dsh process can read, e.g. `$DSH_HOME/profiles/web/plugins/web-search-local/` (Windows: `C:\Users\<you>\.dsh\profiles\web\plugins\web-search-local\`).
2. Add to your profile's `cordis.patch.yml` (`$DSH_HOME/profiles/web/cordis.patch.yml` for the web profile):

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

3. Restart dsh. `web_search` now returns plain source lists (no server-side summary) and works with any model.

## Configuration

```yaml
config:
  engines: [bing, duckduckgo, mojeek, baidu]   # priority order
  searxngBaseUrl: 'http://127.0.0.1:8080'      # optional; runs first when set
  proxyUrl: ''                                  # '' auto | 'off' | 'http://host:port'
  searchTimeoutMs: 12000
  fetchTimeoutMs: 20000
  maxFetchBytes: 1048576
  maxSources: 12
  cacheTtlMs: 300000                            # in-memory result cache
  userAgent: '<browser-like UA>'
```

A private [SearXNG](https://docs.searxng.org/) instance (Docker: `docker run -p 8080:8080 searxng/searxng`) is the most robust engine of all: meta-search aggregation, a JSON API, no per-engine scraping.

## Revert to DeepSeek search

Remove the `web` override, the `web-search-deepseek` disable, and the inserted row from `cordis.patch.yml`.

## Notes

- Engines are plain-HTML scraped with regex; markup changes upstream can break an engine — the chain simply falls through to the next one. Errors from every engine are aggregated into the thrown message.
- Zero npm dependencies: `fetch` + `node:http/https/net/tls` only.
- `web_fetch` needs `tool-web`'s `fetch: true`; the shipped `standard` agent preset ships with `fetch: false` — copy the preset to `$DSH_HOME/.agent-presets/` and flip it there.

## License

MIT
