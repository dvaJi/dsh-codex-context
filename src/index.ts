/**
 * dsh-codex-context main entry: the `ctx.compaction` provider implementing the
 * Codex-style lossless window, plus the `update_notes` / `search_history`
 * model tools and the pinned notes context.
 *
 * Load as a bundle row (see cordis.patch.yml); overriding the base
 * `compaction-basic` row by id swaps the shipped summarizing backend for this
 * engine in one line.
 *
 * @module dsh-codex-context
 */

export { CodexContextEngine, default } from './engine.js'
export { CodexContextConfigSchema, assertValidConfig, DEFAULT_NOTES_HINT, DEFAULT_RETRIEVAL_HINT } from './config.js'
export type { CodexContextConfig } from './config.js'
