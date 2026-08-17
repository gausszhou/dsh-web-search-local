/**
 * dsh-web-search-local — keyless multi-engine web search + page fetch providers.
 *
 * Registers two providers into the `ctx.web` seam:
 *   - search provider id "local-multi": tries engines in order (SearXNG JSON
 *     when configured, then bing → duckduckgo → mojeek → baidu) and returns the
 *     first engine that yields results. No API key, no DeepSeek involvement.
 *   - fetch provider id "local-fetch": GETs one http(s) URL, decodes the body
 *     (charset-aware, incl. gbk), returns html/text bodies for web_fetch.
 *
 * Proxy support: the DSH node process does NOT use the OS/browser proxy by
 * default, so engines that need a tunnel (e.g. duckduckgo in CN) fail with
 * plain fetch. This plugin resolves a proxy automatically:
 *   1. config `proxyUrl` (explicit, or 'off' to force direct)
 *   2. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY environment variables
 *   3. a probe of common local HTTP proxy ports (Clash 7890, v2rayN 10809, …)
 * When a proxy is active every request goes through it (CONNECT tunnel, with
 * redirect following), and a transport-level proxy failure falls back to
 * direct, so bing/baidu still work even if the tunnel is down. Baidu always
 * goes direct (it is a China service and flags foreign exit IPs with a
 * verification wall).
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
    // Engine order = priority. "searxng" is prepended automatically when
    // searxngBaseUrl is set (a private SearXNG instance is the most robust
    // engine of all: meta-search + JSON API + no per-engine scraping).
    engines: ['bing', 'duckduckgo', 'mojeek', 'baidu'],
    searxngBaseUrl: '',
    // '' = auto (env vars, then probe of common local proxy ports),
    // 'off' = direct connections only, 'http://host:port' = explicit proxy.
    proxyUrl: '',
    searchTimeoutMs: 12000,
    fetchTimeoutMs: 20000,
    maxFetchBytes: 1048576,
    maxSources: 12,
    cacheTtlMs: 300000,
    cacheMax: 200,
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

function dedupe(sources) {
  const seen = new Set()
  const out = []
  for (const source of sources) {
    let key
    try {
      const u = new URL(source.url)
      u.hash = ''
      key = u.href.replace(/\/+$/, '')
    } catch {
      key = source.url
    }
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
async function request(url, { cfg, signal, timeoutMs, maxBytes, accept, direct = false }) {
  const proxy = direct ? '' : await resolveProxy(cfg)
  if (!proxy) return directRequest(url, { cfg, signal, timeoutMs, maxBytes, accept })
  try {
    return await proxyRequest(url, proxy, { cfg, signal, timeoutMs, maxBytes, accept })
  } catch (error) {
    if (signal?.aborted) throw error
    return directRequest(url, { cfg, signal, timeoutMs, maxBytes, accept })
  }
}

async function directRequest(url, { cfg, signal, timeoutMs, maxBytes, accept }) {
  const ac = combineTimeout(signal, timeoutMs)
  let res
  try {
    res = await fetch(url, {
      headers: {
        'user-agent': cfg.userAgent,
        accept: accept ?? 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
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
function proxyRequest(startUrl, proxyUrl, { cfg, signal, timeoutMs, maxBytes, accept }) {
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
        let truncated = false
        res.on('data', (chunk) => {
          if (total + chunk.length > maxBytes) {
            res.destroy()
            truncated = true
            return
          }
          chunks.push(chunk)
          total += chunk.length
        })
        res.on('end', () => {
          done({ status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated })
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

async function engineText(url, cfg, signal, direct = false) {
  const r = await request(url, { cfg, signal, timeoutMs: cfg.searchTimeoutMs, maxBytes: 2_000_000, direct })
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}`)
  return utf8(r.body)
}

async function bingSearch(query, cfg, signal) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${cfg.maxSources + 4}&setlang=zh-CN`
  const html = await engineText(url, cfg, signal)
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
    out.push({ url, title, ...(snippet ? { snippet } : {}) })
  }
  return out
}

async function duckDuckGoSearch(query, cfg, signal) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const html = await engineText(url, cfg, signal)
  if (/anomaly|botnet|cc=botnet/i.test(html.slice(0, 8000))) throw new Error('blocked by anomaly check')
  const anchors = matchAll(html, /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)
  const snippets = matchAll(html, /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)
  const out = []
  anchors.forEach((m, i) => {
    const url = unwrapUrl(decodeHref(m[1]))
    if (!/^https?:\/\//i.test(url)) return
    const title = cleanText(m[2], 200)
    if (!title) return
    const snippet = snippets[i] ? cleanText(snippets[i][1], 320) : ''
    out.push({ url, title, ...(snippet ? { snippet } : {}) })
  })
  return out
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
    out.push({ url, title, ...(snippet ? { snippet } : {}) })
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
    out.push({ url, title, ...(snippet ? { snippet } : {}) })
  }
  return out
}

async function searxngSearch(query, cfg, signal) {
  const base = String(cfg.searxngBaseUrl || '').replace(/\/+$/, '')
  if (!base) return []
  const url = `${base}/search?q=${encodeURIComponent(query)}&format=json`
  const r = await request(url, { cfg, signal, timeoutMs: cfg.searchTimeoutMs, maxBytes: 2_000_000, accept: 'application/json,*/*;q=0.8' })
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
    out.push({ url: item.url, title, ...(snippet ? { snippet } : {}) })
  }
  return out
}

const ENGINES = {
  bing: bingSearch,
  duckduckgo: duckDuckGoSearch,
  mojeek: mojeekSearch,
  baidu: baiduSearch,
  searxng: searxngSearch,
}

function engineList(cfg) {
  const list = []
  if (cfg.searxngBaseUrl) list.push('searxng')
  for (const name of cfg.engines ?? []) {
    if (typeof ENGINES[name] === 'function' && !list.includes(name)) list.push(name)
  }
  return list
}

// ── provider implementations ────────────────────────────────────────────────

export async function runSearch(searchReq, cfg, cache, signal) {
  const query = String(searchReq?.query ?? '').trim()
  if (!query) throw new WebError('query must be a non-empty string', 'WEB_PROVIDER_ERROR')
  const engines = engineList(cfg)
  const cacheKey = `${query}::${engines.join(',')}`
  if (cache) {
    const cached = cache.get(cacheKey)
    if (cached) return copyResult(cached)
  }
  const errors = []
  for (const name of engines) {
    if (signal?.aborted) throw new WebError('search aborted', 'WEB_ABORTED', { cause: signal.reason })
    try {
      const sources = await ENGINES[name](query, cfg, signal)
      if (sources.length > 0) {
        const result = { sources: dedupe(sources).slice(0, cfg.maxSources), truncated: false }
        if (cache) cache.set(cacheKey, result)
        return copyResult(result)
      }
    } catch (error) {
      if (signal?.aborted) throw new WebError('search aborted', 'WEB_ABORTED', { cause: error })
      errors.push(`${name}: ${error?.message ?? error}`)
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
  },
}
