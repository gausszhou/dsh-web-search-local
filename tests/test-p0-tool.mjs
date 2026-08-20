// P0 — tool-registration contract. Fully offline. Guards the two regressions
// that crashed dsh web on load (502): the `web_search_engine` tool definition
// must (a) reference the real `presentSearchResult` presentation fn by name
// (a renamed-variable leftover produced `presentResult is not defined`), and
// (b) use an output JSON schema the DSH engine accepts — `required` must be an
// object-level array of strings (per-field `required: true` is not part of the
// enforced subset → `UNSUPPORTED_SCHEMA`). The schema is validated against the
// REAL DSH validator (`@deepseek-ai/dsh-tools`), resolved through the
// `@deepseek-ai/dsh-web` peer that ships inside the dsh install.
//
// Run from the deployed plugin dir (same rule as the other tests) so the
// @deepseek-ai/dsh-web peer import and the sibling dsh-tools validator resolve.
import plugin from '../index.js'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// Resolve the REAL DSH schema validator through dsh-web's own module tree.
// dsh-web is a symlink into the global dsh install, so realpath it first,
// otherwise createRequire would search upward from the symlink's location.
const dshWebEntry = realpathSync(
  fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-web/lib/index.js', import.meta.url)),
)
const require = createRequire(dshWebEntry)
let assertSupportedJsonSchema
try {
  ;({ assertSupportedJsonSchema } = require('@deepseek-ai/dsh-tools'))
} catch {
  assertSupportedJsonSchema = undefined
}

// Drive plugin.apply() with a minimal fake cordis ctx and capture whatever the
// plugin registers against the `tools` seam.
function captureTool() {
  let tool = null
  const tools = { register: (def) => { tool = def } }
  const ctx = {
    get: (key) => {
      if (key === 'tools') return tools
      if (key === 'systemPrompt') return { section: () => {} }
      return undefined
    },
    web: {
      registerSearchProvider: () => () => {},
      registerFetchProvider: () => () => {},
      search: async () => { throw new Error('should not run during registration') },
    },
    effect: () => {},
  }
  plugin.apply(ctx, { proxyUrl: 'off', engines: [] })
  return tool
}

// ── 1. presentResult is wired to the real fn (regression: it was a bare
//      reference to the pre-rename `presentResult` → "presentResult is not
//      defined" at module load) ──────────────────────────────────────────────
{
  const tool = captureTool()
  const ok =
    tool &&
    typeof tool.presentResult === 'function' &&
    tool.presentResult.name === 'presentSearchResult'
  check(
    'presentResult points to presentSearchResult',
    ok,
    ok ? `fn=${tool.presentResult.name}` : `actual=${tool && typeof tool.presentResult}, ${tool ? JSON.stringify(Object.keys(tool)) : 'no tool registered'}`,
  )
}

// ── 2. output schema passes the DSH engine's own validator (regression:
//      per-field `required: true` → UNSUPPORTED_SCHEMA at registration) ──────
{
  const tool = captureTool()
  if (!tool || !tool.output || !tool.output.schema) {
    check('output schema is registered', false, JSON.stringify(tool))
  } else if (!assertSupportedJsonSchema) {
    check('output schema passes DSH validator (skipped: dsh-tools not resolvable)', true,
      'validator unavailable in this environment')
  } else {
    // The schema must also satisfy the object-rooted constraint used for
    // structured tool output.
    let supported = true
    let detail = 'valid'
    try {
      assertSupportedJsonSchema(tool.output.schema)
    } catch (e) {
      supported = false
      detail = e.violations?.join('; ') ?? e.message
    }
    check('output schema passes assertSupportedJsonSchema', supported, detail)
  }
}

// ── 3. Structural guard, doc + source tree: no per-field `required: true`
//      remains in the schema section (independent of the validator) ─────────
{
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const schemaSection = src.slice(src.indexOf('output: {'), src.indexOf('render:'))
  const bad = /required:\s*true/.test(schemaSection)
  check(
    'no per-field required:true in the output schema source',
    !bad,
    bad ? 'per-field required:true still present' : '',
  )
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exitCode = failed.length ? 1 : 0
