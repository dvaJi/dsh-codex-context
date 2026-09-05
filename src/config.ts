/**
 * Plugin configuration: one Schemastery schema shared by the engine entry and
 * the tools-only entry. Anything two deployments may want set differently is a
 * field here; invalid values fail the plugin at load time.
 *
 * @module dsh-codex-context/config
 */

import z from '@deepseek-ai/schemastery'

/** Complete configuration surface for dsh-codex-context. */
export interface CodexContextConfig {
  /** Enable the automatic sliding window and overflow recovery. */
  auto: boolean
  /**
   * Target token budget for the active window. The backwards walk shadows
   * older surface nodes until the retained tail fits this budget.
   */
  targetActiveTokens: number
  /** Minimum number of recent surface nodes always retained verbatim. */
  minRetainedNodes: number
  /** Maximum length of each match-centered search excerpt, in characters. */
  maxExcerptLength: number
  /** Default `limit` for search_history when the model omits it. */
  searchDefaultLimit: number
  /** Safety cap on how many log events one search_history call may scan. */
  searchMaxScanEvents: number
  /**
   * Fraction of the routed model's context window above which the emergency
   * parachute fires: the engine writes a real model summary (like Codex's
   * auto-compact) instead of the model-free template checkpoint.
   */
  emergencyThresholdRatio: number
  /** Master switch for the emergency summarization parachute. */
  emergencySummarization: boolean
  /** Optional fixed provider/model pair for emergency summarization; empty uses the routed target. */
  summarizationProvider: string
  summarizationModel: string
  /** Output cap for the emergency summarization request. */
  emergencyMaxTokens: number
  /** Extra windowing attempts after a provider-confirmed context overflow. */
  maxOverflowRetries: number
  /** Hint appended under the pinned notes snapshot (empty disables the hint). */
  notesHint: string
  /** Guidance sentence embedded in every window checkpoint. */
  retrievalHint: string
}

export const DEFAULT_RETRIEVAL_HINT
  = 'To consult exact earlier content (commands, stack traces, outputs, file states), call search_history with a keyword or regex: everything archived from the active window remains permanently retrievable. Keep progress notes current with update_notes.'

export const DEFAULT_NOTES_HINT
  = 'Hint: this snapshot is kept current by update_notes; earlier history remains searchable with search_history.'

function positiveInt(min: number) {
  return z.number().step(1).min(min)
}

/** Validated, defaulted configuration schema for the plugin row. */
export const CodexContextConfigSchema: z<CodexContextConfig> = z.object({
  auto: z.boolean().default(true),
  targetActiveTokens: positiveInt(1000).default(35_000),
  minRetainedNodes: positiveInt(2).default(6),
  maxExcerptLength: positiveInt(100).default(1000),
  searchDefaultLimit: positiveInt(1).default(3),
  searchMaxScanEvents: positiveInt(100).default(20_000),
  emergencyThresholdRatio: z.number().gt(0).lte(1).default(0.85),
  emergencySummarization: z.boolean().default(true),
  summarizationProvider: z.string().default(''),
  summarizationModel: z.string().default(''),
  emergencyMaxTokens: positiveInt(256).default(8192),
  maxOverflowRetries: positiveInt(0).default(1),
  notesHint: z.string().default(DEFAULT_NOTES_HINT),
  retrievalHint: z.string().default(DEFAULT_RETRIEVAL_HINT),
})

/** Reject cross-field values the per-field schema cannot express. */
export function assertValidConfig(config: CodexContextConfig): void {
  if (config.emergencyThresholdRatio <= 0 || config.emergencyThresholdRatio > 1) {
    throw new Error('dsh-codex-context: emergencyThresholdRatio must be in (0, 1]')
  }
}
