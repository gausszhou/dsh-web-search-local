// Targeted tests for the P0/P1 fixes. Run from the deployed plugin dir so the
// @deepseek-ai/dsh-web peer import resolves. The engine cooldown map is
// module-level, so tests share state: each scenario uses its own cooldown
// value and sleeps between scenarios to let expired cooldowns drop.
import { createServer } from 'node:http'
import { runSearch, fetchUrl, defaultConfig } from '../index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. P0: proxy-path truncation must settle immediately, not hang ──────────
{
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    const chunk = Buffer.alloc(64 * 1024, 0x61)
    for (let i = 0; i < 64; i++) res.write(chunk) // 4 MiB total
    res.end()
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const cfg = { ...defaultConfig(), proxyUrl: `http://127.0.0.1:${port}`, maxFetchBytes: 1024, fetchTimeoutMs: 3000 }
  const t0 = Date.now()
  try {
    const r = await fetchUrl({ url: 'http://example.test/big' }, cfg)
    const dt = Date.now() - t0
    check('proxy truncation settles', r.truncated === true && dt < 2000, `truncated=${r.truncated} in ${dt}ms (hang would be ~3000ms timeout)`)
  } catch (e) {
    check('proxy truncation settles', false, `threw: ${e.message} in ${Date.now() - t0}ms`)
  }
  server.close()
}

// ── 2. P1: pacing — consecutive engine calls honor engineMinIntervalMs ──────
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

// ── 3. P1: generic failure trips cooldown (negative cache) ──────────────────
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

// ── 4. P1: block errors (HTTP 429) trip the LONG cooldown ───────────────────
{
  const server = createServer((req, res) => {
    res.writeHead(429, { 'content-type': 'text/plain' })
    res.end('rate limited')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
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
}

// ── 5. Regression: happy path still works (real network, best effort) ───────
{
  const cfg = { ...defaultConfig(), engines: ['bing'], engineMinIntervalMs: 0, searchTimeoutMs: 8000 }
  try {
    const r = await runSearch({ query: 'deepseek harness' }, cfg, null)
    check('happy path', r.sources.length > 0, `${r.sources.length} sources`)
  } catch (e) {
    check('happy path', false, e.message.slice(0, 90))
  }
}

// ── 6. New engines: sogou + 360 (real network, best effort) ─────────────────
// Both engines are mainland-China reachable; captcha walls are environmental,
// so a block is reported as a skip rather than a failure.
{
  for (const [label, engine] of [['sogou', 'sogou'], ['360', '360']]) {
    const cfg = { ...defaultConfig(), engines: [engine], engineMinIntervalMs: 0, searchTimeoutMs: 10000, engineCooldownMs: 0, engineRetryCooldownMs: 0 }
    try {
      const r = await runSearch({ query: '人工智能' }, cfg, null)
      const urlsOk = r.sources.length > 0 && r.sources.every((s) => /^https?:\/\//i.test(s.url))
      check(`${label} engine`, urlsOk, `${r.sources.length} sources` + (urlsOk ? ', all http(s) URLs' : `, sample: ${r.sources[0]?.url?.slice(0, 60)}`))
    } catch (e) {
      const msg = e.message || ''
      if (/blocked by captcha|cooling down/i.test(msg)) check(`${label} engine (skipped: environmental)`, true, msg.slice(0, 80))
      else check(`${label} engine`, false, msg.slice(0, 90))
    }
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
