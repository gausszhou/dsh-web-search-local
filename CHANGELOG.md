# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.5] - 2026-08-20

### Fixed

- **`web_search_engine` tool crashed dsh web on load (502).** The tool
  definition referenced `presentResult`, a variable renamed to
  `presentSearchResult` during refactoring, so loading the plugin threw
  `presentResult is not defined`.
- **Tool output schema rejected by the DSH engine (`UNSUPPORTED_SCHEMA`).**
  The output JSON schema used per-field `required: true` on string/array/boolean
  properties; DSH only accepts object-level `required: [...]` arrays. Moved to
  object-level `required: ['sources', 'truncated']` (root) and
  `required: ['url']` (source items).

### Added

- Regression test (`tests/test-p0-tool.mjs`) that drives plugin registration
  against a mock ctx and validates the output schema through the real
  `@deepseek-ai/dsh-tools` schema validator.
- `CHANGELOG.md`.

### Changed

- Split `test` into per-suite scripts (`test:p0`, `test:p1`, `test:p2`) and
  added a standard `prepublishOnly` hook that runs the offline test suite before
  `npm publish`.

## [0.1.4] - 2026-08-20

### Changed

- Force CN engines (bing, baidu, sogou, 360) and a private SearXNG instance to
  connect directly; the proxy now applies only to global engines (google,
  duckduckgo, mojeek).

## [0.1.3] - 2026-08-20

### Added

- Layered search: searxng / global / cn layers with parallel engines within a
  layer and merged results; a layer with no results degrades to the next.

## [0.1.2] - 2026-08-20

### Added

- `web_search_engine` tool: let the model pin the search engine per call
  (`engine` or ordered `engines`), alongside request-level overrides.

## [0.1.1] - 2026-08-20

### Added

- Google engine, `publishedAt` parity, proxy-gated skips; tests split into
  P0/P1/P2.

## [0.1.0] - 2026-08-17

### Added

- Initial release: keyless multi-engine web search + page fetch providers for
  the dsh `ctx.web` seam (no DeepSeek dependency), with automatic proxy
  resolution.

[Unreleased]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/gausszhou/dsh-web-search-local/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/gausszhou/dsh-web-search-local/releases/tag/v0.1.0
