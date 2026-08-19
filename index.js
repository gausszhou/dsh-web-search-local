/**
 * dsh-web-search-local — keyless multi-engine web search + page fetch providers.
 *
 * Registers two providers into the `ctx.web` seam:
 *   - search provider id "local-multi": runs three layers in order —
 *     searxng (when configured) → global (google, duckduckgo, mojeek) → cn
 *     (bing, baidu, sogou, 360) — with same-layer engines queried in PARALLEL
 *     and their results merged round-robin (deduped, capped at maxSources).
 *     A layer with no results degrades to the next, so the global engines
 *     (proxy-gated in CN, Google scrape-fragile — prefer a SearXNG instance
 *     with the google engine for reliable Google results) never break the
 *     directly reachable cn engines. No API key, no DeepSeek involvement.
 *     Sources carry url/title/snippet and, when the engine renders a date,
 *     publishedAt (normalized YYYY-MM-DD) — the same optional field the
 *     official provider fills from its page_age metadata.
 *   - The model can steer the engine per call: the sibling `web_search_engine`
 *     tool accepts `engine`/`engines`, and the provider also honors them on any
 *     `ctx.web.search()` request; calls without an override degrade to the
 *     configured chain.
 *   - fetch provider id "local-fetch": GETs one http(s) URL, decodes the body
 *     (charset-aware, incl. gbk), returns html/text bodies for web_fetch.
 *
 * Proxy support: the DSH node process does NOT use the OS/browser proxy by
 * default, so engines that need a tunnel (e.g. duckduckgo in CN) fail with
 * plain fetch. This plugin resolves a proxy automatically:
 *   1. config `proxyUrl` (explicit, or 'off' to force direct)
 *   2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables
 *   3. a probe of common local HTTP proxy ports (Clash 7890, v2rayN 10808, …)
 * The proxy applies ONLY to the global engines (google, duckduckgo, mojeek) —
 * the CN engines (bing, baidu, sogou, 360) and a private SearXNG instance
 * always connect DIRECTLY: proxying them from a foreign exit IP triggers
 * verification walls / captchas (baidu) or serves stale garbage (searxng),
 * and a transport-level proxy failure falls back to direct, so bing/baidu
 * keep working even if the tunnel is down.
 *
 * Error contract: failures are thrown as `WebError` from `@deepseek-ai/dsh-web`
 * with the official structured codes — `WEB_PROVIDER_ERROR` for engine /
 * transport / timeout failures (engine errors are aggregated into the message)
 * and `WEB_ABORTED` for caller cancellation — matching the seam's provider
 * vocabulary, so `dsh-tool-web` routes them like any other provider.
 *
 * The model-facing `web_search` / `web_fetch` tools keep working unchanged —
 * only the provider selection changes (see the `web` row in cordis.patch.yml).
 *
 * No third-party runtime dependencies: Node builtins (fetch, node:http,
 * node:https, node:net, node:tls, TextDecoder, URL) plus the dsh-provided
 * `@deepseek-ai/dsh-web` (declared as a peerDependency).
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { WebError } from '@deepseek-ai/dsh-web'

export const SEARCH_PROVIDER_ID = 'local-multi'
export const FETCH_PROVIDER_ID = 'local-fetch'

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** Local HTTP proxy ports probed when neither config nor env names a proxy. */
const PROXY_PROBE_PORTS = [7890, 7897, 10809, 10808, 1080, 8888, 8118, 8080, 2080]

export function defaultConfig() {
  return {
    // Engine order = priority. The default is global-first with a
    // mainland-China fallback: SearXNG (when configured), Google, DuckDuckGo
    // and Mojeek need a proxy in CN and simply fall through to the directly
    // reachable Bing/Baidu/Sogou/360 when unreachable — first-wins means one
    // failed engine never breaks the search. "searxng" is additionally
    // auto-prepended by engineList when searxngBaseUrl is set (deduped against
    // this list); Google is scrape-fragile, so prefer a SearXNG instance with
    // the google engine enabled for reliable Google results.
    engines: ['searxng', 'google', 'duckduckgo', 'mojeek', 'bing', 'baidu', 'sogou', '360'],
    searxngBaseUrl: '',
    // '' = auto (env vars, then probe of common local proxy ports),
    // 'off' = direct connections only, 'http://host:port' = explicit proxy.
    proxyUrl: '',
    // Engines skipped — not even attempted — when no proxy is available.
    // They are unreachable/walled without one in CN-like networks, and
    // attempting them would each waste a searchTimeoutMs on a connect timeout.
    // Set to [] on open networks where they work directly.
    skipWithoutProxy: ['google', 'duckduckgo', 'mojeek'],
    searchTimeoutMs: 12000,
    fetchTimeoutMs: 20000,
    maxFetchBytes: 1048576,
    maxSources: 12,
    cacheTtlMs: 300000,
    cacheMax: 200,
    // Pacing & circuit breaking: engine calls are serialized with a minimum
    // interval (anti rate-limit), and a failing engine is skipped for a
    // cooldown (long for bot-wall blocks, short for generic failures). Set a
    // value to 0 to disable that mechanism.
    engineMinIntervalMs: 1500,
    engineCooldownMs: 600000,       // captcha / anomaly / verification-wall blocks
    engineRetryCooldownMs: 60000,   // transport, HTTP error, or empty-result failures
    userAgent: DEFAULT_USER_AGENT,
  }
}

// ── small helpers ───────────────────────────────────────────────────────────

function matchAll(str, re) {
  return [...str.matchAll(re)]
}

function decodeHref(href) {
  let s = String(href).replace(/&amp;/g, '&')
  try { return decodeURIComponent(s) } catch { return s }
}

/** Decode a Buffer/Uint8Array/ArrayBuffer as UTF-8 text. */
function utf8(buf) {
  return new TextDecoder('utf-8').decode(buf)
}

/**
 * Unwrap search-engine redirect wrappers into the real target URL.
 * - Bing /ck/a links: the target lives base64-encoded (with a format-marker
 *   prefix such as "a1") in the `u` query parameter; extract it with a regex
 *   because URLSearchParams would corrupt '+' as a space.
 * - DuckDuckGo /l/?uddg= links (absolute or relative).
 * - Google /url?q= redirect links (relative or absolute).
 */
