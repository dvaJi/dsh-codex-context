/**
 * Pure searchable-text extraction over session-log event shapes.
 *
 * Works on a minimal structural subset of `SessionEvent` (the discriminant
 * plus the payload fields that carry model-visible text) so it stays
 * unit-testable without the harness installed. Searchable coverage mirrors
 * the reference implementation: user prompts and injected context, assistant
 * messages (including reasoning), tool calls (name + raw arguments), and tool
 * results (including nested tool-result block content).
 *
 * @module dsh-codex-context/extract
 */

/** Structural subset this module reads; engine code passes real SessionEvents. */
export interface SearchableEvent {
  readonly type: string
  readonly data: unknown
}

/** Classification used to tag search results. */
export type SearchKind = 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'other'

/** Which event types carry searchable model-visible text. */
const SEARCHABLE_TYPES: ReadonlySet<string> = new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
])

export function isSearchableType(type: string): boolean {
  return SEARCHABLE_TYPES.has(type)
}

/** Classify one event for result tagging. */
export function classifyEvent(type: string): SearchKind {
  switch (type) {
    case 'user/message': return 'user'
    case 'assistant/message': return 'assistant'
    case 'tool/call': return 'tool-call'
    case 'tool/result': return 'tool-result'
    default: return 'other'
  }
}

/**
 * Extract plain searchable text from one session event's payload.
 * Returns an empty string for structural events (turn/step markers, headers).
 */
export function extractSearchText(event: SearchableEvent): string {
  if (!isSearchableType(event.type)) return ''
  return extractBlocksText(event.type, event.data)
}

function extractBlocksText(type: string, data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const record = data as Record<string, unknown>

  // tool/call: `{ callId, name, arguments }` — arguments is the raw JSON string.
  if (type === 'tool/call') {
    const name = typeof record.name === 'string' ? record.name : 'unknown'
    const args = typeof record.arguments === 'string' ? record.arguments : JSON.stringify(record.arguments ?? {})
    return `[Tool Call: ${name}(${args})]`
  }

  // user/message: the data IS the UserMessage (`{ role, content, source }`).
  // assistant/message and tool/result nest the message under `data.message`.
  const message = type === 'user/message' ? record : record.message
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as Record<string, unknown>).content
  return extractContentText(content)
}

/** Extract text from a ContentBlock array (structural subset). */
export function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return JSON.stringify(content ?? '')
  const chunks: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const block = item as Record<string, unknown>
    switch (block.type) {
      case 'text': {
        if (typeof block.text === 'string') chunks.push(block.text)
        break
      }
      case 'reasoning': {
        if (typeof block.text === 'string') chunks.push(`[thinking] ${block.text}`)
        break
      }
      case 'tool-call': {
        const name = typeof block.name === 'string' ? block.name : 'unknown'
        const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})
        chunks.push(`[Tool Call: ${name}(${args})]`)
        break
      }
      case 'tool-result': {
        chunks.push('[Tool Result]')
        chunks.push(extractContentText(block.content))
        break
      }
      case 'image': {
        chunks.push('[image attachment]')
        break
      }
      case 'file': {
        chunks.push('[file attachment]')
        break
      }
      default: {
        chunks.push(JSON.stringify(block))
        break
      }
    }
  }
  return chunks.filter(chunk => chunk.length > 0).join('\n')
}
