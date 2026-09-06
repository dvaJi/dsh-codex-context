import { describe, expect, it } from 'vitest'
import { planOverflowCut, planWindowCut, type WindowNode } from '../src/window.js'

function node(seq: number, tokens: number, overrides: Partial<WindowNode> = {}): WindowNode {
  return { seq, tokens, balancedBefore: true, isUserTurnStart: false, ...overrides }
}

/** A realistic alternating surface: user turn, assistant work, tool result, … */
function fixture(): WindowNode[] {
  return [
    node(0, 900, { isUserTurnStart: true }), // user turn 1
    node(1, 2000), // assistant
    node(2, 3000), // tool result
    node(3, 400, { isUserTurnStart: true }), // user turn 2
    node(4, 1500), // assistant
    node(5, 2500), // tool result
    node(6, 700, { isUserTurnStart: true }), // user turn 3 (latest)
    node(7, 1000), // assistant
  ]
}

describe('planWindowCut', () => {
  it('returns null when the surface fits the budget', () => {
    const nodes = fixture() // total 12000
    expect(planWindowCut(nodes, { targetTokens: 12_000, minRetainedNodes: 2 })).toBeNull()
  })

  it('returns null when nothing can be retained at the minimum', () => {
    const nodes = fixture()
    expect(planWindowCut(nodes, { targetTokens: 100, minRetainedNodes: nodes.length + 1 })).toBeNull()
  })

  it('cuts on a user-turn boundary so the retained tail fits the budget', () => {
    const nodes = fixture() // total 12000
    const plan = planWindowCut(nodes, { targetTokens: 4000, minRetainedNodes: 2 })
    expect(plan).not.toBeNull()
    expect(plan!.retainedTokens).toBeLessThanOrEqual(4000)
    expect(plan!.shadowedTokens).toBeGreaterThanOrEqual(12_000 - 4000)
    expect(plan!.retained.length).toBeGreaterThanOrEqual(2)
    // The boundary is the start of a user turn (user turn 3, nodes 6-7).
    expect(plan!.cutIdx).toBe(6)
    expect(plan!.retained[0]!.isUserTurnStart).toBe(true)
  })

  it('never separates a tool call from its result across the cut', () => {
    const nodes = [
      node(0, 5000, { isUserTurnStart: true }),
      // An unsafe boundary: an assistant message whose tool calls are not
      // answered before the next node would orphan the pair.
      node(1, 5000, { balancedBefore: false }),
      node(2, 1000),
      node(3, 1000),
    ]
    const plan = planWindowCut(nodes, { targetTokens: 5000, minRetainedNodes: 2 })
    expect(plan).not.toBeNull()
    // Cutting at index 2 (balanced) is the best safe option; index 1 is unsafe.
    expect(plan!.cutIdx).toBe(2)
  })

  it('falls back to the newest safe boundary when one turn dominates the window', () => {
    const nodes = [
      node(0, 90_000, { isUserTurnStart: true }), // one giant turn
      node(1, 2000, { balancedBefore: false }), // unsafe (mid-step)
      node(2, 2000),
      node(3, 2000),
    ]
    const plan = planWindowCut(nodes, { targetTokens: 10_000, minRetainedNodes: 2 })
    expect(plan).not.toBeNull()
    // Only index 2 is a safe, allowed boundary; the fallback frees what it can.
    expect(plan!.cutIdx).toBe(2)
    expect(plan!.reason).toBe('budget-fallback')
  })

  it('cuts at a boundary whose retained tail exactly meets the budget', () => {
    // Every node costs 100; the tail [4..8) is exactly 400 tokens.
    const nodes = Array.from({ length: 8 }, (_, seq) => node(seq, 100))
    const plan = planWindowCut(nodes, { targetTokens: 400, minRetainedNodes: 2 })
    expect(plan).not.toBeNull()
    expect(plan!.cutIdx).toBe(4)
    expect(plan!.retainedTokens).toBe(400)
    expect(plan!.reason).toBe('budget')
  })

  it('prefers a fitting user-turn boundary over an older mid-turn one', () => {
    const nodes = [
      node(0, 100, { isUserTurnStart: true }),
      node(1, 100),
      node(2, 100),
      node(3, 100),
      node(4, 100), // oldest fitting boundary — but mid-turn
      node(5, 100),
      node(6, 100, { isUserTurnStart: true }), // fitting whole-turn boundary
      node(7, 100),
    ]
    const plan = planWindowCut(nodes, { targetTokens: 400, minRetainedNodes: 2 })
    expect(plan).not.toBeNull()
    // Snapped forward to node 6 so the active window reopens on a user turn.
    expect(plan!.cutIdx).toBe(6)
    expect(plan!.retained[0]!.isUserTurnStart).toBe(true)
    expect(plan!.retainedTokens).toBeLessThanOrEqual(400)
  })

  it('keeps the mid-turn cut when no user-turn boundary fits the budget', () => {
    const nodes = [
      node(0, 10_000, { isUserTurnStart: true }), // one huge user turn
      node(1, 500),
      node(2, 500),
      node(3, 500, { balancedBefore: false }), // mid-step boundary is unsafe
      node(4, 500),
      node(5, 500),
    ]
    const plan = planWindowCut(nodes, { targetTokens: 1500, minRetainedNodes: 2 })
    expect(plan).not.toBeNull()
    // Boundary 3 would fit exactly but is unsafe; boundary 4 (mid-turn) is the
    // oldest safe fitting boundary and no user-turn boundary exists after the
    // crossing point, so the mid-turn cut stays.
    expect(plan!.cutIdx).toBe(4)
    expect(plan!.retained[0]!.isUserTurnStart).toBe(false)
    expect(plan!.retainedTokens).toBe(1000)
  })

  it('lets the engine fall back to the maximal cut when the minimum tail exceeds the budget', () => {
    // Eight 150-token nodes: the newest six alone cost 900 tokens, over the
    // 850-token budget, so no budget cut can exist — but a maximal overflow
    // cut can still shadow the two oldest nodes. The engine's pressure path
    // falls back to planOverflowCut exactly when planWindowCut is null.
    const nodes = Array.from({ length: 8 }, (_, seq) => node(seq, 150))
    expect(planWindowCut(nodes, { targetTokens: 850, minRetainedNodes: 6 })).toBeNull()
    const overflow = planOverflowCut(nodes, { targetTokens: 850, minRetainedNodes: 6 })
    expect(overflow).not.toBeNull()
    expect(overflow!.cutIdx).toBe(2)
    expect(overflow!.retained.length).toBe(6)
    expect(overflow!.retainedTokens).toBe(900)
  })
})

