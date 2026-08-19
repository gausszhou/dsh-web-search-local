// P0 — core contract. Fully offline (local servers only) and must always pass:
// the provider's result shape (official-compatible), its WebError vocabulary,
// the fetch contract, and the P0 proxy-truncation regression. Run from the
// deployed plugin dir so the @deepseek-ai/dsh-web peer import resolves.
import { createServer } from 'node:http'
import { runSearch, fetchUrl, defaultConfig } from '../index.js'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r))

// ── 1. Result shape matches the official provider contract ──────────────────
// web_search returns { sources: [{ url, title?, snippet?, publishedAt? }],
// truncated }. Absent optional fields are omitted (not null); title-less
// results are dropped; truncated is false.
{
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      results: [
        { url: 'https://example.com/full', title: 'Full result', content: 'snippet text', publishedDate: '2024-01-02T08:00:00Z' },
        { url: 'https://example.com/bare', title: 'Bare result', content: '' },
        { url: 'https://example.com/notitle' },
      ],
    }))
  })
  await listen(server)
  const port = server.address().port
  const cfg = { ...defaultConfig(), searxngBaseUrl: `http://127.0.0.1:${port}`, engines: [], proxyUrl: 'off', engineMinIntervalMs: 0 }
  const r = await runSearch({ query: 'x' }, cfg, null)
  server.close()
  server.closeAllConnections?.()
  const s0 = r.sources[0] ?? {}
  const s1 = r.sources[1] ?? {}
  const ok =
    r.truncated === false &&
    r.sources.length === 2 &&
    JSON.stringify(s0) === JSON.stringify({ url: 'https://example.com/full', title: 'Full result', snippet: 'snippet text', publishedAt: '2024-01-02' }) &&
    JSON.stringify(s1) === JSON.stringify({ url: 'https://example.com/bare', title: 'Bare result' })
  check('result shape (official contract)', ok, JSON.stringify(r))
}

// ── 2. Error contract: empty query → WEB_PROVIDER_ERROR ─────────────────────
{
  const cfg = { ...defaultConfig(), engines: [], proxyUrl: 'off' }
  try {
    await runSearch({ query: '   ' }, cfg, null)
    check('empty query → WEB_PROVIDER_ERROR', false, 'did not throw')
  } catch (e) {
    check('empty query → WEB_PROVIDER_ERROR', e.code === 'WEB_PROVIDER_ERROR', `code=${e.code}`)
  }
}

// ── 3. Error contract: caller abort → WEB_ABORTED ───────────────────────────
{
  const ac = new AbortController()
  ac.abort(new Error('caller cancelled'))
  const cfg = { ...defaultConfig(), engines: ['bing'], proxyUrl: 'off', engineMinIntervalMs: 0 }
  try {
    await runSearch({ query: 'x' }, cfg, null, ac.signal)
    check('caller abort → WEB_ABORTED', false, 'did not throw')
  } catch (e) {
    check('caller abort → WEB_ABORTED', e.code === 'WEB_ABORTED', `code=${e.code}`)
  }
}

// ── 4. P0 regression: proxy-path truncation settles immediately, not hang ───
{
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    const chunk = Buffer.alloc(64 * 1024, 0x61)
    for (let i = 0; i < 64; i++) res.write(chunk) // 4 MiB total
    res.end()
  })
  await listen(server)
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
  server.closeAllConnections?.()
}

// ── 5. fetchUrl contract: statusCode / body.kind / body.content / truncated ──
{
  const server = createServer((req, res) => {
    if (req.url === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>hi</h1></body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('plain text body')
  })
  await listen(server)
  const port = server.address().port
  const cfg = { ...defaultConfig(), proxyUrl: 'off', fetchTimeoutMs: 3000 }
  const text = await fetchUrl({ url: `http://127.0.0.1:${port}/t.txt` }, cfg)
  const html = await fetchUrl({ url: `http://127.0.0.1:${port}/page.html` }, cfg)
  server.close()
  server.closeAllConnections?.()
  const ok =
    text.statusCode === 200 && text.body.kind === 'text' && text.body.content === 'plain text body' && text.truncated === false &&
    html.statusCode === 200 && html.body.kind === 'html' && /<h1>hi<\/h1>/.test(html.body.content) && html.truncated === false
  check('fetchUrl contract', ok, JSON.stringify({ text: { ...text, body: text.body.content }, html: { ...html, body: html.body.content.slice(0, 60) } }))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
// Natural exit (not process.exit()): force-exiting while undici still holds
// keep-alive sockets trips a libuv assertion on Windows.
process.exitCode = failed.length ? 1 : 0
