# AGENTS.md

Guidance for AI coding agents working in this repository.
This file is the source of truth for agent instructions in this repository.

## Project Basics

- Node.js 20+.
- This is a JavaScript project today. Keep new code in JavaScript unless a TypeScript migration is explicitly requested.
- ESM-only. Do not introduce CommonJS.
- Treat `package.json` scripts as the source of truth for how to build, run, and validate the project.

## Validate Changes

- Install dependencies with `npm install` when needed.
- Run the relevant checks before finishing work:
  - `npm test`
  - `npm run lint`
- Use `npm run format` when formatting changes are needed.
- If the repository later adds a `typecheck` script, run that too.
- For behavior changes or bug fixes, add or update tests.

## Architecture

- Keep runtime wiring at the application boundary and keep domain behavior separate from external service details.
- Preserve the existing boundary between:
  - Mattermost integration
  - LLM integration
  - Bot behavior
  - Configuration loading and validation
- Prefer small, local changes over broad refactors unless a larger change is explicitly requested.

## Configuration and Secrets

- Keep secrets in environment variables, not in committed config files.
- Do not log secrets, tokens, API keys, or authorization headers.
- When adding configuration, wire it through the existing config-loading path and validate it there.
- Treat runtime configuration as read-only.

## Dependencies and Integrations

- Do not add new runtime dependencies or replace major integration approaches unless explicitly requested.
- Keep external API details contained within their integration modules.
- Preserve testable seams for external dependencies such as logging, process access, file access, and network access.

## Code Style

- Follow the repository's existing style and formatting rules.
- Prefer clear, straightforward code over clever abstractions.
- Add comments only when they clarify non-obvious intent.
- Keep implementation code in English unless the repository clearly uses another convention.
- Keep naming, file layout, and module boundaries consistent with the existing codebase.

## Testing Guidance

- Do not make real network calls in tests.
- Prefer the repository's existing dependency injection and test seams over introducing new mocking approaches.
- Keep tests focused on observable behavior.

## Working Rules

- Do not revert user changes unless explicitly asked.
- Do not make unrelated refactors while solving a focused task.
- Do not commit, amend, or push unless explicitly requested.
- When the task requires a tradeoff, choose the smallest change that preserves clarity and correctness.

## Documentation

- Keep developer-facing change descriptions in English unless the repository clearly uses another convention.
- Keep in-progress design documents under `docs/`.
