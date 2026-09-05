/**
 * Persistent working notes: the `update_notes` model tool plus the pinned
 * dynamic context that keeps the current notes in front of the model.
 *
 * Persistence needs no custom session event type. The agent loop logs every
 * dynamic runtime context as a durable `user/message` snapshot (source
 * `@deepseek-ai/dsh-system-prompt`, `form: 'snapshot'`, one named section per
 * contribution) whenever the rendered text changes, and re-logs it after a
 * compaction replacement removes it. Restoring notes is therefore a backward
 * fold over the session log for the latest snapshot section named
 * `codex-context:notes` — the same "recover pinned state from the durable log"
 * move the reference implementation makes against its session manager, in
 * dsh-native vocabulary.
 *
 * @module dsh-codex-context/notes
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import { parseNotesSnapshot, renderNotesSnapshot } from './template.js'
import type { CodexContextConfig } from './config.js'

/** System-prompt attribution the loop stamps on runtime-context snapshots. */
const SNAPSHOT_SOURCE = '@deepseek-ai/dsh-system-prompt'
/** Our section name inside runtime-context snapshots (also the context name). */
export const NOTES_CONTEXT_NAME = 'codex-context:notes'
/**
 * Dynamic contexts sort by ascending order; the built-in allocations use
 * 110–120, so notes land immediately after them and before the conversation.
 */
const NOTES_CONTEXT_ORDER = 130
/** Marker the loop logs when no dynamic context is retained. */
const SNAPSHOT_CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** In-memory write-through cache over the durable snapshot fold. */
export class NotesStore {
  private readonly cache = new Map<string, string>()

  /** Current notes for one session, restoring from the durable log on first access. */
  notesFor(session: Session): string {
    const cached = this.cache.get(session.id)
    if (cached !== undefined) return cached
    const restored = restoreNotesFromLog(session)
    this.cache.set(session.id, restored)
    return restored
  }

  /** Record new notes; the loop persists the snapshot at the next assembly. */
  set(session: Session, notes: string): void {
    this.cache.set(session.id, notes)
  }
}

/** Find the latest persisted notes for a session by folding the log backwards. */
export function restoreNotesFromLog(session: Session): string {
  const surface = new Set(session.surface.nodes)
  for (let index = session.seq - 1; index >= 0; index -= 1) {
    const event: SessionEvent | undefined = session.eventAt(SessionSeq(index))
    if (event?.type !== 'user/message') continue
    const data = event.data as { source?: { kind?: string; plugin?: string; form?: string }; content?: unknown }
    const source = data.source
    if (source?.kind !== 'plugin' || source.plugin !== SNAPSHOT_SOURCE) continue
    // Only current surface nodes carry the retained snapshot; shadowed ones
    // are history.
    if (!surface.has(event.seq)) continue
    const text = firstTextBlock(data.content)
    if (text === undefined) continue
    if (text === SNAPSHOT_CLEARED) return ''
    if (source.form !== 'snapshot') continue
    const sections = (source as { sections?: readonly ContextSnapshotSection[] }).sections
    if (!sections?.some(section => section.name === NOTES_CONTEXT_NAME)) continue
    const notes = parseNotesSnapshot(text)
    if (notes !== undefined) return notes
  }
  return ''
}

function firstTextBlock(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const [block] = content
  if (block === undefined || typeof block !== 'object') return undefined
  const candidate = block as { type?: string; text?: string }
  return candidate.type === 'text' && typeof candidate.text === 'string' ? candidate.text : undefined
}

/**
 * Register the notes context and the `update_notes` tool.
 * @returns the store shared with the tool, for advanced compositions.
 */
export function registerNotes(ctx: Context, config: CodexContextConfig): NotesStore {
  const store = new NotesStore()

  ctx.systemPrompt.context({
    name: NOTES_CONTEXT_NAME,
    order: NOTES_CONTEXT_ORDER,
    text: (context) => {
      const agent = context.agent
      // A bare assemble() (tests, diagnostics) has no session to annotate.
      if (agent === undefined) return ''
      const notes = store.notesFor(agent.session)
      if (notes.trim().length === 0) return ''
      return renderNotesSnapshot(notes, config.notesHint)
    },
  })

  ctx.tools.register(defineTool({
    name: 'update_notes',
    description: 'Update the persistent working notes that stay pinned at the top of the context window. '
      + 'Record the active goal, modified files, confirmed constraints, and pending work. '
      + 'Call this at milestones and key decisions: the notes survive windowing, compaction, and restarts.',
    parameters: {
      notes: {
        type: 'string',
        required: true,
        description: 'Structured working notes in Markdown (goals, files touched, constraints, next steps)',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          chars: { type: 'integer', description: 'Length of the stored notes in characters' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `Working notes updated (${value.chars} characters). They stay pinned at the top of the context window and persist for the rest of the session.`
          : 'Working notes were not updated.',
      }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('update_notes requires an agent-owned session (no live session is attached to this call)')
      }
      const notes = args.notes.trim()
      if (notes.length === 0) {
        throw new Error('update_notes: notes must be a non-empty string (clear intent is expressed by writing a short status, not an empty note)')
      }
      store.set(session, notes)
      return { ok: true, chars: notes.length }
    },
  }))

  return store
}
