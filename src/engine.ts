/**
 * Codex-style window compaction engine for `ctx.compaction`.
 *
 * Replaces the shipped LLM-summarizing backend with the experimental
 * `context_management` architecture from Codex 0.153:
 *
 * - **Token-budgeted sliding window** — when the surface's priced token total
 *   exceeds the effective budget (config `targetActiveTokens`, capped at
 *   `emergencyThresholdRatio` of a routed context window too small to reach
 *   it), the oldest balanced span is shadowed with a model-free template
 *   checkpoint until the retained tail fits the budget.
 * - **Lossless by construction** — dsh's session log is append-only; the
 *   window replacement shadows nodes via `surfaceOp: 'replace'` and the raw
 *   events stay in the log forever. `search_history` reads them back.
 * - **Pair-safe cuts** — both edges are snapped to boundaries validated with
 *   the compaction seam's `toolPairingBalancedBefore/After`, so a tool call is
 *   never separated from its result (Codex's `normalize` invariants).
 * - **Emergency parachute** — when routine step pressure crosses
 *   `emergencyThresholdRatio` of the routed model's context window, the
 *   engine writes a real model summary instead of the template checkpoint,
 *   mirroring Codex's auto-compact: windowing is the routine regime,
 *   summarization is the safety net. Provider-confirmed overflows skip the
 *   parachute (a near-limit model call could not be trusted to succeed) and
 *   always use the template window; a failed parachute degrades to the same
 *   template instead of leaving the session stuck above the budget.
 *
 * The durable transaction follows the compaction seam contract: tail-inspected
 * lock (`compaction/start` … `compaction/end` bracket), whole-surface or
 * selected-span stability revalidation, shrink validation against the token
 * meter, and one close attempt per failure.
 *
 * @module dsh-codex-context
 */

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  CompactionEngine,
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type {
  CompactionAgentContext,
  CompactionResult,
  CompactionTrigger,
  ManualCompactAgentContext,
} from '@deepseek-ai/dsh-compaction'
import {
  BlockAssembler,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  errorChain,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmCallConfig,
  Message,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
// Type-only: makes the optional sibling service visible to `ctx.get()`.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { assertValidConfig, CodexContextConfigSchema, type CodexContextConfig } from './config.js'
import { renderCheckpoint } from './template.js'
import { registerNotes, NotesStore } from './notes.js'
import { registerSearch } from './search.js'
import { planOverflowCut, planWindowCut, type WindowCutPlan, type WindowNode } from './window.js'

/** Provenance for messages this plugin synthesizes (except checkpoints, which use the seam's marker). */
const PLUGIN_NAME = 'dsh-codex-context'
/** Envelope recorded on template checkpoints in `compaction/summary`. */
const TEMPLATE_PROVIDER = 'dsh-codex-context'
const TEMPLATE_MODEL = 'window-template'

/** Replayed conversation prefix the summarizer condenses (prefix-cache aligned). */
interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

/** Safe summary content plus the envelope recorded with it. */
type SummaryResult = {
  summary: readonly ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | { rawOutput: readonly ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: readonly ContentBlock[]; llmStreamCall?: never }
)

/** One validated inclusive span of current surface positions. */
interface SurfaceSelection {
  readonly start: SessionSeq
  readonly end: SessionSeq
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly SessionSeq[]
}

interface TransactionOptions {
  readonly owner: 'current-turn' | null
  readonly stability: 'whole-surface' | 'selected-span'
  readonly flush?: () => Promise<void>
  readonly sourceCommandId?: CommandId
}

interface CompactionEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent | undefined
  readonly latestEndSeedSeq: SessionSeq | undefined
}

/** Whether the prepared summary may still replace the span it was built from. */
type StabilityCheck = (session: Session, prepared: PreparedCompaction) => void

/** Priced surface nodes, the stability comparison unit. */
type PricedNodes = TokenMeasurement['nodes']

