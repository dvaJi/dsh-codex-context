/**
 * Pure sliding-window cut planning over a priced session surface.
 *
 * This module is deliberately dependency-free: it models the current surface as
 * an ordered array of priced nodes with boundary-safety flags and decides which
 * head span to move into "cold storage" so the retained tail fits a token
 * budget. The engine (engine.ts) feeds it real measurements from
 * `ctx.tokenMeter` and validates the chosen edges with the compaction seam's
 * tool-pairing helpers before anything durable happens.
 *
 * Semantics mirror the experimental `context_management` architecture from
 * Codex 0.153 (`codex-rs/core/src/context_manager/`):
 * - the active window is bounded by a token budget, not a message count;
 * - cuts land on safe boundaries so a tool call is never separated from its
 *   result (the `normalize` invariants) and user turns stay intact;
 * - a minimum number of recent nodes is always retained verbatim.
 *
 * @module dsh-codex-context/window
 */

/** One priced surface node as the planner sees it. */
export interface WindowNode {
  /** Durable sequence number of the surface event. */
  readonly seq: number
  /** Route-priced request tokens for this node (from the token meter). */
  readonly tokens: number
  /**
   * Whether cutting immediately before this node is pair-safe: no assistant
   * tool call crosses the boundary unanswered. In the engine this comes from
   * `toolPairingBalancedBefore(session, seq)`.
   */
  readonly balancedBefore: boolean
  /**
   * Whether this node begins a user turn in the derived history. Cuts prefer
   * user-turn starts (Codex cuts on user turns; a user message must never be
   * separated from the assistant response it produced).
   */
  readonly isUserTurnStart: boolean
}

/** A planned cut: shadow surface nodes `[0, cutIdx)` and retain `[cutIdx, end)`. */
export interface WindowCutPlan {
  /** Index into the node array of the first retained node. */
  readonly cutIdx: number
  /** Shadowed head nodes, in surface order (the span moved to cold storage). */
  readonly shadowed: readonly WindowNode[]
  /** Retained tail nodes, in surface order (the active window). */
  readonly retained: readonly WindowNode[]
  /** Sum of the shadowed nodes' priced tokens. */
  readonly shadowedTokens: number
  /** Sum of the retained nodes' priced tokens. */
  readonly retainedTokens: number
  /** Why the plan chose this boundary; useful for diagnostics. */
  readonly reason: 'budget' | 'budget-fallback' | 'overflow'
}

export interface WindowPlanOptions {
  /** Target token budget for the retained active window. */
  readonly targetTokens: number
  /** Minimum number of recent nodes always retained verbatim. */
  readonly minRetainedNodes: number
}

/**
 * Plan a budget cut. Returns `null` when the surface already fits the budget
 * or no safe cut exists.
 */
export function planWindowCut(
  nodes: readonly WindowNode[],
  options: WindowPlanOptions,
): WindowCutPlan | null {
  const total = nodes.reduce((sum, node) => sum + node.tokens, 0)
  if (total <= options.targetTokens) return null
  return planFrom(nodes, options.minRetainedNodes, options.targetTokens, 'budget')
}

/**
 * Overflow plan: free the maximum possible balanced head span while still
 * retaining `minRetainedNodes` recent nodes. Used for provider-confirmed
 * context-overflow recovery, where the next request cannot succeed without a
 * large reduction.
 */
export function planOverflowCut(
  nodes: readonly WindowNode[],
  options: WindowPlanOptions,
): WindowCutPlan | null {
  if (nodes.length === 0) return null
  return planFrom(nodes, options.minRetainedNodes, options.targetTokens, 'overflow')
}

/**
 * Shared planner.
 *
 * Budget mode mirrors the reference implementation's backwards walk: starting
 * from the newest node, accumulate the retained tail's tokens; every pair-safe
 * boundary inside the retention minimum is recorded as it passes; when the
 * accumulated window first reaches `targetTokens` the most recent recorded
 * boundary wins. If the whole surface fits before any boundary is recorded,
 * the newest safe boundary is used as a conservative fallback so a legal cut
 * still frees something.
 *
 * Overflow mode frees the maximum: it cuts at the newest safe boundary,
 * keeping exactly `minRetainedNodes` recent nodes.
 */
function planFrom(
  nodes: readonly WindowNode[],
  minRetainedNodes: number,
  targetTokens: number,
  reason: WindowCutPlan['reason'],
): WindowCutPlan | null {
  const total = nodes.reduce((sum, node) => sum + node.tokens, 0)
  // The newest index whose cut keeps at least `minRetainedNodes` nodes.
  const newestAllowedCut = nodes.length - minRetainedNodes
  if (newestAllowedCut < 1) return null

  const isSafe = (index: number): boolean => {
    const node = nodes[index]
    return node !== undefined && node.balancedBefore
  }

  let cutIdx = -1
  if (reason === 'overflow') {
    // Maximal balanced head reduction: the newest safe boundary wins.
    for (let i = newestAllowedCut; i >= 1; i -= 1) {
      if (isSafe(i)) {
        cutIdx = i
        break
      }
    }
  } else {
    let lastSafe = -1
    let crossed = false
    let acc = 0
    for (let i = nodes.length - 1; i >= 1; i -= 1) {
      const node = nodes[i]
      if (node === undefined) continue
      acc += node.tokens
      // The boundary is recorded only while the window built so far still
      // fits the target: the cut lands at the newest boundary that keeps the
      // retained tail under budget, never at the node that crossed it.
      if (acc >= targetTokens) {
        crossed = true
        break
      }
      if (i <= newestAllowedCut && isSafe(i)) lastSafe = i
    }
    cutIdx = lastSafe
    // The walk finished below budget without a usable boundary: fall back to
    // the newest safe boundary so a legal cut still frees something.
    if (cutIdx !== -1 && !crossed) reason = 'budget-fallback'
  }
  if (cutIdx === -1) return null

  const shadowed = nodes.slice(0, cutIdx)
  const retained = nodes.slice(cutIdx)
  const shadowedTokens = shadowed.reduce((sum, node) => sum + node.tokens, 0)
  return {
    cutIdx,
    shadowed,
    retained,
    shadowedTokens,
    retainedTokens: total - shadowedTokens,
    reason,
  }
}