function unwrapUrl(url) {
  if (/bing\.com\/ck\/a/i.test(url)) {
    try {
      const m = /[?&]u=([^&]+)/.exec(url)
      if (m) {
        const payload = decodeURIComponent(m[1])
        const candidates = [payload, payload.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/'))]
        if (payload.length > 2) candidates.push(payload.slice(2), payload.slice(2).replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')))
        for (const candidate of candidates) {
          try {
            const decoded = Buffer.from(candidate, 'base64').toString('utf-8')
            if (/^https?:\/\//i.test(decoded)) return decoded
          } catch { /* try next */ }
        }
      }
    } catch { /* keep raw */ }
  }
  if (/^\/url\?q=/i.test(url) || /google\.[^/]+\/url\?/i.test(url)) {
    try {
      const u = new URL(url, 'https://www.google.com')
      const target = u.searchParams.get('q')
      if (target && /^https?:\/\//i.test(target)) return decodeURIComponent(target)
    } catch { /* keep raw */ }
  }
  if (url.startsWith('/')) url = `https://duckduckgo.com${url}`
  if (url.includes('duckduckgo.com/l/')) {
    try {
      const u = new URL(url, 'https://duckduckgo.com')
      const target = u.searchParams.get('uddg')
      if (target) url = decodeURIComponent(target)
    } catch { /* keep raw */ }
  }
  return url
}

function cleanText(input, max) {
  let s = String(input ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
  if (max > 0 && s.length > max) s = s.slice(0, max).trimEnd() + '…'
  return s
}

function safeCodePoint(code) {
  try { return String.fromCodePoint(code) } catch { return '' }
}

// ── published-date extraction ────────────────────────────────────────────────
// The official DeepSeek provider carries `page_age` from the server-side tool;
// scraped engines have no such metadata, so we look for a date in each result
// block's raw markup. Bing/Baidu/Sogou/360 render one for many results (date
// spans, attribution lines), SearXNG's JSON API provides `publishedDate`.
// Extracted dates are normalized to `YYYY-MM-DD`; when nothing recognizable is
// present the `publishedAt` field is omitted — exactly like the official
// provider omits it when `page_age` is empty.

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Best-effort date extraction → normalized `YYYY-MM-DD` ('' when absent).
 * Supports Chinese (2024年5月12日), ISO/numeric (2024-05-12, 2024/5/2,
 * 2024.5.12, ISO timestamps) and English (May 12, 2024 / 12 May 2024) formats.
 */
export function parseDate(text) {
  const s = String(text ?? '')
  const pad = (n) => String(n).padStart(2, '0')
  let m
  if ((m = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s))) {
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}`
  }
  if ((m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s))) {
    return `${m[1]}-${pad(m[2])}-${pad(m[3])}`
  }
  if ((m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i.exec(s))) {
    return `${m[3]}-${pad(MONTH_NAMES[m[1].toLowerCase()])}-${pad(m[2])}`
  }
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})\b/i.exec(s))) {
    return `${m[3]}-${pad(MONTH_NAMES[m[2].toLowerCase()])}-${pad(m[1])}`
  }
  return ''
}

/**
 * Assemble one source in the official provider's shape:
 * `{ url, title?, snippet?, publishedAt? }` — every absent optional field is
 * omitted, so the object is byte-compatible with `dsh-tool-web`'s projection.
 */
function makeSource(url, title, snippet, publishedAt) {
  return {
    url,
    ...(title ? { title } : {}),
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  }
}

/** Dedupe key for one source: the URL minus hash and trailing slashes. */
function sourceKey(source) {
  try {
    const u = new URL(source.url)
    u.hash = ''
    return u.href.replace(/\/+$/, '')
  } catch {
    return source.url
  }
}

function dedupe(sources) {
  const seen = new Set()
  const out = []
  for (const source of sources) {
    const key = sourceKey(source)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(source)
  }
  return out
}

function makeCache(cfg) {
  const map = new Map()
  return {
    get(key) {
      const hit = map.get(key)
      if (!hit) return undefined
      if (Date.now() - hit.ts < cfg.cacheTtlMs) return hit.value
      map.delete(key)
      return undefined
    },
    set(key, value) {
      if (map.size >= cfg.cacheMax) map.delete(map.keys().next().value)
      map.set(key, { ts: Date.now(), value })
    },
  }
}

function copyResult(result) {
  return { ...result, sources: result.sources.map((s) => ({ ...s })) }
}

// ── proxy resolution ────────────────────────────────────────────────────────

const proxyMemo = new WeakMap()

function envProxy() {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const value = process.env[key]
    if (value && /^https?:\/\//i.test(value)) return value.replace(/\/+$/, '')
  }
  return ''
}

function resolveProxy(cfg) {
  let pending = proxyMemo.get(cfg)
  if (!pending) {
    pending = doResolveProxy(cfg)
    proxyMemo.set(cfg, pending)
  }
  return pending
}

async function doResolveProxy(cfg) {
  if (cfg.proxyUrl === 'off') return ''
  if (cfg.proxyUrl) return String(cfg.proxyUrl).replace(/\/+$/, '')
  const env = envProxy()
  if (env) return env
  return autoProbeProxy()
}

let probeCache = { ts: 0, url: '' }

async function autoProbeProxy() {
  if (probeCache.url && Date.now() - probeCache.ts < 10 * 60_000) return probeCache.url
  const results = await Promise.all(PROXY_PROBE_PORTS.map((port) => probePort(port)))
  const url = results.find(Boolean) ?? ''
  probeCache = { ts: Date.now(), url }
  return url
}

function probePort(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => { sock.destroy(); resolve('') }, 800)
    sock.on('connect', () => {
      sock.write('CONNECT www.google.com:443 HTTP/1.1\r\nHost: www.google.com:443\r\n\r\n')
    })
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      if (!buf.includes('\r\n\r\n')) return
      clearTimeout(timer)
      sock.destroy()
      const status = Number(buf.slice(0, buf.indexOf('\r\n\r\n')).split('\r\n')[0].split(' ')[1])
      resolve(status >= 200 && status < 300 ? `http://127.0.0.1:${port}` : '')
    })
    sock.on('error', () => { clearTimeout(timer); resolve('') })
  })
}

// ── HTTP layer: proxy-aware request ─────────────────────────────────────────

/**
 * One GET with the configured routing. Returns `{ status, contentType, body,
 * truncated }`; throws only on transport/TLS/timeout/abort errors. HTTP error
 * statuses are results, not throws. When a proxy is in effect and the tunnel
 * fails at transport level, falls back to a direct fetch. `direct: true`
 * forces a direct connection (used for engines that must not be proxied).
 */
async function request(url, { cfg, signal, timeoutMs, maxBytes, accept, direct = false, headers }) {
  const proxy = direct ? '' : await resolveProxy(cfg)
  if (!proxy) return directRequest(url, { cfg, signal, timeoutMs, maxBytes, accept, headers })
  try {
    return await proxyRequest(url, proxy, { cfg, signal, timeoutMs, maxBytes, accept, headers })
  } catch (error) {
    if (signal?.aborted) throw error
    return directRequest(url, { cfg, signal, timeoutMs, maxBytes, accept, headers })
  }
}