describe('planOverflowCut', () => {
  it('retains exactly the minimum number of nodes (snapped to safety)', () => {
    const nodes = fixture()
    const plan = planOverflowCut(nodes, { targetTokens: 4000, minRetainedNodes: 3 })
    expect(plan).not.toBeNull()
    expect(plan!.retained.length).toBe(3)
    expect(plan!.cutIdx).toBe(nodes.length - 3)
    expect(plan!.reason).toBe('overflow')
  })

  it('snaps back when the minimum-retained boundary is unsafe', () => {
    const nodes = [
      node(0, 1000),
      node(1, 1000),
      node(2, 1000),
      node(3, 1000, { balancedBefore: false }), // unsafe boundary
      node(4, 1000),
    ]
    const plan = planOverflowCut(nodes, { targetTokens: 1, minRetainedNodes: 2 })
    expect(plan).not.toBeNull()
    // Newest allowed cut is index 3 (unsafe) → snap to index 2? Index 2 is
    // safe, so retained = nodes 2..4 (3 nodes ≥ the minimum).
    expect(plan!.cutIdx).toBe(2)
    expect(plan!.retained[0]!.balancedBefore).toBe(true)
  })

  it('returns null for an empty or too-short surface', () => {
    expect(planOverflowCut([], { targetTokens: 0, minRetainedNodes: 2 })).toBeNull()
    expect(planOverflowCut([node(0, 100)], { targetTokens: 0, minRetainedNodes: 2 })).toBeNull()
  })
})
