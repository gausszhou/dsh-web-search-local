// P1 — resilience mechanisms. Offline (local servers / pure functions only):
// engine pacing, circuit breaker + negative cache, publishedAt extraction,
// google HTML parsing, and the no-proxy engine skip. Run from the deployed
// plugin dir so the @deepseek-ai/dsh-web peer import resolves.
//
// NOTE: the engine cooldown map is module-level, so scenarios share state:
// each scenario uses its own cooldown values and sleeps between scenarios to
// let expired cooldowns drop — and the searxng publishedAt scenario runs
// BEFORE the 429 long-cooldown one so it cannot inherit that cooldown.
import { createServer } from 'node:http'
import { runSearch, defaultConfig, parseDate, parseGoogleHtml } from '../index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r))

// ── 1. Pacing: consecutive engine calls honor engineMinIntervalMs ───────────
{
  const cfg = { ...defaultConfig(), searxngBaseUrl: 'http://127.0.0.1:1', engines: [], proxyUrl: 'off', engineMinIntervalMs: 2000, engineRetryCooldownMs: 50 }
  await runSearch({ query: 'a' }, cfg, null).catch(() => {}) // warm pacing clock + set cooldown
  await sleep(150) // let the 50ms cooldown expire before the measured call
  const t0 = Date.now()
  await runSearch({ query: 'b' }, cfg, null).catch(() => {})
  const dt = Date.now() - t0
  check('pacing interval', dt >= 1500, `second call took ${dt}ms (min interval 2000ms)`)
  await sleep(150) // clear the 50ms cooldown set by the measured call
}

// ── 2. Generic failure trips cooldown (negative cache) ──────────────────────
{
  const cfg = { ...defaultConfig(), searxngBaseUrl: 'http://127.0.0.1:1', engines: [], proxyUrl: 'off', engineMinIntervalMs: 0, engineRetryCooldownMs: 500 }
  try {
    await runSearch({ query: 'x' }, cfg, null)
    check('breaker: first call fails', false, 'did not throw')
  } catch (e) {
    check('breaker: first call fails', !/cooling down/.test(e.message), e.message.slice(0, 90))
  }
  const t0 = Date.now()
  try {
    await runSearch({ query: 'x' }, cfg, null)
    check('breaker: second call skips', false, 'did not throw')
  } catch (e) {
    const dt = Date.now() - t0
    const skipped = /cooling down/.test(e.message)
    check('breaker: second call skips', skipped && dt < 500, `cooling=${skipped} in ${dt}ms (a retry would take seconds)`)
  }
  await sleep(600) // clear the 500ms cooldown before the next scenario
}

// ── 3. publishedAt: searxng publishedDate flows into the source ──────────────
// Runs before the 429/cooldown scenario: the engine cooldown map is module-level,
// and this scenario must not inherit the long searxng cooldown that one trips.
{
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      results: [
        { url: 'https://example.com/dated', title: 'Dated result', content: 'about something', publishedDate: '2024-05-12T10:00:00+00:00' },
        { url: 'https://example.com/undated', title: 'Undated result', content: 'no date here', publishedDate: null },
      ],
    }))
  })
  await listen(server)
  const port = server.address().port
  const cfg = { ...defaultConfig(), searxngBaseUrl: `http://127.0.0.1:${port}`, engines: [], proxyUrl: 'off', engineMinIntervalMs: 0, engineCooldownMs: 0, engineRetryCooldownMs: 0 }
  const r = await runSearch({ query: 'x' }, cfg, null)
  const s0 = r.sources[0] ?? {}
  const s1 = r.sources[1] ?? {}
  check('publishedAt from searxng', s0.publishedAt === '2024-05-12' && s1.publishedAt === undefined, JSON.stringify(r.sources))
  server.close()
  server.closeAllConnections?.()
}

// ── 4. publishedAt: parseDate normalization (unit) ──────────────────────────
{
  const cases = [
    ['2024年5月12日', '2024-05-12'],
    ['2024年05月02日', '2024-05-02'],
    ['2024-05-12', '2024-05-12'],
    ['2024/5/2', '2024-05-02'],
    ['2024.5.12', '2024-05-12'],
    ['May 12, 2024', '2024-05-12'],
    ['May 12th 2024', '2024-05-12'],
    ['12 May 2024', '2024-05-12'],
    ['published 2024-05-12T10:00:00Z', '2024-05-12'],
    ['no date here', ''],
    ['', ''],
  ]
  for (const [input, want] of cases) {
    const got = parseDate(input)
    check(`parseDate(${JSON.stringify(input)})`, got === want, `got ${JSON.stringify(got)}`)
  }
}