async function directRequest(url, { cfg, signal, timeoutMs, maxBytes, accept, headers }) {
  const ac = combineTimeout(signal, timeoutMs)
  let res
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': cfg.userAgent,
        accept: accept ?? 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...headers,
      },
      redirect: 'follow',
      signal: ac,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    if (ac.aborted) throw new Error(`timeout after ${timeoutMs}ms`)
    throw new Error(String(error))
  }
  const { bytes, truncated } = await readBytes(res, maxBytes)
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body: bytes,
    truncated,
  }
}

function combineTimeout(signal, ms) {
  if (signal?.aborted) return signal
  if (typeof AbortSignal.any === 'function') {
    const t = AbortSignal.timeout(ms)
    return signal ? AbortSignal.any([signal, t]) : t
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true })
  return ac.signal
}

async function readBytes(res, maxBytes) {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const bytes = new Uint8Array(await res.arrayBuffer())
    return { bytes, truncated: false }
  }
  const chunks = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = maxBytes - total
    if (value.length > room) {
      chunks.push(value.subarray(0, room))
      total = maxBytes
      truncated = true
      try { await reader.cancel() } catch { /* ignore */ }
      break
    }
    chunks.push(value)
    total += value.length
    if (total >= maxBytes) {
      truncated = true
      break
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes: out, truncated }
}

/**
 * HTTP GET through an HTTP proxy: CONNECT tunnel for https, absolute-form for
 * http, following up to 5 redirects (which may switch protocol).
 */
function proxyRequest(startUrl, proxyUrl, { cfg, signal, timeoutMs, maxBytes, accept, headers: extraHeaders }) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl)
    let settled = false
    let sock
    let req
    let hops = 0
    const timer = setTimeout(() => { destroy(); fail(new Error(`timeout after ${timeoutMs}ms`)) }, timeoutMs)
    const onAbort = () => { destroy(); fail(new Error('aborted')) }
    if (signal?.aborted) { fail(new Error('aborted')); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    function fail(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    function done(result) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    function destroy() {
      try { sock?.destroy() } catch { /* ignore */ }
      try { req?.destroy() } catch { /* ignore */ }
    }
    const headers = {
      'user-agent': cfg.userAgent,
      accept: accept ?? 'text/html,application/xhtml+xml,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extraHeaders,
    }
    function run(url) {
      const target = new URL(url)
      const collect = (res) => {
        const status = res.statusCode
        const location = res.headers.location
        if (status >= 300 && status < 400 && location && hops < 5) {
          hops += 1
          res.resume()
          destroy()
          let next
          try { next = new URL(location, url).href } catch { fail(new Error('bad redirect location')); return }
          run(next)
          return
        }
        const chunks = []
        let total = 0
        res.on('data', (chunk) => {
          if (total + chunk.length > maxBytes) {
            // Cap reached: `destroy()` means `'end'` will never fire, so settle
            // here — otherwise the request hangs until the outer timeout.
            res.destroy()
            done({ status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated: true })
            return
          }
          chunks.push(chunk)
          total += chunk.length
        })
        res.on('end', () => {
          done({ status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated: false })
        })
        res.on('error', (e) => fail(e))
      }
      if (target.protocol === 'https:') {
        sock = net.connect(Number(proxy.port), proxy.hostname)
        sock.on('error', (e) => fail(e))
        sock.on('connect', () => {
          sock.write(`CONNECT ${target.host}:443 HTTP/1.1\r\nHost: ${target.host}:443\r\n\r\n`)
        })
        let buf = ''
        const onData = (chunk) => {
          buf += chunk.toString()
          if (!buf.includes('\r\n\r\n')) return
          const status = Number(buf.slice(0, buf.indexOf('\r\n\r\n')).split('\r\n')[0].split(' ')[1])
          if (status < 200 || status >= 300) {
            destroy()
            fail(new Error(`proxy CONNECT ${status}`))
            return
          }
          sock.off('data', onData)
          const tlsSocket = tls.connect({ socket: sock, servername: target.hostname })
          tlsSocket.on('error', (e) => fail(e))
          req = https.request({
            createConnection: () => tlsSocket,
            hostname: target.hostname,
            port: 443,
            path: target.pathname + target.search,
            method: 'GET',
            headers,
          }, collect)
          req.on('error', (e) => fail(e))
          req.end()
        }
        sock.on('data', onData)
      } else {
        // plain http through the proxy: absolute-form request line
        req = http.request({
          hostname: proxy.hostname,
          port: Number(proxy.port),
          path: url,
          method: 'GET',
          headers: { ...headers, host: target.host },
        }, collect)
        req.on('error', (e) => fail(e))
        req.end()
      }
    }
    run(startUrl)
  })
}

// ── engines ─────────────────────────────────────────────────────────────────

// ── engine pacing & circuit breaking ─────────────────────────────────────────
// Same-layer engines are queried in parallel, so pacing is per engine: the
// same engine is never called twice within `engineMinIntervalMs` (anti
// rate-limit), while different engines in one layer start together. A failing
// engine is skipped for a cooldown: long for bot-wall blocks (captcha /
// anomaly / verification wall / enablejs), short for generic failures. This is
// module-level because the cache is per-plugin-instance while pacing must be
// process-wide to actually protect the engines.

const engineCooldowns = new Map() // engine name -> ms timestamp until which it is skipped
const engineLastAt = new Map()    // engine name -> last call start, for the per-engine min interval

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
  })
}

/** True for bot-wall style errors that should trip the long cooldown. */
function isBlockError(error) {
  const msg = String(error?.message ?? error)
  return (
    /blocked by (captcha|anomaly)|anomaly check|verification wall|consent wall|enablejs|botnet|cc=botnet/i.test(msg) ||
    /^HTTP (403|429)$/.test(msg)
  )
}

/** Wait until `engineMinIntervalMs` has passed since this engine's last call. */
async function paceEngine(name, cfg, signal) {
  const min = cfg.engineMinIntervalMs
  if (!min) return
  const last = engineLastAt.get(name) ?? 0
  const wait = last + min - Date.now()
  if (wait > 0) await sleep(wait, signal)
  engineLastAt.set(name, Date.now())
}

/** Negative-cache an engine failure so later searches skip it during the cooldown. */
function noteEngineFailure(name, error, cfg) {
  const cooldown = isBlockError(error) ? cfg.engineCooldownMs : cfg.engineRetryCooldownMs
  if (cooldown > 0) engineCooldowns.set(name, Date.now() + cooldown)
}

