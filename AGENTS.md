# AGENTS.md

Guidance for AI code agents (opencode, Copilot, etc.) working in this repository.
This is the single source of truth for agent instructions; the legacy
`.github/copilot-instructions.md` is scheduled for removal.

## Build and Test

- Install dependencies with `npm install`.
- Run tests with `npm test` (uses Node's built-in `node --test` runner).
- Start the bot with `npm start` (`node src/index.js`).
- Requires Node.js 20 or newer. This repository is ESM-only (`"type": "module"`).
- `npm run lint` runs `biome check` (lint + format consistency).
- `npm run format` runs `biome format --write` (auto-format).
- No `typecheck` script is provided; this is a plain JS project.

## Architecture

The process runs multiple Mattermost bots in a single Node.js process. Each bot
is assembled by a factory in `src/index.js` from three collaborators:

- `MattermostService` (adapter for Mattermost WebSocket + REST)
- `OpenAIRestClient` (adapter for an OpenAI-compatible REST endpoint)
- `ChatBot` (domain behavior that ties the two together)

Configuration flow: environment variables + `config/bots.json` are loaded and
validated by `src/config.js`, which produces a `deepFreeze`-d runtime config.
`src/index.js` reads that config, builds one runtime bundle per bot via
`createRuntimeBundle`, starts them with `startBotBundles`, registers SIGINT/SIGTERM
handlers, and exposes a `shutdown()` path that stops bundles in reverse order.

Module boundaries:

- `src/index.js` — runtime wiring: factories, startup, shutdown, signal handlers.
- `src/config.js` — env + JSON loading, validation, URL normalization, frozen runtime config.
- `src/bots/chat-bot.js` — reply behavior, thread/message transformation, streaming
  updates, error reporting.
- `src/mattermost/client.js` — Mattermost adapter boundary (WebSocket + REST).
- `src/openai/rest-client.js` — OpenAI adapter boundary using direct REST calls via
  `fetch`; not the official SDK.
- `test/` — `node --test` suites named `<module>.test.js`.
- `config/bots.json` — runtime (non-secret) settings; `config/bots.json.example` is the template.
- `.env` — secrets (`BOT_<NAME>_TOKEN`, `BOT_<NAME>_LLM_API_KEY`).
- `docs/` — in-progress Japanese design memos; completed ones move to `docs/archive/`.

## Conventions / Working Guidance

- Keep OpenAI integration on the existing REST client path in
  `src/openai/rest-client.js`; do not replace it with the official SDK unless
  explicitly requested.
- Prefer small edits inside existing module boundaries rather than broad
  refactors.
- Do not leak Mattermost or OpenAI specifics past the adapter boundary
  (`src/mattermost/client.js`, `src/openai/rest-client.js`). Callers express
  pure domain logic.
- Do not introduce new external dependencies. The runtime dependencies are
  `@mattermost/client`, `dotenv`, and `ws`; lint/format tooling is the only
  devDependency. HTTP is done through `fetch`.
- Secrets (tokens, API keys) are read from env only via `src/config.js`. Never
  log them or embed them in error strings; do not let `Authorization` headers
  reach a logger.
- `llm.reasoningEffort` and `llm.verbosity` are optional per-bot settings. When
  unset, the request to the OpenAI-compatible endpoint must NOT include
  `reasoning_effort` or `verbosity` at all. Preserve the existing behavior in
  `src/openai/rest-client.js`.
- Runtime assembly stays in `src/index.js` via factories
  (`createRuntimeBundle`, `createLLMClient`, `startBotBundles`,
  `registerSignalHandlers`, etc.). Modules do not instantiate their
  collaborators directly; they receive them via constructor / factory
  parameters.
- New bot settings go under `defaults` or `bots[].llm` / `bots[].mattermost` in
  `config/bots.json`, and must be validated in `src/config.js`.

## Code Style

- ESM-only; Node.js 20+. No `require`/`module.exports`.
- 2-space indent, single quotes, semicolons, trailing commas. Formatting is
  enforced by `biome.json`; run `npm run format` to apply it.
- Runtime config is `deepFreeze`-d. Treat all values reachable from it as
  read-only; never reassign or mutate.
- Keep dependency injection seams (`logger`, `processRef`,
  `readFileSyncImpl`, injected `fetch`, etc.) intact so tests can substitute
  them.
- Do not add comments unless explicitly asked. Avoid placeholder/TODO comments.
- Japanese design documents live under `docs/` while in progress and are moved
  to `docs/archive/` once complete. Implementation code, commit messages, and
  PR descriptions are written in English.

## Testing Approach

- Test runner is `node --test` only. Do not add `jest`, `vitest`, or other
  frameworks.
- Tests live in `test/` as `<moduleName>.test.js`.
- Mocking is done via the production code's DI seams
  (`logger`, `processRef`, `readFileSyncImpl`, injected `fetch`, factory
  overrides in `startRuntime`/`createRuntimeBundle`). Do not use `node:test`'s
  `mock` API when a DI seam already exists.
- Add or update tests for every new feature and bug fix.
- Tests must not make real network calls to Mattermost or OpenAI; substitute
  those collaborators via the DI seams.

## Avoid / Do-Not

- Do not introduce the official `openai` SDK (or any alternative LLM SDK) into
  `src/openai/rest-client.js` unless explicitly requested.
- Do not revert to CommonJS; no `require`/`module.exports`.
- Do not reference `process.env`, `process`, or `fetch` directly in production
  code. Access them via the injected seams in `src/config.js` / `src/index.js`
  / `src/openai/rest-client.js`.
- Do not reassign or mutate the frozen runtime config
  (`config.bots[].*`, etc.).
- Do not expose Mattermost REST or OpenAI API specifics outside their adapter
  modules.
- Do not log secrets or include them in error messages.
- Do not perform large refactors or change the directory layout without
  instruction; prefer edits within existing module boundaries.
- Do not add new external dependencies or alternative frameworks (e.g.
  `jest`, `vitest`, the `openai` SDK).
- Do not invent default values for optional request fields
  (`reasoning_effort`, `verbosity`, etc.); omit them entirely when unset.
- Do not add comments unless explicitly asked.
- Do not place in-progress design documents anywhere except `docs/`; do
  not leave completed ones outside `docs/archive/`.

## Commits and PRs

- Commit, push, amend, force-push, and PR creation are performed only when
  the user explicitly requests them.
- Commit messages are in English, following Conventional Commits
  (`feat:`, `fix:`, `refactor:`, etc.) to match the existing history.
- Before committing, inspect `git status`, `git diff`, and
  `git log --oneline -10`; stage only intended files and never include
  secrets.

## Completion Checklist

Before declaring a task complete:

1. Run `npm test`. All tests must pass. Failures must be fixed, not ignored.
2. Run `npm run lint` (`biome check`). It must pass. If it fails:
   - run `npm run format` to auto-fix formatting,
   - re-run `npm run lint`,
   - manually fix any remaining lint rule violations.
3. Confirm new or changed code has corresponding tests in `test/`.
4. A `typecheck` script is not provided; skip it.