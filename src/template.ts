/**
 * Pure text contracts for window checkpoints, working-notes snapshots, and
 * match-centered retrieval excerpts.
 *
 * Dependency-free so persistence formats can be tested without the harness.
 *
 * @module dsh-codex-context/template
 */

/** Header that marks the synthesized window-checkpoint replacement message. */
export const CHECKPOINT_HEADER = '[Window Checkpoint]'

/**
 * Render the template checkpoint that replaces a shadowed span. The model-free
 * counterpart of Codex's summarization checkpoint: it tells the model what
 * left the window and how to get it back losslessly. `summary` may carry a
 * real model-written summary when the emergency parachute produced one.
 */
export function renderCheckpoint(options: {
  shadowedCount: number
  shadowedTokens: number
  retrievalHint: string
  summary?: readonly string[]
}): string {
  const lines: string[] = [
    CHECKPOINT_HEADER,
    `${options.shadowedCount} earlier surface node${options.shadowedCount === 1 ? '' : 's'} of this conversation`
    + ` (~${Math.round(options.shadowedTokens)} tokens) were moved out of the active context window.`,
    'They remain permanently stored in this session log — nothing was deleted.',
  ]
  if (options.summary !== undefined && options.summary.some(text => text.trim().length > 0)) {
    lines.push('', 'Summary of the archived span:', '', ...options.summary)
  }
  lines.push('', options.retrievalHint)
  return lines.join('\n')
}

/** Begin marker of the notes body inside a pinned snapshot message. */
export const NOTES_BEGIN = '[Context Notes]'
/** End marker of the notes body inside a pinned snapshot message. */
export const NOTES_END = '[/Context Notes]'

/**
 * Render the pinned notes snapshot. The harness logs this text as a durable
 * user-role snapshot whenever it changes (and re-logs it after compaction
 * removes it), which is what makes notes survive restarts without any custom
 * session event type.
 */
export function renderNotesSnapshot(notes: string, hint: string): string {
  const body = [
    NOTES_BEGIN,
    notes.trimEnd(),
    NOTES_END,
  ]
  const trimmedHint = hint.trim()
  return trimmedHint.length > 0
    ? [...body, '', trimmedHint].join('\n')
    : body.join('\n')
}

/**
 * Recover the notes text from a pinned snapshot message. Returns `undefined`
 * when the text is not one of our snapshots. Tolerates a missing end marker
 * (a snapshot truncated by an excerpt) by taking the rest of the text.
 */
export function parseNotesSnapshot(text: string): string | undefined {
  const begin = text.indexOf(NOTES_BEGIN)
  if (begin === -1) return undefined
  const bodyStart = begin + NOTES_BEGIN.length
  const end = text.indexOf(NOTES_END, bodyStart)
  const body = end === -1 ? text.slice(bodyStart) : text.slice(bodyStart, end)
  const notes = body.replace(/^\r?\n/, '').trimEnd()
  return notes
}

/**
 * Extract a match-centered excerpt: `radius` characters around the match,
 * with explicit omission markers instead of slicing from offset 0. This is
 * what makes a needle in a 20,000-character tool log actually readable.
 */
export function matchCenteredExcerpt(
  text: string,
  matchIndex: number,
  matchLength: number,
  maxExcerptLength: number,
): string {
  if (text.length <= maxExcerptLength) return text
  const radius = Math.max(0, Math.floor(maxExcerptLength / 2) - Math.floor(matchLength / 2))
  const start = Math.max(0, matchIndex - radius)
  const end = Math.min(text.length, matchIndex + matchLength + radius)
  const prefix = start > 0 ? '...[earlier content omitted]...\n' : ''
  const suffix = end < text.length ? '\n...[later content omitted]...' : ''
  return `${prefix}${text.slice(start, end)}${suffix}`
}

/** Compile a case-insensitive matcher; fall back to an escaped literal when the query is not valid regex. */
export function compileMatcher(query: string): RegExp {
  if (hasNestedUnboundedQuantifier(query)) {
    throw new Error(
      'the query pattern contains nested unbounded quantifiers (e.g. "(a+)+"), which can hang the search with '
      + 'catastrophic backtracking; simplify the pattern or use plain keywords',
    )
  }
  try {
    return new RegExp(query, 'i')
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
}

/**
 * Conservative guard for catastrophic backtracking: true when an unbounded
 * repetition (`*`, `+`, or an open-ended `{m,}`) applies to a group whose
 * body contains another quantifier. Those shapes — `(a+)+`, `(a*)*`,
 * `(a?)+`, `(https?://)+` — are where exponential/quadratic backtracking
 * lives, and a hung `exec()` cannot be interrupted in-process (tool timeouts
 * are cooperative).
 *
 * The check is deliberately lexical and conservative, so some formally safe
 * patterns (any quantified group containing a `?`) are refused as well — a
 * refused pattern is a cheap, self-explanatory error the model can rephrase,
 * while a missed hang is not. Ambiguity-only hazards such as `(a|aa)+` are
 * not detected: this is a heuristic, not a regex-safety proof.
 */
export function hasNestedUnboundedQuantifier(pattern: string): boolean {
  // Per-group dirty flag: whether an open group's body already contains a
  // quantifier, indexed by group nesting depth.
  const groups: boolean[] = []
  let inClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '\\') {
      // Escaped characters (literal `\(`, `\]`, `\+`, ...) carry no structure.
      index += 1
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') {
      inClass = true
      continue
    }
    if (char === '(') {
      groups.push(false)
      // Group-kind prefixes (`?:`, `?=`, `?!`, `?<`) are not quantifiers.
      if (pattern[index + 1] === '?') index += 1
      continue
    }
    if (char === ')' && groups.length > 0) {
      const dirty = groups.pop()!
      const next = pattern[index + 1]
      if (dirty && (next === '*' || next === '+' || isUnboundedRangeAt(pattern, index + 1))) {
        return true
      }
      continue
    }
    if (groups.length === 0) continue
    if (char === '*' || char === '+' || char === '?' || isUnboundedRangeAt(pattern, index)) {
      groups[groups.length - 1] = true
    }
  }
  return false
}

/** Whether `{m,}` (or `{,n}`/`{m, n}` with an open upper end) starts at `index`. */
function isUnboundedRangeAt(pattern: string, index: number): boolean {
  if (pattern[index] !== '{') return false
  let cursor = index + 1
  let sawDigit = false
  let sawComma = false
  while (cursor < pattern.length) {
    const char = pattern[cursor]!
    if (char === '}') return sawComma
    if (char === ',') {
      if (sawComma) return false
      sawComma = true
    } else if (char >= '0' && char <= '9') {
      sawDigit = true
    } else if (char !== ' ' && char !== '\t') {
      // Not a valid range; `{` was a literal character.
      return false
    }
    cursor += 1
  }
  return sawDigit && sawComma
}