interface PreparedCompaction {
  readonly selection: SurfaceSelection
  readonly measurement: TokenMeasurement
  readonly selectedNodes: TokenMeasurement['nodes']
  readonly shadowedTokenCount: number
  readonly shadowedRouteTokenCount: number
}

/**
 * `ctx.compaction` provider implementing the Codex-style lossless window.
 * Also registers the `update_notes` and `search_history` model tools and the
 * pinned notes context, so a single bundle row installs the full architecture.
 */
export class CodexContextEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']

  static Config: typeof CodexContextConfigSchema = CodexContextConfigSchema

  /** Resolved plugin configuration. */
  readonly config: CodexContextConfig

  private readonly notes: NotesStore
  private readonly overflowRetries = new WeakMap<object, number>()

  constructor(ctx: Context, config: CodexContextConfig) {
    super(ctx)
    this.config = config
    assertValidConfig(this.config)
    this.notes = registerNotes(ctx, this.config)
    registerSearch(ctx, this.config)
    if (this.config.auto) this._registerAutomaticWindowing()
  }

  // ── automatic triggers ────────────────────────────────────────────────────

  private _registerAutomaticWindowing(): void {
    const { ctx } = this

    ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
      if (!signal.aborted) {
        try {
          const result = await this.compactIfNeeded(agent, 'pressure', signal)
          if (result !== null) this.logResult(result, 'window (step pressure)')
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`dsh-codex-context: windowing failed: ${message}; continuing the turn`)
        }
      }
      return next()
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    ctx.on('agent/request-error', async ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      const retries = this.overflowRetries.get(agent) ?? 0
      if (retries >= this.config.maxOverflowRetries) return next()

      const generation = agent.session.surface.replaceGeneration
      let result: CompactionResult | null
      try {
        result = await this.compactIfNeeded(agent, 'context-overflow', signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        // Durable surface progress is sufficient retry proof even when later
        // work threw; cancellation still wins.
        if (!signal.aborted && agent.session.surface.replaceGeneration > generation) {
          this.overflowRetries.set(agent, retries + 1)
          ctx.logger.warn(
            `dsh-codex-context: overflow windowing failed after durable progress: ${message}; retrying`,
          )
          return { kind: 'retry' }
        }
        ctx.logger.warn(`dsh-codex-context: overflow windowing failed: ${message}`)
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      if (result !== null) this.logResult(result, 'window (context overflow recovery)')
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  // ── CompactionEngine contract ─────────────────────────────────────────────

  /**
   * Window for step-boundary pressure or one provider-confirmed context
   * overflow. Pressure compares the priced surface against the effective
   * budget (the configured `targetActiveTokens`, capped at the emergency
   * ratio of the routed context window when that window is smaller);
   * overflow forces a maximal balanced head reduction. The real model
   * summary (the parachute) is reserved for routine pressure near the
   * routed window's emergency ratio; overflow recovery is always the
   * model-free template window because a further near-limit model call
   * could not be trusted to succeed.
   */
  override async compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const meter = this.ctx.tokenMeter
    const session = agent.session
    // The pressure budget is the configured active-window target, capped at
    // the routed model's emergency ratio for context windows smaller than
    // targetActiveTokens / emergencyThresholdRatio: such a window can never
    // reach the configured target, so the engine must window pre-emptively at
    // ratio × contextWindow instead of waiting for a provider-confirmed
    // overflow on every long turn.
    const { budget, capped } = this.windowingBudget(session)
    let measurement = meter.measure(session)
    if (trigger === 'pressure' && measurement.totalTokens <= budget) return null

    // The optional pruner is model-free; land it before selecting a span and
    // remeasure — it may remove the need to window at all.
    const pruner = this.ctx.get('toolResultPruner')
    if (pruner !== undefined) {
      pruner.pruneSession(session)
      measurement = meter.measure(session)
      if (trigger === 'pressure' && measurement.totalTokens <= budget) return null
    }

    const plan = this.selectPlan(session, measurement, trigger, budget)
    if (plan === null) return null
    // The emergency parachute is pre-emptive only. Once the provider has
    // confirmed a context overflow, recovery must be the model-free template
    // window: a further near-limit model call replays nearly the whole log
    // and would most likely fail again, blocking the only reduction that can
    // actually succeed.
    const useSummary = trigger === 'pressure' && this.shouldSummarize(session, measurement, capped)
    const head = agent.session.surface.nodes[0]
    const tail = agent.session.surface.nodes[plan.cutIdx - 1]
    if (head === undefined || tail === undefined) {
      throw new Error('dsh-codex-context: planned span is not present on the current surface')
    }
    return this.runTransaction(
      agent,
      head,
      tail,
      plan,
      useSummary,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

  /**
   * One useful model-free reduction even below the budget: shadow the maximal
   * balanced head span (the retained tail keeps `minRetainedNodes` nodes).
   * Runs as idle maintenance; `/compact` arrives here.
   */
  override compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    try {
      return agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          const measurement = this.ctx.tokenMeter.measure(agent.session)
          const nodes = this.surfaceWindowNodes(agent.session, measurement)
          const plan = planOverflowCut(nodes, {
            targetTokens: this.config.targetActiveTokens,
            minRetainedNodes: this.config.minRetainedNodes,
          })
          if (plan === null || plan.shadowed.length === 0) return null
          const surfaceNodes = agent.session.surface.nodes
          const head = surfaceNodes[0]
          const tail = surfaceNodes[plan.cutIdx - 1]
          if (head === undefined || tail === undefined) {
            throw new Error('dsh-codex-context: planned span is not present on the current surface')
          }
          return await this.runTransaction(
            agent,
            head,
            tail,
            plan,
            /* useSummary */ false,
            {
              owner: null,
              stability: 'selected-span',
              flush: async () => {
                await this.ctx.sessions.flush(agent.session)
              },
              ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
            },
            operationSignal,
          )
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual windowing was cancelled', { cause: error })
          }
          operationSignal.throwIfAborted()
          throw error
        }
      })
    } catch (error: unknown) {
      // A classified transaction failure ('changed', 'summary', 'commit',
      // persistence') must reach the /compact command as itself, not as a
      // misleading 'busy'. Only failures that predate the transaction (the
      // agent is not idle or the maintenance admission was refused) get the
      // busy classification.
      if (error instanceof ManualCompactionError) throw error
      throw new ManualCompactionError(
        'busy',
        'manual windowing requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }

  /** Forcibly window one inclusive surface range into a template checkpoint. */
  override async compactRegion(
    start: SessionSeq,
    end: SessionSeq,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    const nodes = this.surfaceWindowNodes(agent.session, measurement)
    const startIdx = nodes.findIndex(node => node.seq === Number(start))
    const endIdx = nodes.findIndex(node => node.seq === Number(end))
    if (startIdx === -1) throw new Error(`windowing: start seq ${String(start)} not found in surface`)
    if (endIdx === -1) throw new Error(`windowing: end seq ${String(end)} not found in surface`)
    if (startIdx > endIdx) {
      throw new Error(`windowing: start seq ${String(start)} is after end seq ${String(end)} on the surface`)
    }
    const plan: WindowCutPlan = {
      cutIdx: startIdx,
      shadowed: nodes.slice(startIdx, endIdx + 1),
      retained: nodes.slice(endIdx + 1),
      shadowedTokens: nodes.slice(startIdx, endIdx + 1).reduce((sum, node) => sum + node.tokens, 0),
      retainedTokens: nodes.slice(endIdx + 1).reduce((sum, node) => sum + node.tokens, 0),
      reason: 'overflow',
    }
    return this.runTransaction(
      agent,
      start,
      end,
      plan,
      /* useSummary */ false,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

  // ── selection ─────────────────────────────────────────────────────────────

  /** Price the current surface and decorate every node with boundary facts. */
  private surfaceWindowNodes(session: Session, measurement: TokenMeasurement): WindowNode[] {
    const surfaceNodes = session.surface.nodes
    if (surfaceNodes.length !== measurement.nodes.length
      || surfaceNodes.some((seq, index) => seq !== measurement.nodes[index]?.seq)) {
      throw new Error('dsh-codex-context: token-meter surface does not match the current session surface')
    }
    return surfaceNodes.map((seq, index) => {
      const event = session.eventAt(seq)
      return {
        seq: Number(seq),
        tokens: measurement.nodes[index]?.tokens ?? 0,
        balancedBefore: toolPairingBalancedBefore(session, seq),
        isUserTurnStart: event?.type === 'user/message',
      }
    })
  }

  private selectPlan(
    session: Session,
    measurement: TokenMeasurement,
    trigger: CompactionTrigger,
    budget: number,
  ): WindowCutPlan | null {
    const nodes = this.surfaceWindowNodes(session, measurement)
    const options = {
      targetTokens: budget,
      minRetainedNodes: this.config.minRetainedNodes,
    }
    const plan = trigger === 'context-overflow'
      ? planOverflowCut(nodes, options)
      : planWindowCut(nodes, options)
    if (plan === null || plan.shadowed.length === 0) return null
    return plan
  }

  /**
   * Resolve the effective active-window budget for one session. When the
   * routed model's context window is too small to ever reach
   * `targetActiveTokens`, the budget is capped at `emergencyThresholdRatio`
   * of that window so routine windowing keeps requests inside it; otherwise
   * the configured target stands.
   */
  private windowingBudget(session: Session): { budget: number; capped: boolean } {
    const target = this.config.targetActiveTokens
    const contextWindow = session.requestContext()?.contextWindow
    if (contextWindow === undefined || contextWindow <= 0) return { budget: target, capped: false }
    const cap = Math.floor(contextWindow * this.config.emergencyThresholdRatio)
    // `<=` on purpose: when the cap equals the target (contextWindow =
    // target / ratio) windowing and the parachute would otherwise fire on the
    // very same pressure and summarize every routine cut.
    if (cap <= target) return { budget: cap, capped: true }
    return { budget: target, capped: false }
  }

  /**
   * Parachute decision: summarize only when the metered pressure crosses the
   * emergency ratio of the routed model's context window — Codex permits its
   * auto-compact only near the limit and windows the rest of the time. A
   * budget already capped by that same ratio leaves nothing for the
   * parachute to add, so the model-free regime applies.
   */
  private shouldSummarize(session: Session, measurement: TokenMeasurement, budgetCapped: boolean): boolean {
    if (!this.config.emergencySummarization || budgetCapped) return false
    const contextWindow = session.requestContext()?.contextWindow
    if (contextWindow === undefined || contextWindow <= 0) return false
    return measurement.totalTokens / contextWindow >= this.config.emergencyThresholdRatio
  }

  // ── durable transaction ───────────────────────────────────────────────────

  /**
   * Run the bracketed surface-replacement transaction over the planned span:
   * lock, prepare, summarize (template or model), revalidate stability,
   * shrink-check, commit the replacement, and release the lock with exactly
   * one close attempt per failure.
   */
  private async runTransaction(
    agent: CompactionAgentContext,
    start: SessionSeq,
    end: SessionSeq,
    plan: WindowCutPlan,
    useSummary: boolean,
    options: TransactionOptions,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    const session = agent.session
    if (options.owner === null) signal?.throwIfAborted()

    const selection = validateSurfaceRegion(session, start, end)
    const entryState = inspectCompactionEntryState(session)
    assertCompactionInactive(entryState, 'windowing')

    let owner: number | null
    if (options.owner === null) {
      if (entryState.openTurn !== null) {
        throw new ManualCompactionError('busy', 'manual windowing: the session already has an open turn')
      }
      owner = null
    } else {
      if (entryState.openTurn === null) {
        throw new Error('windowing: no open turn — automatic windowing events must be enclosed in a turn')
      }
      owner = entryState.openTurn
    }

    const compactionId = CompactionId(randomUUID())
    const lifecycle: {
      compactionId: ReturnType<typeof CompactionId>
      turn: number | null
      sourceCommandId?: CommandId
    } = {
      compactionId,
      turn: owner,
      ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }),
    }
    const startEvent = session.append('compaction/start', lifecycle)

    const measureNodes = (target: Session): TokenMeasurement['nodes'] => this.ctx.tokenMeter.measure(target).nodes
    const assertStable: StabilityCheck = options.stability === 'whole-surface'
      ? (target, prepared) => assertWholeSurfaceUnchanged(measureNodes, target, prepared)
      : (target, prepared) => assertSelectedSpanStable(measureNodes, target, prepared)

    let closed = false
    let closing = false
    let stage: 'summary' | 'commit' = 'summary'
    let failure: { error: unknown; stage: 'summary' | 'commit' } | undefined
    let flushFailure: unknown
    let result: CompactionResult | undefined

    try {
      const prepared = this.prepareCompaction(session, selection)
      const summarized = await this.summarizeSpan(agent, prepared, plan, useSummary, compactionId, options.sourceCommandId, signal)
      if (options.owner === null) signal?.throwIfAborted()
      assertStable(session, prepared)
      stage = 'commit'
      const pending = this.commitCompactionBody(session, startEvent, prepared, summarized)
      closing = true
      const endEvent = session.append('compaction/end', lifecycle)
      closed = true
      result = { ...pending, endSeq: endEvent.seq }
    } catch (error: unknown) {
      failure = { error, stage: closing ? 'commit' : stage }
      if (!closing) {
        closing = true
        try {
          session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
          closed = true
        } catch (closeError: unknown) {
          failure = { error: closeError, stage: 'commit' }
        }
      }
    }

    if (closed && options.flush !== undefined) {
      try {
        await options.flush()
      } catch (error: unknown) {
        flushFailure = error
      }
    }

    if (options.owner === null) signal?.throwIfAborted()
    if (failure !== undefined) {
      if (options.owner === null) throwManualFailure(failure)
      throw failure.error
    }
    if (flushFailure !== undefined) {
      throw new ManualCompactionError('persistence', 'manual windowing durability checkpoint failed', { cause: flushFailure })
    }
    if (result === undefined) throw new Error('windowing committed without a result')
    return result
  }

  /** Snapshot pricing for a validated span and verify it matches the plan. */
  private prepareCompaction(session: Session, selection: SurfaceSelection): PreparedCompaction {
    const measurement = this.ctx.tokenMeter.measure(session)
    const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
    if (selectedNodes.length !== selection.shadowedSeqs.length
      || selectedNodes.some((node, index) => node?.seq !== selection.shadowedSeqs[index])) {
      throw new SurfaceChangedError('dsh-codex-context: the selected surface changed before windowing began')
    }
    return {
      selection,
      measurement,
      selectedNodes,
      // The shadow-price protocol prices replacements with the fixed
      // heuristic; shrink validation reads the route-priced total.
      shadowedTokenCount: selectedNodes.reduce((total, node) => total + (node?.heuristicTokens ?? 0), 0),
      shadowedRouteTokenCount: selectedNodes.reduce((total, node) => total + (node?.tokens ?? 0), 0),
    }
  }

  /** Produce the replacement content: a template checkpoint or an emergency model summary. */
  private async summarizeSpan(
    agent: CompactionAgentContext,
    prepared: PreparedCompaction,
    plan: WindowCutPlan,
    useSummary: boolean,
    compactionId: ReturnType<typeof CompactionId>,
    sourceCommandId: CommandId | undefined,
    signal?: AbortSignal,
  ): Promise<{ result: SummaryResult; checkpointText: string }> {
    let result: SummaryResult
    let summaryTexts: readonly string[]
    if (useSummary) {
      // The parachute is best-effort decoration on top of the routine
      // template regime: when it fails for any reason short of cancellation
      // (route errors, capacity, truncation, an empty answer), fall back to
      // the model-free checkpoint instead of aborting the window — a lost
      // summary must never leave the session stuck above the budget.
      try {
        result = await summarizeWithLlm(this.ctx, this.config, buildSummarizationInput(agent.session, prepared.selection), agent, signal)
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.logger.warn(
          `dsh-codex-context: emergency summarization failed (${message}); using the template checkpoint instead`,
        )
        result = {
          summary: [],
          provider: TEMPLATE_PROVIDER,
          model: TEMPLATE_MODEL,
        }
      }
      summaryTexts = result.summary
        .map(block => block.type === 'text' ? block.text : '')
        .filter(text => text.length > 0)
    } else {
      result = {
        summary: [],
        provider: TEMPLATE_PROVIDER,
        model: TEMPLATE_MODEL,
      }
      summaryTexts = []
    }
    const checkpointText = renderCheckpoint({
      shadowedCount: plan.shadowed.length,
      shadowedTokens: plan.shadowedTokens,
      retrievalHint: this.config.retrievalHint,
      ...(summaryTexts.length > 0 ? { summary: summaryTexts } : {}),
    })

    // Shrink validation: the framed replacement must lower the next request's
    // pressure relative to the span it shadows.
    const checkpointMessage = createUserMessage({
      content: [{ type: 'text', text: checkpointText }],
      source: compactCheckpointSource(compactionId, sourceCommandId),
    })
    const framedTokens = this.ctx.tokenMeter.estimateMessage(checkpointMessage)
    if (framedTokens >= prepared.shadowedRouteTokenCount) {
      throw new Error(
        `checkpoint is not smaller than the shadowed content (${framedTokens} estimated framed tokens `
        + `>= ${prepared.shadowedRouteTokenCount})`,
      )
    }
    return { result, checkpointText }
  }

  /** Append the summary record and the replacement body without yielding. */
  private commitCompactionBody(
    session: Session,
    startEvent: SessionEvent,
    prepared: PreparedCompaction,
    summarized: { result: SummaryResult; checkpointText: string },
  ): Omit<CompactionResult, 'endSeq'> {
    const { selection } = prepared
    const { result } = summarized
    const summaryBlocks: ContentBlock[] = result.summary.length > 0
      ? [...result.summary]
      : [{ type: 'text', text: summarized.checkpointText }]
    const summaryEvent = session.append('compaction/summary', {
      compactionId: startEvent.data.compactionId,
      ...startEvent.data.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: startEvent.data.sourceCommandId },
      summary: summaryBlocks,
      shadowedRange: { start: selection.start, end: selection.end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount: prepared.shadowedTokenCount,
      provider: result.provider,
      model: result.model,
      ...(result.maxTokens === undefined ? {} : { maxTokens: result.maxTokens }),
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      ...(result.rawOutput === undefined ? {} : { rawOutput: [...result.rawOutput] }),
      ...(result.llmStreamCall === true ? { llmStreamCall: true as const } : {}),
    })
    const checkpointMessage = createUserMessage({
      content: [{ type: 'text', text: summarized.checkpointText }],
      source: compactCheckpointSource(
        startEvent.data.compactionId,
        startEvent.data.sourceCommandId,
      ),
    })
    session.append('user/message', checkpointMessage, {
      surfaceOp: { op: 'replace', start: selection.start, end: selection.end },
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.shadowedSeqs],
    })
    return {
      compactionId: startEvent.data.compactionId,
      ...startEvent.data.sourceCommandId === undefined
        ? {}
        : { sourceCommandId: startEvent.data.sourceCommandId },
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      summary: summaryBlocks,
      shadowedRange: { start: selection.start, end: selection.end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount: prepared.shadowedTokenCount,
    }
  }

  private logResult(result: CompactionResult, trigger: string): void {
    this.ctx.logger.info(
      `dsh-codex-context (${trigger}): shadowed ${result.shadowedSeqs.length} surface nodes `
      + `(~${result.shadowedTokenCount} tokens) behind the active window; the log keeps everything retrievable`,
    )
  }
}

// ── module-level transaction helpers ───────────────────────────────────────

/** Validate one requested surface-position span before asynchronous work begins. */
function validateSurfaceRegion(session: Session, start: SessionSeq, end: SessionSeq): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`windowing: start seq ${String(start)} not found in surface`)
  if (endIdx === -1) throw new Error(`windowing: end seq ${String(end)} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `windowing: start seq ${String(start)} (position ${startIdx}) is after end seq ${String(end)} (position ${endIdx})`,
    )
  }
  if (!toolPairingBalancedBefore(session, nodes[startIdx] ?? start)) {
    throw new Error(`windowing: start seq ${String(start)} is not a balanced boundary (would split a tool-call/result pair)`)
  }
  // The right edge matters as much as the left one: a span that ends before an
  // unanswered tool call (or whose tool result outlives its call) leaves the
  // surface pair-unbalanced and corrupts every later replay fold.
  if (!toolPairingBalancedAfter(session, nodes[endIdx] ?? end)) {
    throw new Error(`windowing: end seq ${String(end)} is not a balanced boundary (would split a tool-call/result pair)`)
  }
  const shadowedSeqs: SessionSeq[] = nodes.slice(startIdx, endIdx + 1)
  return { start, end, startIdx, endIdx, shadowedSeqs }
}

/** Reconstruct open-turn, unmatched-compaction, and seed-boundary state. */
function inspectCompactionEntryState(session: Session): CompactionEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: SessionSeq | undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

/** Reject a live lock unless a newer seed boundary proves it stale. */
function assertCompactionInactive(entryState: CompactionEntryState, stage: string): void {
  if (entryState.unmatchedCompactionStart === undefined
    || (entryState.latestEndSeedSeq !== undefined
      && entryState.latestEndSeedSeq > entryState.unmatchedCompactionStart.seq)) return
  throw new ManualCompactionError(
    'busy',
    `${stage}: the session compaction lock is already active`,
  )
}

/**
 * Rejects a checkpoint whose replacement boundaries are no longer the ones it
 * was built from, distinguished from summarizer and shrink failures so a
 * manual caller can report the two causes differently.
 */
class SurfaceChangedError extends Error {}

/** Reject a summary prepared against any earlier surface generation. */
function assertWholeSurfaceUnchanged(
  measureNodes: (session: Session) => PricedNodes,
  session: Session,
  prepared: PreparedCompaction,
): void {
  if (!isDeepStrictEqual(measureNodes(session), prepared.measurement.nodes)) {
    throw new SurfaceChangedError('dsh-codex-context: session surface changed during windowing')
  }
}

/** Require only that the selected span remain present, ordered, pair-balanced, and equally priced. */
function assertSelectedSpanStable(
  measureNodes: (session: Session) => PricedNodes,
  session: Session,
  prepared: PreparedCompaction,
): void {
  let current: SurfaceSelection
  try {
    current = validateSurfaceRegion(session, prepared.selection.start, prepared.selection.end)
  } catch (error) {
    throw new SurfaceChangedError(
      'dsh-codex-context: the selected span is no longer a valid replacement target',
      { cause: error },
    )
  }
  if (!isDeepStrictEqual([...current.shadowedSeqs], [...prepared.selection.shadowedSeqs])) {
    throw new SurfaceChangedError('dsh-codex-context: the selected span changed during windowing')
  }
  const span = measureNodes(session).slice(current.startIdx, current.endIdx + 1)
  if (!isDeepStrictEqual(span, prepared.selectedNodes)) {
    throw new SurfaceChangedError('dsh-codex-context: the selected span was rewritten during windowing')
  }
}

/** Resolve the exact provider/model durably routed for the latest request. */
function routedTarget(session: Session): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

/** Replay the shadowed region plus the request prefix for cache-aligned summarization. */
function buildSummarizationInput(session: Session, selection: SurfaceSelection): SummarizationInput {
  const header = session.requestHeader()
  const messages: Message[] = []
  for (const seq of selection.shadowedSeqs) {
    const event = session.eventAt(seq)
    if (event === undefined) {
      throw new Error(`windowing: event ${String(seq)} disappeared from the log during windowing`)
    }
    const message = session.deriveEventMessage(event)
    if (message !== null) messages.push(message)
  }
  return {
    ...(header?.system === undefined ? {} : { system: header.system }),
    ...(header?.tools === undefined ? {} : { tools: header.tools }),
    messages,
  }
}

/**
 * Emergency summarization: one direct `ctx.llm.stream()` call that replays the
 * conversation's own system prompt, tools, and the shadowed region, then asks
 * for a structured checkpoint — the same cache-reusing shape the shipped
 * backend uses, fired only near the context limit.
 */
async function summarizeWithLlm(
  ctx: Context,
  config: CodexContextConfig,
  input: SummarizationInput,
  agent: CompactionAgentContext,
  signal?: AbortSignal,
): Promise<SummaryResult> {
  const configured = config.summarizationProvider.length > 0 && config.summarizationModel.length > 0
    ? { provider: config.summarizationProvider, model: config.summarizationModel }
    : undefined
  const agentTarget = agent.options.provider !== undefined && agent.options.provider.length > 0
    && agent.options.model !== undefined && agent.options.model.length > 0
    ? { provider: agent.options.provider, model: agent.options.model }
    : undefined
  const target = configured ?? routedTarget(agent.session) ?? agentTarget
  if (target === undefined) {
    throw new Error(
      'dsh-codex-context: no provider/model available for emergency summarization; '
      + 'set summarizationProvider/summarizationModel or route one request first',
    )
  }

  const assembler = new BlockAssembler()
  const messages: Message[] = [
    ...input.messages,
    createUserMessage({
      content: [{ type: 'text', text: EMERGENCY_SUMMARIZATION_INSTRUCTION }],
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    }),
  ]
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages,
    ...(input.system === undefined ? {} : { system: input.system }),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    maxTokens: config.emergencyMaxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
  const error = finishError(assembler.finish)
  if (error !== undefined) throw error

  const rawOutput = assembler.blocks()
  const summary = rawOutput.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('emergency summarization produced no text content')
  }
  return {
    summary,
    rawOutput,
    llmStreamCall: true,
    provider: options.provider,
    model: options.model,
    maxTokens: config.emergencyMaxTokens,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** Structured checkpoint instruction for the emergency summarizer. */
const EMERGENCY_SUMMARIZATION_INSTRUCTION = [
  'You are now acting as an emergency compaction engine for this AI coding assistant: the conversation is near the model context limit. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was archived.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
].join('\n')

/** Map a terminal summarization finish to its fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error('emergency summarization truncated at the token cap (incomplete checkpoint)') as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure: { error: unknown; stage: 'summary' | 'commit' }): never {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError('commit', 'manual windowing did not commit cleanly', { cause: failure.error })
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError('changed', 'the windowed history changed during manual windowing', { cause: failure.error })
  }
  throw new ManualCompactionError('summary', 'manual windowing could not produce a smaller checkpoint', { cause: failure.error })
}

export default CodexContextEngine