// ── 5. request-level engine override: engine/engines beat the config ────────
// Runs before the 429/cooldown scenario: this scenario calls searxng, and must
// not inherit the long searxng cooldown that one trips.
{
  // Config names bing, request names searxng (no searxngBaseUrl): an honored
  // override returns instantly with 0 sources; an ignored one would hit bing
  // over the network (slow and/or with results).
  const cfg = { ...defaultConfig(), engines: ['bing'], proxyUrl: 'off', engineMinIntervalMs: 0, searchTimeoutMs: 8000 }
  const t0 = Date.now()
  const r = await runSearch({ query: 'x', engine: 'searxng' }, cfg, null)
  const dt = Date.now() - t0
  check('engine override beats config', r.sources.length === 0 && dt < 1500, `${r.sources.length} sources in ${dt}ms (bing would be attempted if ignored)`)

  // End-to-end through a fake searxng server with the override naming searxng.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ results: [{ url: 'https://override.example.com/x', title: 'Override result', content: 'from the fake searxng server' }] }))
  })
  await listen(server)
  const port = server.address().port
  const cfg2 = { ...defaultConfig(), searxngBaseUrl: `http://127.0.0.1:${port}`, engines: ['bing'], proxyUrl: 'off', engineMinIntervalMs: 0 }
  const r2 = await runSearch({ query: 'x', engines: ['searxng'] }, cfg2, null)
  server.close()
  server.closeAllConnections?.()
  check('engine override (engines array) end-to-end', r2.sources[0]?.url === 'https://override.example.com/x', JSON.stringify(r2.sources))
}

// ── 6. engine override validation ───────────────────────────────────────────
{
  const cfg = { ...defaultConfig(), engines: [], proxyUrl: 'off' }
  try {
    await runSearch({ query: 'x', engine: 'yandex' }, cfg, null)
    check('unknown engine → WEB_PROVIDER_ERROR', false, 'did not throw')
  } catch (e) {
    check('unknown engine → WEB_PROVIDER_ERROR', e.code === 'WEB_PROVIDER_ERROR' && /unknown search engine "yandex"/.test(e.message), e.message.slice(0, 90))
  }
  try {
    await runSearch({ query: 'x', engines: [] }, cfg, null)
    check('empty engines override → WEB_PROVIDER_ERROR', false, 'did not throw')
  } catch (e) {
    check('empty engines override → WEB_PROVIDER_ERROR', e.code === 'WEB_PROVIDER_ERROR', e.message.slice(0, 90))
  }
}

// ── 7. Block errors (HTTP 429) trip the LONG cooldown ───────────────────────
{
  const server = createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'text/plain' })
    res.end('rate limited')
  })
  await listen(server)
  const port = server.address().port
  const cfg = { ...defaultConfig(), searxngBaseUrl: `http://127.0.0.1:${port}`, engines: [], proxyUrl: 'off', engineMinIntervalMs: 0, engineCooldownMs: 30000 }
  await runSearch({ query: 'x' }, cfg, null).catch(() => {})
  try {
    await runSearch({ query: 'x' }, cfg, null)
    check('block trips long cooldown', false, 'did not throw')
  } catch (e) {
    check('block trips long cooldown', /cooling down \(\d+s\)/.test(e.message), e.message.slice(0, 90))
  }
  server.close()
  server.closeAllConnections?.()
}

