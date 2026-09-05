import { describe, expect, it } from 'vitest'
import { classifyEvent, extractSearchText, isSearchableType } from '../src/extract.js'

describe('extractSearchText', () => {
  it('formats tool calls with their raw arguments', () => {
    const text = extractSearchText({
      type: 'tool/call',
      data: { callId: 'c1', name: 'bash', arguments: '{"command":"pnpm test"}' },
    })
    expect(text).toBe('[Tool Call: bash({"command":"pnpm test"})]')
  })

  it('extracts text from user messages', () => {
    const text = extractSearchText({
      type: 'user/message',
      data: {
        role: 'user',
        content: [{ type: 'text', text: 'fix the login bug' }],
        source: { kind: 'user' },
      },
    })
    expect(text).toBe('fix the login bug')
  })

  it('extracts assistant text, reasoning, and tool-call blocks', () => {
    const text = extractSearchText({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'I should look at the stack trace' },
            { type: 'text', text: 'Let me check the server log.' },
            { type: 'tool-call', id: 'c1', name: 'grep', arguments: '{"pattern":"ECONNREFUSED"}' },
          ],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
    })
    expect(text).toContain('[thinking] I should look at the stack trace')
    expect(text).toContain('Let me check the server log.')
    expect(text).toContain('[Tool Call: grep({"pattern":"ECONNREFUSED"})]')
  })

  it('extracts nested tool-result content', () => {
    const text = extractSearchText({
      type: 'tool/result',
      data: {
        message: {
          role: 'user',
          content: [{
            type: 'tool-result',
            toolCallId: 'c1',
            content: [{ type: 'text', text: 'Error: connect ECONNREFUSED 127.0.0.1:5432' }],
            isError: true,
          }],
          source: { kind: 'tool', callId: 'c1' },
        },
      },
    })
    expect(text).toContain('ECONNREFUSED 127.0.0.1:5432')
  })

  it('marks attachments instead of dumping payloads', () => {
    const text = extractSearchText({
      type: 'user/message',
      data: {
        role: 'user',
        content: [{ type: 'image', attachment: {} }],
        source: { kind: 'user' },
      },
    })
    expect(text).toBe('[image attachment]')
  })

  it('returns empty text for structural events', () => {
    expect(extractSearchText({ type: 'turn/start', data: { turn: 1 } })).toBe('')
    expect(extractSearchText({ type: 'request/header', data: {} })).toBe('')
    expect(extractSearchText({ type: 'compaction/start', data: { turn: 1 } })).toBe('')
  })
})

describe('isSearchableType / classifyEvent', () => {
  it('classifies the searchable vocabulary', () => {
    expect(isSearchableType('user/message')).toBe(true)
    expect(isSearchableType('assistant/message')).toBe(true)
    expect(isSearchableType('tool/call')).toBe(true)
    expect(isSearchableType('tool/result')).toBe(true)
    expect(isSearchableType('turn/end')).toBe(false)
    expect(classifyEvent('tool/call')).toBe('tool-call')
    expect(classifyEvent('user/message')).toBe('user')
  })
})