/** Remaining cooldown ms for an engine (0 = usable); expired entries are dropped. */
function engineCoolingDown(name, cfg) {
  const until = engineCooldowns.get(name)
  if (!until) return 0
  const left = until - Date.now()
  if (left <= 0) {
    engineCooldowns.delete(name)
    return 0
  }
  return left
}

async function engineText(url, cfg, signal, direct = false, headers) {
  const r = await request(url, { cfg, signal, timeoutMs: cfg.searchTimeoutMs, maxBytes: 2_000_000, direct, headers })
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`)
  return utf8(r.body)
}

async function bingSearch(query, cfg, signal) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${cfg.maxSources + 4}&setlang=zh-CN`
  // CN engine: always direct — a foreign exit IP gets the consent/interstitial
  // wall or a stripped SERP, and cn.bing.com serves clean results directly.
  const html = await engineText(url, cfg, signal, true)
  if (/captcha|challenge/i.test(html.slice(0, 20000))) throw new Error('blocked by captcha')
  const out = []
  for (const block of matchAll(html, /<li class="b_algo[^"]*"[\s\S]*?<\/li>/gi)) {
    const m = /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i.exec(block[0])
    if (!m) continue
    const url = unwrapUrl(decodeHref(m[1]))
    if (!/^https?:\/\//i.test(url)) continue
    let host
    try { host = new URL(url).hostname } catch { continue }
    if (/(^|\.)(bing|microsoft|msn)\.com$/i.test(host)) continue
    const title = cleanText(m[2], 200)
    if (!title) continue
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block[0])
    const snippet = p ? cleanText(p[1], 320) : ''
    out.push(makeSource(url, title, snippet, parseDate(block[0])))
  }
  return out
}

async function duckDuckGoSearch(query, cfg, signal) {
  try {
    const html = await engineText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, cfg, signal)
    if (isDdgBlocked(html)) throw new Error('blocked by anomaly check')
    return parseDdgHtml(html)
  } catch (error) {
    // Only bot-wall blocks fall back to the lite endpoint (usually more
    // tolerant of scripts); transport/timeout failures propagate as-is.
    if (!isBlockError(error)) throw error
    const lite = await engineText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, cfg, signal)
    // Lite blocked too: surface a block error so runSearch trips the long
    // circuit-breaker cooldown instead of hammering both endpoints every search.
    if (isDdgBlocked(lite)) throw new Error('blocked by anomaly check (html and lite)')
    return parseDdgLite(lite)
  }
}

/** DDG serves an anomaly/bot-wall page instead of results (also on HTTP 202). */
function isDdgBlocked(html) {
  return /anomaly|botnet|cc=botnet/i.test(String(html).slice(0, 8000))
}