// ── 8. google engine: parseGoogleHtml (modern layout, unit) ─────────────────
{
  const html = `<div id="search">
    <div class="g">
      <a href="/url?q=https%3A%2F%2Fexample.com%2Farticle&amp;sa=U&amp;ved=2ahUKEwj&amp;usg=AOvVaw1"><br><h3 class="LC20lb DKV0Md">Example Article Title</h3></a>
      <div class="VwiC3b yXK7x">May 12, 2024 — this is the snippet text about the example article.</div>
    </div>
    <div class="g">
      <a href="https://direct.example.org/page" jsname="UWckNb"><h3 class="LC20lb">Direct Link Result</h3></a>
      <div class="VwiC3b">just text without any date</div>
    </div>
    <div class="g">
      <a href="/url?q=https%3A%2F%2Fblog.google%2Ftechnology%2Fai%2F&amp;sa=U"><h3 class="LC20lb">Google Blog Result</h3></a>
      <div class="VwiC3b">a result hosted on blog.google survives the host filter</div>
    </div>
    <a href="/search?q=related+query&amp;sa=X">Related searches</a>
    <a href="https://accounts.google.com/ServiceLogin">Sign in</a>
  </div>`
  const src = parseGoogleHtml(html)
  const ok =
    src.length === 3 &&
    src[0].url === 'https://example.com/article' &&
    src[0].title === 'Example Article Title' &&
    /snippet text about the example article/.test(src[0].snippet) &&
    src[0].publishedAt === '2024-05-12' &&
    src[1].url === 'https://direct.example.org/page' &&
    src[1].publishedAt === undefined &&
    src[2].url === 'https://blog.google/technology/ai/' &&
    src.every((s) => /^https?:\/\//i.test(s.url))
  check('google parseGoogleHtml (modern)', ok, JSON.stringify(src))
}

// ── 9. google engine: parseGoogleHtml (basic gbv=1 layout, unit) ────────────
{
  const html = `<ol id="rso">
    <li class="g">
      <h3 class="r"><a href="https://basic.example.com/post">Basic Layout Title</a></h3>
      <div class="s"><span class="st">2024-03-01 — a snippet from the basic html layout.</span></div>
    </li>
    <li class="g">
      <h3 class="r"><a href="/url?q=https%3A%2F%2Fwrapped.example.net%2Fx&amp;sa=U">Wrapped Basic Result</a></h3>
      <div class="s"><span class="st">another snippet, no date here</span></div>
    </li>
    <li class="g">
      <h3 class="r"><a href="/search?q=nav+link">Should Be Skipped</a></h3>
      <div class="s"><span class="st">this nav link must not appear</span></div>
    </li>
  </ol>`
  const src = parseGoogleHtml(html)
  const ok =
    src.length === 2 &&
    src[0].url === 'https://basic.example.com/post' &&
    src[0].title === 'Basic Layout Title' &&
    /basic html layout/.test(src[0].snippet) &&
    src[0].publishedAt === '2024-03-01' &&
    src[1].url === 'https://wrapped.example.net/x' &&
    src[1].title === 'Wrapped Basic Result' &&
    src[1].publishedAt === undefined &&
    src.every((s) => /^https?:\/\//i.test(s.url))
  check('google parseGoogleHtml (basic/gbv=1)', ok, JSON.stringify(src))
}

// ── 10. skipWithoutProxy: no proxy → google/ddg/mojeek skipped fast ─────────
{
  const cfg = { ...defaultConfig(), engines: ['google', 'duckduckgo', 'mojeek'], proxyUrl: 'off', engineMinIntervalMs: 0 }
  const t0 = Date.now()
  try {
    await runSearch({ query: 'x' }, cfg, null)
    check('no-proxy skip: throws', false, 'did not throw')
  } catch (e) {
    const dt = Date.now() - t0
    const ok = /skipped \(no proxy available\)/.test(e.message) && dt < 3000
    check('no-proxy skip: throws fast with reason', ok, `${dt}ms — ${e.message.slice(0, 110)}`)
  }
}

// ── 11. skipWithoutProxy: [] restores attempting the engines ────────────────
{
  const cfg = { ...defaultConfig(), engines: ['google'], proxyUrl: 'off', skipWithoutProxy: [], engineMinIntervalMs: 0, engineCooldownMs: 0, engineRetryCooldownMs: 0, searchTimeoutMs: 2500 }
  try {
    const r = await runSearch({ query: 'x' }, cfg, null)
    check('skipWithoutProxy []: engine attempted', r.sources.length > 0, `${r.sources.length} sources (direct google worked)`)
  } catch (e) {
    const attempted = !/skipped \(no proxy available\)/.test(e.message)
    check('skipWithoutProxy []: engine attempted', attempted, e.message.slice(0, 80))
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
// Natural exit (not process.exit()): force-exiting while undici still holds
// keep-alive sockets trips a libuv assertion on Windows.
process.exitCode = failed.length ? 1 : 0
