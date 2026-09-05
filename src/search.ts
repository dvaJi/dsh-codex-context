/**
 * `search_history`: match-centered retrieval over the full session log,
 * prioritizing cold history (nodes already shadowed out of the active window
 * by windowing or any other surface replacement).
 *
 * The session log is append-only and lossless — surface replacements shadow
 * nodes but never delete them — so this tool is the retrieval half of the
 * lossless-retrieval architecture: everything the window ever moved out of
 * the active context stays permanently queryable, including complete tool
 * outputs and stack traces that summaries would have destroyed.
 *
 * @module dsh-codex-context/search
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { classifyEvent, extractSearchText, isSearchableType } from './extract.js'
import { compileMatcher, matchCenteredExcerpt } from './template.js'
import type { CodexContextConfig } from './config.js'

/** One search hit as returned in the canonical value. */
export interface HistoryHit {
  /** Durable sequence number of the matching event. */
  seq: number
  /** Event type carrying the match (user/message, assistant/message, tool/call, tool/result). */
  kind: string
  /** True when the event is outside the current active window (shadowed). */
  cold: boolean
  /** Turn number when the event carries one. */
  turn?: number
  /** Step number when the event carries one. */
  step?: number
  /** Match-centered excerpt around the first match in this event. */
  excerpt: string
}

/**
 * Register the `search_history` tool.
 */
export function registerSearch(ctx: Context, config: CodexContextConfig): void {
  ctx.tools.register(defineTool({
    name: 'search_history',
    description: 'Search this session\'s full archived history — earlier turns, tool calls, and complete tool outputs '
      + 'that have been moved out of the active context window. Results are excerpts centered on the match, '
      + 'with cold (archived) history prioritized. Use a keyword or a regular expression.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Keyword or regular expression (case-insensitive); invalid regex falls back to literal matching',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of matches to return',
      },
      scope: {
        type: 'string',
        enum: ['cold_only', 'all'],
        description: "'cold_only' (default) searches only archived history outside the active window; 'all' also searches the active window",
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          total: { type: 'integer', description: 'Number of hits returned' },
          scanned: { type: 'integer', description: 'Number of log events scanned' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                seq: { type: 'integer' },
                kind: { type: 'string' },
                cold: { type: 'boolean' },
                turn: { type: 'integer' },
                step: { type: 'integer' },
                excerpt: { type: 'string' },
              },
              required: ['seq', 'kind', 'cold', 'excerpt'],
              additionalProperties: false,
            },
          },
        },
        required: ['query', 'total', 'scanned', 'hits'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hits.length === 0
          ? `No matches for "${value.query}" in ${value.scanned} scanned history events.`
          : `Found ${value.total} match${value.total === 1 ? '' : 'es'} for "${value.query}" (scanned ${value.scanned} events):\n\n`
            + value.hits.map((hit: HistoryHit) => renderHit(hit)).join('\n\n'),
      }],
      presentationMeta: (_args, value) => ({ hits: value.total, scanned: value.scanned }),
    },
    presentCall: args => ({ card: 'generic', kind: 'search', title: `search_history: ${args.query}` }),
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('search_history requires an agent-owned session (no live session is attached to this call)')
      }
      const limit = args.limit ?? config.searchDefaultLimit
      const scope = args.scope ?? 'cold_only'
      return searchSession(session, exec.callId, args.query, {
        limit,
        scope,
        maxExcerptLength: config.maxExcerptLength,
        maxScanEvents: config.searchMaxScanEvents,
      })
    },
  }))
}

/** Internal search driver, separated from registration for testability. */
export function searchSession(
  session: Session,
  callerCallId: string,
  query: string,
  options: { limit: number; scope: 'cold_only' | 'all'; maxExcerptLength: number; maxScanEvents: number },
): { query: string; total: number; scanned: number; hits: HistoryHit[] } {
  const matcher = compileMatcher(query)

  // Stop before the event that invoked this search so the query text riding
  // the tool call can never match itself.
  const callerSeq = findCallerSeq(session, callerCallId)
  const upperBound = callerSeq ?? session.seq

  const cold = new Set<number>(session.surface.nodes)
  const hits: HistoryHit[] = []
  let scanned = 0

  // Cold first (newest to oldest), then the active window (newest to oldest):
  // forgotten records outrank what the model can already see.
  const scanOrder: Array<{ seq: number; cold: boolean }> = []
  for (let index = upperBound - 1; index >= 0; index -= 1) {
    if (!cold.has(index)) scanOrder.push({ seq: index, cold: true })
  }
  if (options.scope === 'all') {
    for (let index = upperBound - 1; index >= 0; index -= 1) {
      if (cold.has(index)) scanOrder.push({ seq: index, cold: false })
    }
  }

  for (const entry of scanOrder) {
    if (hits.length >= options.limit || scanned >= options.maxScanEvents) break
    const event: SessionEvent | undefined = session.eventAt(SessionSeq(entry.seq))
    if (event === undefined || !isSearchableType(event.type)) continue
    scanned += 1
    const text = extractSearchText(event)
    if (text.length === 0) continue
    const match = matcher.exec(text)
    if (match === null) continue
    const data = event.data as { turn?: number; step?: number }
    const matched = match[0] ?? ''
    const hit: HistoryHit = {
      seq: entry.seq,
      kind: classifyEvent(event.type),
      cold: entry.cold,
      excerpt: matchCenteredExcerpt(text, match.index, matched.length, options.maxExcerptLength),
    }
    if (typeof data.turn === 'number') hit.turn = data.turn
    if (typeof data.step === 'number') hit.step = data.step
    hits.push(hit)
  }

  return { query, total: hits.length, scanned, hits }
}

/** Find the log seq of this execution's own tool/call event, if already appended. */
function findCallerSeq(session: Session, callId: string): number | undefined {
  for (let index = session.seq - 1; index >= Math.max(0, session.seq - 200); index -= 1) {
    const event = session.eventAt(SessionSeq(index))
    if (event === undefined) continue
    if (event.type === 'tool/call') {
      const data = event.data as { callId?: string }
      if (data.callId === callId) return event.seq
    }
    // A turn boundary older than the call cannot contain it.
    if (event.type === 'turn/start') break
  }
  return undefined
}

function renderHit(hit: HistoryHit): string {
  const tag = hit.cold ? '[Cold History]' : '[Active Window]'
  const at = hit.turn !== undefined
    ? `turn ${hit.turn}${hit.step !== undefined ? ` step ${hit.step}` : ''}`
    : 'pre-turn context'
  return `--- seq ${hit.seq} · ${hit.kind} · ${at} ${tag} ---\n${hit.excerpt}`
}