function parseDdgHtml(html) {
  const anchors = matchAll(html, /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
  const snippets = matchAll(html, /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)
  const out = []
  anchors.forEach((m, i) => {
    const url = unwrapUrl(decodeHref(m[1]))
    if (!/^https?:\/\//i.test(url)) return
    const title = cleanText(m[2], 200)
    if (!title) return
    const snippet = snippets[i] ? cleanText(snippets[i][1], 320) : ''
    out.push(makeSource(url, title, snippet, parseDate(snippets[i] ? snippets[i][1] : '')))
  })
  return out
}

function parseDdgLite(html) {
  const anchors = matchAll(html, /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
  const snippets = matchAll(html, /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/gi)
  const out = []
  anchors.forEach((m, i) => {
    const url = unwrapUrl(decodeHref(m[1]))
    if (!/^https?:\/\//i.test(url)) return
    const title = cleanText(m[2], 200)
    if (!title) return
    const snippet = snippets[i] ? cleanText(snippets[i][1], 320) : ''
    out.push(makeSource(url, title, snippet, parseDate(snippets[i] ? snippets[i][1] : '')))
  })
  return out
}

async function googleSearch(query, cfg, signal) {
  // Google is opt-in (NOT in the default engine list): in mainland-China
  // networks it needs a proxy, and direct scraping trips its bot detection
  // easily — a private SearXNG instance with the google engine enabled is the
  // robust way to get Google results. `hl=en&gl=us&pws=0` pins the US index,
  // the CONSENT/SOCS cookie bypasses the EU consent interstitial, and `gbv=1`
  // requests the basic-HTML layout (h3.r + span.st), which is far more
  // scrape-friendly than the JS shell Google otherwise serves to scripts
  // (the /httpservice/retry/enablejs wall).
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${cfg.maxSources + 4}&hl=en&gl=us&pws=0&gbv=1&filter=0`
  const headers = { cookie: 'CONSENT=YES+cb.20210328-17-p0.en+FX+410; SOCS=CAI' }
  const html = await engineText(url, cfg, signal, false, headers)
  if (isGoogleBlocked(html)) throw new Error('blocked by captcha (google)')
  const sources = parseGoogleHtml(html)
  if (sources.length === 0 && /enablejs|httpservice\/retry/i.test(String(html).slice(0, 20000))) {
    throw new Error('google requires javascript (enablejs)')
  }
  return sources
}

/** True when Google served a bot wall (/sorry, recaptcha) or the consent page. */
function isGoogleBlocked(html) {
  const head = String(html).slice(0, 60000)
  return (
    /sorry\/index|unusual traffic|g-recaptcha|consent\.google\.com|Before you continue to Google/i.test(head) ||
    /<title>[^<]*(?:captcha|consent|unusual traffic)[^<]*<\/title>/i.test(head)
  )
}

/**
 * Parse google.com/search result HTML. Google serves two layouts:
 * - basic (`gbv=1`, h3.r + span.st) — results are `<li class="g">` blocks;
 * - modern (JS-era, h3.LC20lb + div.VwiC3b) — result anchors carry the target
 *   in `/url?q=` (unwrapped by `unwrapUrl`) or as a direct https href, with
 *   the title inside an `<h3>`. Navigation links (related searches, accounts,
 *   preferences) are dropped. Exported for tests.
 */
export function parseGoogleHtml(html) {
  if (/<h3[^>]*class="[^"]*\br\b[^"]*"[^>]*>\s*<a/i.test(html)) return parseGoogleBasicHtml(html)
  return parseGoogleModernHtml(html)
}

/** Basic (gbv=1) layout: `<li class="g"><h3 class="r"><a href>title</a></h3> … <span class="st">snippet</span>`. */
function parseGoogleBasicHtml(html) {
  const out = []
  for (const m of matchAll(html, /<li[^>]*class="[^"]*\bg\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const block = m[1]
    const a = /<h3[^>]*class="[^"]*\br\b[^"]*"[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h3>/i.exec(block)
    if (!a) continue
    const href = /href="([^"]+)"/i.exec(a[1])
    if (!href) continue
    const raw = decodeHref(href[1])
    if (/^\/(search|preferences|intl)\b/i.test(raw)) continue
    const url = unwrapUrl(raw)
    if (!/^https?:\/\//i.test(url)) continue
    let parsed
    try { parsed = new URL(url) } catch { continue }
    if (/^(accounts|consent|myaccount|policies)\.google\./i.test(parsed.hostname)) continue
    if (/(^|\.)google\./i.test(parsed.hostname) && /^\/(search|url|preferences)/i.test(parsed.pathname)) continue
    const title = cleanText(a[2], 200)
    if (!title) continue
    const st = /<span[^>]*class="[^"]*\bst\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
    const snippet = st ? cleanText(st[1], 320) : ''
    out.push(makeSource(url, title, snippet, parseDate(block)))
  }
  return out
}

/** Modern layout: `<a href="…">…<h3…>title</h3>…</a>` + `VwiC3b`/`aCOpRe` snippets. */
function parseGoogleModernHtml(html) {
  const out = []
  const anchors = matchAll(html, /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
  anchors.forEach((m, i) => {
    const raw = decodeHref(m[1])
    // Google's own navigation links (related searches, preferences, intl
    // pages) are never organic results; /url?q= redirects are results and are
    // unwrapped below.
    if (/^\/(search|preferences|intl)\b/i.test(raw)) return
    const tm = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(m[2])
    if (!tm) return
    const title = cleanText(tm[1], 200)
    if (!title) return
    const url = unwrapUrl(raw)
    if (!/^https?:\/\//i.test(url)) return
    let parsed
    try { parsed = new URL(url) } catch { return }
    if (/^(accounts|consent|myaccount|policies)\.google\./i.test(parsed.hostname)) return
    if (/(^|\.)google\./i.test(parsed.hostname) && /^\/(search|url|preferences)/i.test(parsed.pathname)) return
    const next = i + 1 < anchors.length ? anchors[i + 1].index : Math.min(m.index + 6000, html.length)
    const win = html.slice(m.index, next)
    out.push(makeSource(url, title, googleSnippet(win), parseDate(win)))
  })
  return out
}

function googleSnippet(win) {
  const div = /<div[^>]*class="[^"]*\bVwiC3b\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(win)
  if (div) {
    const t = cleanText(div[1], 320)
    if (t.length >= 4) return t
  }
  const span = /<span[^>]*class="[^"]*\baCOpRe\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(win)
  if (span) {
    const t = cleanText(span[1], 320)
    if (t.length >= 4) return t
  }
  return ''
}

async function mojeekSearch(query, cfg, signal) {
  const url = `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`
  const html = await engineText(url, cfg, signal)
  const out = []
  const anchors = matchAll(html, /<a class="ob" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
  const snippets = matchAll(html, /<p class="s">([\s\S]*?)<\/p>/gi)
  anchors.forEach((m, i) => {
    const url = unwrapUrl(decodeHref(m[1]))
    if (!/^https?:\/\//i.test(url)) return
    const title = cleanText(m[2], 200)
    if (!title) return
    const snippet = snippets[i] ? cleanText(snippets[i][1], 320) : ''
    out.push(makeSource(url, title, snippet, parseDate(snippets[i] ? snippets[i][1] : '')))
  })
  return out
}

async function baiduSearch(query, cfg, signal) {
  // Baidu is a China service: always connect directly — proxying it from a
  // foreign exit IP triggers the "verification wall" and kills the engine.
  const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${cfg.maxSources + 4}&ie=utf-8`
  const html = await engineText(url, cfg, signal, true)
  if (/百度安全验证|wappass\.baidu\.com|security-check/i.test(html.slice(0, 60000))) throw new Error('verification wall')
  const out = []
  const blocks = matchAll(
    html,
    /<div([^>]*class="[^"]*c-container[^"]*"[^>]*)>([\s\S]*?)(?=<div[^>]*class="[^"]*c-container|<\/body>|$)/gi,
  )
  for (const block of blocks) {
    const open = block[1]
    const body = block[2]
    const mu = /mu="([^"]+)"/i.exec(open)
    const titleMatch = /<h3[^>]*class="[^"]*c-title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i.exec(body)
    if (!titleMatch) continue
    let url = unwrapUrl(mu ? decodeHref(mu[1]) : decodeHref(titleMatch[1]))
    if (!/^https?:\/\//i.test(url)) continue
    if (/baidu\.com\/s\?|fakeurl\.baidu\.com/i.test(url)) continue
    const title = cleanText(titleMatch[2], 200)
    if (!title) continue
    const abstract = /<span[^>]*class="[^"]*(?:c-abstract|content-right_)[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(body)
    let snippet = abstract ? cleanText(abstract[1], 320) : ''
    if (!snippet) {
      const after = cleanText(body.replace(/<h3[\s\S]*?<\/h3>/i, ' '), 320)
      if (after && after.length > 4 && !after.includes('{"')) snippet = after
    }
    out.push(makeSource(url, title, snippet, parseDate(body)))
  }
  return out
}

async function sogouSearch(query, cfg, signal) {
  const url = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`
  // CN engine: always direct — proxying it triggers sogou's antispider captcha.
  const html = await engineText(url, cfg, signal, true)
  if (/antispider|seccode|请输入验证码|安全验证|验证码/i.test(html.slice(0, 80000))) throw new Error('blocked by captcha')
  const out = parseSogouHtml(html)
  // Sogou masks most organic results behind /link?url= redirect wrappers whose
  // stub page embeds the real target in window.location.replace / meta refresh.
  // Resolve those server-side (bounded, parallel, best-effort) so web_fetch
  // gets a real page later; unresolvable ones keep the wrapper URL.
  const links = out.map((s) =>
    /\/link\?url=/i.test(s.url) ? resolveSogouLink(new URL(s.url, 'https://www.sogou.com').href, cfg, signal) : Promise.resolve(s.url),
  )
  const targets = await Promise.allSettled(links)
  targets.forEach((t, i) => {
    if (t.status === 'fulfilled' && /^https?:\/\//i.test(t.value)) out[i].url = t.value
  })
  return out
}

function parseSogouHtml(html) {
  const out = []
  const titles = matchAll(html, /<h3[^>]*class="vr-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi)
  titles.forEach((m, i) => {
    const a = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(m[1])
    if (!a) return
    const href = /href="([^"]+)"/i.exec(a[1])
    if (!href) return
    const url = decodeHref(href[1])
    if (!/^https?:\/\//i.test(url) && !/^\/link\?url=/i.test(url)) return
    if (/^https?:\/\//i.test(url) && /sogou\.com\/(web|link)\?/i.test(url)) return // keyword / redirect stubs
    const title = cleanText(a[2], 200)
    if (!title) return
    const next = i + 1 < titles.length ? titles[i + 1].index : Math.min(m.index + 5000, html.length)
    const win = html.slice(m.index + m[0].length, next)
    const snippet = sogouSnippet(win)
    out.push(makeSource(url, title, snippet, parseDate(win)))
  })
  return out
}

function sogouSnippet(win) {
  const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(win)
  if (p) {
    const t = cleanText(p[1], 320)
    if (t.length >= 8) return t
  }
  const d = /<div[^>]*class="[^"]*(?:fz-mid|space-txt|str-text-info)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(win)
  if (d) {
    const t = cleanText(d[1], 320)
    if (t.length >= 8) return t
  }
  return ''
}

/** Resolve a sogou /link?url= wrapper to the real target ('' if it fails). */
async function resolveSogouLink(url, cfg, signal) {
  // Direct, matching sogou's own routing — the stub page is on sogou.com.
  const r = await request(url, { cfg, signal, timeoutMs: 4000, maxBytes: 64 * 1024, accept: 'text/html,*/*;q=0.8', direct: true })
  if (r.status < 200 || r.status >= 300) return ''
  const body = utf8(r.body)
  const m = /location\.replace\("([^"]+)"\)|content=["']0;URL=['"]?([^'">]+)/i.exec(body)
  const target = m ? decodeHref(m[1] || m[2]) : ''
  return /^https?:\/\//i.test(target) ? target : ''
}

const QIHU_INTERNAL = /(^|\.)(so\.com|360\.cn|360kan\.com|qihoo\.com)$/i

async function qihu360Search(query, cfg, signal) {
  const url = `https://www.so.com/s?q=${encodeURIComponent(query)}`
  // CN engine: always direct — foreign exit IPs get 302'd away by 360.
  const html = await engineText(url, cfg, signal, true)
  if (/captcha\.qihoo\.com|antispider|验证码/i.test(html.slice(0, 80000))) throw new Error('blocked by captcha')
  return parseQihu360Html(html)
}

function parseQihu360Html(html) {
  const out = []
  for (const m of matchAll(html, /<li class="res-list[^>]*">([\s\S]*?)<\/li>/gi)) {
    const block = m[1]
    const tm = /<h3[^>]*class="res-title[^"]*"[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*<\/h3>/i.exec(block)
    if (!tm) continue
    const attrs = tm[1]
    // 360 masks links behind /link?m= wrappers but always embeds the real
    // target in the anchor's data-mdurl attribute — prefer it over href.
    const mdurl = /data-mdurl="([^"]+)"/i.exec(attrs)
    const href = /href="([^"]+)"/i.exec(attrs)
    const url = mdurl ? decodeHref(mdurl[1]) : href ? decodeHref(href[1]) : ''
    if (!/^https?:\/\//i.test(url)) continue
    let host
    try { host = new URL(url).hostname } catch { continue }
    if (QIHU_INTERNAL.test(host)) continue
    const title = cleanText(tm[2], 200)
    if (!title) continue
    const p = /<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    const snippet = p ? cleanText(p[1], 320) : ''
    out.push(makeSource(url, title, snippet, parseDate(block)))
  }
  return out
}

