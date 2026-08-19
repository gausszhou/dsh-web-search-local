// P2 — real-network smoke tests (best effort, environmental). These hit live
// search engines and can fail on restricted networks (CN without proxy, rate
// limits, captcha walls), so they are NOT part of the offline `npm test`
// gate. Run separately: `npm run test:p2`. Run from the deployed plugin dir
// so the @deepseek-ai/dsh-web peer import resolves.
import { runSearch, defaultConfig } from '../index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// ── 1. Regression: happy path still works (real network) ────────────────────
{
  const cfg = { ...defaultConfig(), engines: ['bing'], engineMinIntervalMs: 0, searchTimeoutMs: 8000 }
  try {
    const r = await runSearch({ query: 'deepseek harness' }, cfg, null)
    check('happy path (bing)', r.sources.length > 0, `${r.sources.length} sources`)
  } catch (e) {
    check('happy path (bing)', false, e.message.slice(0, 90))
  }
}

// ── 2. Mainland engines: sogou + 360 (real network) ─────────────────────────
// Both are mainland-China reachable; captcha walls are environmental, so a
// block is reported as a skip rather than a failure.
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
// Natural exit (not process.exit()): force-exiting while undici still holds
// keep-alive sockets trips a libuv assertion on Windows.
process.exitCode = failed.length ? 1 : 0
