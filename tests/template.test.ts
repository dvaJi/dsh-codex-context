import { describe, expect, it } from 'vitest'
import {
  CHECKPOINT_HEADER,
  NOTES_BEGIN,
  compileMatcher,
  matchCenteredExcerpt,
  parseNotesSnapshot,
  renderCheckpoint,
  renderNotesSnapshot,
} from '../src/template.js'

describe('renderCheckpoint', () => {
  it('describes the archived span and the retrieval path', () => {
    const text = renderCheckpoint({
      shadowedCount: 12,
      shadowedTokens: 34_500,
      retrievalHint: 'call search_history',
    })
    expect(text).toContain(CHECKPOINT_HEADER)
    expect(text).toContain('12 earlier surface nodes')
    expect(text).toContain('~34500 tokens')
    expect(text).toContain('search_history')
    expect(text).not.toContain('Summary of the archived span')
  })

  it('embeds an emergency model summary when one is supplied', () => {
    const text = renderCheckpoint({
      shadowedCount: 1,
      shadowedTokens: 100,
      retrievalHint: 'hint',
      summary: ['## Primary Request and Intent', '- ship the plugin'],
    })
    expect(text).toContain('Summary of the archived span')
    expect(text).toContain('## Primary Request and Intent')
  })

  it('is singular-correct for one node', () => {
    const text = renderCheckpoint({ shadowedCount: 1, shadowedTokens: 10, retrievalHint: 'h' })
    expect(text).toContain('1 earlier surface node of this conversation')
  })
})

describe('notes snapshot roundtrip', () => {
  it('round-trips multi-line notes', () => {
    const notes = '### Active Goal\nRefactor auth flow\n\n### Constraints\n- keep JWT sessions'
    const rendered = renderNotesSnapshot(notes, 'hint: search_history exists')
    expect(rendered).toContain(NOTES_BEGIN)
    expect(parseNotesSnapshot(rendered)).toBe(notes)
  })

  it('round-trips notes containing bracket-like text', () => {
    const notes = 'see [Context Notes] discussion and array[0] access'
    const rendered = renderNotesSnapshot(notes, '')
    expect(parseNotesSnapshot(rendered)).toBe(notes)
  })

  it('tolerates a truncated snapshot (missing end marker)', () => {
    const rendered = renderNotesSnapshot('partial notes that got cut', 'hint')
    const truncated = `${NOTES_BEGIN}\npartial notes that got cut`
    expect(parseNotesSnapshot(truncated)).toBe('partial notes that got cut')
    expect(rendered).toContain('hint')
  })

  it('returns undefined for foreign text', () => {
    expect(parseNotesSnapshot('just a normal user message')).toBeUndefined()
  })
})

describe('matchCenteredExcerpt', () => {
  it('returns short text unchanged', () => {
    expect(matchCenteredExcerpt('short', 0, 5, 1000)).toBe('short')
  })

  it('centers the excerpt on the match position, not the text start', () => {
    const needle = 'ECONNREFUSED'
    const text = `${'a'.repeat(10_000)}${needle}${'b'.repeat(10_000)}`
    const excerpt = matchCenteredExcerpt(text, 10_000, needle.length, 1000)
    expect(excerpt).toContain('...[earlier content omitted]...')
    expect(excerpt).toContain('...[later content omitted]...')
    expect(excerpt).toContain(needle)
    // The match sits roughly in the middle of the excerpt.
    const at = excerpt.indexOf(needle)
    expect(at).toBeGreaterThan(300)
    expect(at).toBeLessThan(excerpt.length - 300)
  })

  it('omits only the leading marker when the match is near the start', () => {
    const text = `${'a'.repeat(5000)}needle${'b'.repeat(5000)}`
    const excerpt = matchCenteredExcerpt(text, 0, 6, 200)
    expect(excerpt).not.toContain('...[earlier content omitted]...')
    expect(excerpt).toContain('...[later content omitted]...')
  })
})

describe('compileMatcher', () => {
  it('compiles valid regular expressions, case-insensitively', () => {
    const matcher = compileMatcher('connection refused|ECONN\\w+')
    expect(matcher.exec('got an ECONNREFUSED error')?.[0]).toBe('ECONNREFUSED')
    expect(matcher.exec('nothing here')).toBeNull()
  })

  it('falls back to a literal match for invalid regex', () => {
    const matcher = compileMatcher('foo(bar')
    expect(matcher.exec('call foo(bar) now')?.[0]).toBe('foo(bar')
  })

  it('refuses patterns with nested unbounded quantifiers', () => {
    expect(() => compileMatcher('(a+)+')).toThrow(/nested unbounded quantifiers/)
    expect(() => compileMatcher('(a*)*')).toThrow(/nested unbounded quantifiers/)
    expect(() => compileMatcher('(a?)+')).toThrow(/nested unbounded quantifiers/)
    expect(() => compileMatcher('(\\w+){2,}')).toThrow(/nested unbounded quantifiers/)
  })

  it('accepts bounded or flat quantifier usage', () => {
    expect(() => compileMatcher('foo+')).not.toThrow()
    expect(() => compileMatcher('(abc)+')).not.toThrow()
    expect(() => compileMatcher('(ab){2,5}')).not.toThrow()
    expect(() => compileMatcher('[a+]+')).not.toThrow() // '+' inside a class is literal
    expect(() => compileMatcher('\\(a\\)+')).not.toThrow() // escaped parens
    expect(() => compileMatcher('(?:a)+')).not.toThrow()
    expect(() => compileMatcher('(a+)$')).not.toThrow() // no repetition on the group
  })
})
