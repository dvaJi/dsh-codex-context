/**
 * Tools-only entry for compositions that keep the shipped summarizing
 * compaction backend (`@deepseek-ai/dsh-compaction-basic`) and want the
 * retrieval layer alongside it: the `update_notes` tool with its pinned
 * context, and the cold-first `search_history` tool.
 *
 * Mount with a plain patch row:
 *
 * ```yaml
 * - insert:
 *     - id: codex-context-tools
 *       name: dsh-codex-context/tools
 * ```
 *
 * Never mount this entry together with the main `dsh-codex-context` entry in
 * the same context: both register the same tool names and the registry
 * rejects duplicates.
 *
 * @module dsh-codex-context/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertValidConfig, CodexContextConfigSchema, type CodexContextConfig } from './config.js'
import { registerNotes } from './notes.js'
import { registerSearch } from './search.js'

export const name = 'codex-context-tools'
export const inject = ['tools', 'systemPrompt']
export const Config: typeof CodexContextConfigSchema = CodexContextConfigSchema

export function apply(ctx: Context, config: CodexContextConfig): void {
  assertValidConfig(config)
  registerNotes(ctx, config)
  registerSearch(ctx, config)
}