async function searxngSearch(query, cfg, signal) {
  const base = String(cfg.searxngBaseUrl || '').replace(/\/+$/, '')
  if (!base) return []
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
  // A private SearXNG instance is the operator's own server: always reach it
  // directly. Routing it through a local VPN/proxy node can serve stale or
  // empty result sets (and defeats the whole point of a private aggregator).
  const r = await request(url, { cfg, signal, timeoutMs: cfg.searchTimeoutMs, maxBytes: 2_000_000, accept: 'application/json,*/*;q=0.8', direct: true })
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`)
  let data
  try {
    data = JSON.parse(utf8(r.body))
  } catch {
    throw new Error(`invalid JSON from ${base}`)
  }
  const out = []
  for (const item of data.results ?? []) {
    if (!item.url || !/^https?:\/\//i.test(item.url)) continue
    const title = cleanText(item.title, 200)
    if (!title) continue
    const snippet = cleanText(item.content, 320)
    out.push(makeSource(item.url, title, snippet, parseDate(item.publishedDate)))
  }
  return out
}

const ENGINES = {
  bing: bingSearch,
  google: googleSearch,
  duckduckgo: duckDuckGoSearch,
  mojeek: mojeekSearch,
  baidu: baiduSearch,
  sogou: sogouSearch,
  '360': qihu360Search,
  searxng: searxngSearch,
}

function engineList(cfg) {
  const list = []
  if (cfg.searxngBaseUrl) list.push('searxng')
  for (const name of cfg.engines ?? []) {
    const key = String(name) // YAML flow sets like [bing, baidu, sogou, 360] deliver the id as a number
    if (typeof ENGINES[key] === 'function' && !list.includes(key)) list.push(key)
  }
  return list
}

// ── layered execution ────────────────────────────────────────────────────────
// Search runs in three layers, in order, with same-layer engines queried in
// PARALLEL and their results merged (round-robin, deduped, capped):
//   1. searxng — a private SearXNG instance is already a meta-search
//      aggregation, so its results win immediately and lower layers are skipped
//   2. global — google / duckduckgo / mojeek (proxy-gated in CN networks)
//   3. cn — bing / baidu / sogou / 360 (directly reachable)
// A layer with no results (empty, blocked, or skipped engines) degrades to the
// next layer; only when every layer fails is the aggregated error thrown.

const ENGINE_LAYERS = {
  searxng: ['searxng'],
  global: ['google', 'duckduckgo', 'mojeek'],
  cn: ['bing', 'baidu', 'sogou', '360'],
}
const LAYER_ORDER = ['searxng', 'global', 'cn']

/** Project an engine list onto the layered plan; empty layers are dropped. */
function layerList(engines) {
  const out = []
  for (const layer of LAYER_ORDER) {
    const members = ENGINE_LAYERS[layer].filter((name) => engines.includes(name))
    if (members.length > 0) out.push({ name: layer, engines: members })
  }
  return out
}

/**
 * Merge one layer's engine results: dedupe each engine's list, then take
 * sources round-robin across engines (engine 1 #1, engine 2 #1, engine 1 #2, …)
 * so no engine's ranking dominates. Capped at `maxSources`; `truncated` is true
 * when the merged list had more sources than the cap. Exported for tests.
 */
export function mergeRoundRobin(results, maxSources) {
  const lists = []
  for (const r of results) {
    const deduped = dedupe(r.sources)
    if (deduped.length > 0) lists.push(deduped)
  }
  const seen = new Set()
  const all = []
  const maxLen = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      if (i >= list.length) continue
      const key = sourceKey(list[i])
      if (seen.has(key)) continue
      seen.add(key)
      all.push(list[i])
    }
  }
  return { sources: all.slice(0, maxSources), truncated: all.length > maxSources }
}

// ── provider implementations ────────────────────────────────────────────────

/**
 * Resolve a per-call engine override from the search request: `request.engine`
 * (one engine) or `request.engines` (ordered priority list). An explicit
 * override REPLACES the configured chain entirely (no searxng auto-prepend) —
 * the model's explicit choice wins. Returns null when the caller left the
 * engines unspecified, so the configured chain applies (the degradation path).
 */
function requestedEngines(searchReq) {
  let raw = null
  if (Array.isArray(searchReq?.engines)) raw = searchReq.engines
  else if (typeof searchReq?.engine === 'string' && searchReq.engine.trim().length > 0) raw = [searchReq.engine]
  else return null
  const list = []
  for (const name of raw) {
    const key = String(name)
    if (typeof ENGINES[key] !== 'function') {
      throw new WebError(`unknown search engine "${key}" (known: ${Object.keys(ENGINES).join(', ')})`, 'WEB_PROVIDER_ERROR')
    }
    if (!list.includes(key)) list.push(key)
  }
  if (list.length === 0) throw new WebError('engine override must name at least one engine', 'WEB_PROVIDER_ERROR')
  return list
}

/**
 * Run one engine call with pacing, circuit breaking, and the no-proxy skip
 * applied. Resolves `{ ok: true, name, sources }`, or `{ ok: false, name,
 * error }` (a skip/cooling reason string or an engine failure). Caller
 * cancellation throws `WEB_ABORTED` through, never an aggregate.
 */
async function runOneEngine(name, query, cfg, signal, skipWithoutProxy, proxy) {
  if (signal?.aborted) throw new WebError('search aborted', 'WEB_ABORTED', { cause: signal.reason })
  const cooling = engineCoolingDown(name, cfg)
  if (cooling > 0) return { ok: false, name, error: `${name}: cooling down (${Math.ceil(cooling / 1000)}s)` }
  if (skipWithoutProxy.has(name) && !proxy) return { ok: false, name, error: `${name}: skipped (no proxy available)` }
  await paceEngine(name, cfg, signal)
  if (signal?.aborted) throw new WebError('search aborted', 'WEB_ABORTED', { cause: signal.reason })
  try {
    const sources = await ENGINES[name](query, cfg, signal)
    return { ok: true, name, sources }
  } catch (error) {
    if (signal?.aborted) throw new WebError('search aborted', 'WEB_ABORTED', { cause: error })
    noteEngineFailure(name, error, cfg)
    return { ok: false, name, error: `${name}: ${error?.message ?? error}` }
  }
}

export async function runSearch(searchReq, cfg, cache, signal) {
  const query = String(searchReq?.query ?? '').trim()
  if (!query) throw new WebError('query must be a non-empty string', 'WEB_PROVIDER_ERROR')
  const engines = requestedEngines(searchReq) ?? engineList(cfg)
  const layers = layerList(engines)
  // Engines that need a proxy (per skipWithoutProxy) are resolved once per
  // search: with no proxy available they are skipped outright instead of
  // burning a searchTimeoutMs each on a doomed connect attempt.
  const skipWithoutProxy = new Set(cfg.skipWithoutProxy ?? [])
  const needsProxy = engines.some((name) => skipWithoutProxy.has(name))
  const proxy = needsProxy ? await resolveProxy(cfg) : ''
  const cacheKey = `${query}::${engines.join(',')}`
  if (cache) {
    const cached = cache.get(cacheKey)
    if (cached) return copyResult(cached)
  }
  const errors = []
  for (const layer of layers) {
    if (signal?.aborted) throw new WebError('search aborted', 'WEB_ABORTED', { cause: signal.reason })
    const settled = await Promise.allSettled(
      layer.engines.map((name) => runOneEngine(name, query, cfg, signal, skipWithoutProxy, proxy)),
    )
    const aborted = settled.find((s) => s.status === 'rejected' && s.reason?.code === 'WEB_ABORTED')
    if (aborted) throw aborted.reason
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        if (!s.value.ok) errors.push(s.value.error)
      } else {
        errors.push(String(s.reason?.message ?? s.reason))
      }
    }
    const merged = mergeRoundRobin(
      settled.filter((s) => s.status === 'fulfilled' && s.value.ok).map((s) => s.value),
      cfg.maxSources,
    )
    if (merged.sources.length > 0) {
      const result = { sources: merged.sources, truncated: merged.truncated }
      if (cache) cache.set(cacheKey, result)
      return copyResult(result)
    }
  }
  if (errors.length > 0) throw new WebError(`all search engines failed (${errors.join('; ')})`, 'WEB_PROVIDER_ERROR')
  return { sources: [], truncated: false }
}

function charsetOf(contentType, head) {
  let m = /charset=["']?([\w-]+)/i.exec(contentType ?? '')
  if (!m) m = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)
  if (!m) m = /<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(head)
  const charset = (m?.[1] ?? 'utf-8').toLowerCase().replace(/^["']|["']$/g, '')
  return charset === 'utf8' ? 'utf-8' : charset
}

export async function fetchUrl(fetchReq, cfg, signal) {
  const url = String(fetchReq?.url ?? '').trim()
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new WebError(`invalid URL: ${url}`, 'WEB_PROVIDER_ERROR')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebError(`unsupported protocol: ${parsed.protocol}`, 'WEB_PROVIDER_ERROR')
  }
  let r
  try {
    r = await request(url, {
      cfg,
      signal,
      timeoutMs: cfg.fetchTimeoutMs,
      maxBytes: cfg.maxFetchBytes,
      accept: 'text/html,text/plain,application/json,application/xml,*/*;q=0.8',
    })
  } catch (error) {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
    throw new WebError(`web fetch failed: ${error?.message ?? error}`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(r.body.slice(0, 2048))
  const charset = charsetOf(r.contentType, head)
  let content
  try {
    content = new TextDecoder(charset, { fatal: false }).decode(r.body)
  } catch {
    content = new TextDecoder('utf-8', { fatal: false }).decode(r.body)
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)
  const isHtml = /text\/html/i.test(r.contentType) || (!r.contentType && /^\s*</.test(content))
  return {
    url,
    statusCode: r.status,
    body: { kind: isHtml ? 'html' : 'text', content },
    truncated: r.truncated,
  }
}

// ── model-facing tool: web_search_engine ────────────────────────────────────
// The official `web_search` tool (dsh-tool-web) is locked to a { query } schema
// and forwards only { query, maxResults } to the seam, so a model can never
// steer the engine through it — and its registry lives in the shared global
// tool layer, so shadowing it from a plugin would throw on duplicate names.
// Instead we register a sibling tool, `web_search_engine`, with optional
// `engine` / `engines` arguments that are forwarded to the provider. When the
// model omits them, `ctx.web.search` still hits our provider with no override
// and the configured engine chain (the degradation path) applies. Rendering
// and presentation replicate dsh-tool-web's behavior byte-for-byte (local
// copies: no extra runtime dependency, and the official package may be absent).

const WEB_SEARCH_ENGINE_NAMES = Object.keys(ENGINES).join(', ')

/** Display label for a source: its title, else its hostname. */
function sourceLabel(url, title) {
  if (title !== undefined && title.length > 0) return title
  try { return new URL(url).hostname } catch { return url }
}

/** The official tool's model-facing text block: content + markdown source list. */
function formatSearchOutput(result) {
  const parts = []
  if (result.content !== undefined && result.content.length > 0) parts.push(result.content)
  if (result.sources.length > 0) {
    const lines = result.sources.map((source) => {
      const label = sourceLabel(source.url, source.title)
      const meta = []
      if (source.snippet !== undefined && source.snippet.length > 0) meta.push(source.snippet)
      if (source.publishedAt !== undefined && source.publishedAt.length > 0) meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  } else if (result.content === undefined || result.content.length === 0) parts.push('No results found.')
  if (result.truncated) parts.push(`(Showing the first ${result.sources.length} sources. Refine the query for more.)`)
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/** Project one source to `{ url, title?, snippet?, publishedAt? }`, omitting absent fields. */
function projectSource(source) {
  return {
    url: source.url,
    ...(source.title !== undefined ? { title: source.title } : {}),
    ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
    ...(source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
  }
}

/** The official tool's replayable presentation meta from a search value. */
function searchMetaFromValue(value) {
  return {
    sources: value.sources.map(projectSource),
    truncated: value.truncated,
    ...(value.content !== undefined ? { answer: value.content } : {}),
  }
}

/** Narrow opaque tool-result meta to a valid search meta (else undefined). */
function searchMetaFromResult(meta) {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { sources, truncated, answer } = meta
  const validSource = (v) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    typeof v.url === 'string' &&
    (v.title === undefined || typeof v.title === 'string') &&
    (v.snippet === undefined || typeof v.snippet === 'string') &&
    (v.publishedAt === undefined || typeof v.publishedAt === 'string')
  if (!Array.isArray(sources) || !sources.every(validSource)) return undefined
  if (typeof truncated !== 'boolean') return undefined
  return { sources, truncated, ...(answer !== undefined ? { answer } : {}) }
}

/** The official search-result card; undefined falls back to the generic card. */
function presentSearchResult(args, result) {
  if (result.isError) return undefined
  const meta = searchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  return {
    card: 'web',
    kind: 'search',
    title: args.query,
    sources: meta.sources,
    truncated: meta.truncated,
    ...(meta.answer !== undefined ? { answer: meta.answer } : {}),
  }
}

/**
 * Register the `web_search_engine` tool when the tools service is available
 * (best-effort: a profile without the tool stack keeps the providers only).
 * The model may pin one engine (`engine`) or an ordered list (`engines`);
 * omitting both degrades to the configured default chain.
 */
function registerEngineSearchTool(ctx, cfg) {
  let tools
  try { tools = ctx.get('tools') } catch { return }
  if (!tools || typeof tools.register !== 'function') return
  let systemPrompt
  try { systemPrompt = ctx.get('systemPrompt') } catch { /* no prompt section */ }
  systemPrompt?.section?.({
    name: 'tool:web_search_engine',
    order: 111,
    text: 'web_search_engine is web_search with engine control: pass `engine` (one of ' +
      `${WEB_SEARCH_ENGINE_NAMES}) or an ordered \`engines\` list to pin the engine(s); ` +
      'omit both to use the default engine chain.',
  })
  tools.register({
    name: 'web_search_engine',
    description:
      'Search the web, optionally pinning the search engine. Set `engine` to one of ' +
      `${WEB_SEARCH_ENGINE_NAMES}, or \`engines\` to an ordered priority list. ` +
      'When neither is given, the configured default engine chain is used. Returns sources to cite.',
    parameters: {
      query: { type: 'string', required: true, description: 'The search query.' },
      engine: { type: 'string', description: `One engine to use (${WEB_SEARCH_ENGINE_NAMES}). Mutually exclusive with \`engines\`.` },
      engines: { type: 'array', items: { type: 'string' }, description: `Ordered engine priority list (${WEB_SEARCH_ENGINE_NAMES}). Mutually exclusive with \`engine\`.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string' },
          sources: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string' },
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchOutput(value) }],
      presentationMeta: (_args, value) => searchMetaFromValue(value),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim()
      if (!query) throw new Error('query must be a non-empty string')
      const request = { query, maxResults: 8 } // same source cap as the official tool
      if (typeof args?.engine === 'string' && args.engine.trim().length > 0) request.engine = args.engine
      else if (Array.isArray(args?.engines) && args.engines.length > 0) request.engines = args.engines
      const result = await ctx.web.search(request, exec.signal)
      return {
        ...(result.content !== undefined ? { content: result.content } : {}),
        sources: result.sources.map(projectSource),
        truncated: result.truncated,
      }
    },
    presentCall: (args) => ({ card: 'generic', title: args.query, kind: 'search', rawInput: args.query }),
    presentResult,
  })
}

// ── cordis plugin ───────────────────────────────────────────────────────────

export default {
  name: 'web-search-local',
  inject: ['web'],
  apply(ctx, config = {}) {
    const cfg = { ...defaultConfig(), ...config }
    const cache = makeCache(cfg)
    const searchProvider = {
      id: SEARCH_PROVIDER_ID,
      available: () => true,
      search: (request, signal) => runSearch(request, cfg, cache, signal),
    }
    const fetchProvider = {
      id: FETCH_PROVIDER_ID,
      available: () => true,
      fetch: (request, signal) => fetchUrl(request, cfg, signal),
    }
    ctx.effect(function* () {
      const disposeSearch = ctx.web.registerSearchProvider(searchProvider)
      const disposeFetch = ctx.web.registerFetchProvider(fetchProvider)
      yield () => {
        disposeSearch()
        disposeFetch()
      }
    })
    registerEngineSearchTool(ctx, cfg)
  },
}
