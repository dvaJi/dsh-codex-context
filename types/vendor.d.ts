/**
 * Standalone development fallback types for the `@deepseek-ai/*` harness
 * packages.
 *
 * These ambient declarations mirror the signatures this plugin consumes, as
 * verified against the deepseek-harness sources. They exist so the package
 * typechecks, builds, and tests WITHOUT a dsh installation (the npm mirrors
 * hold stale RCs; several packages are workspace-internal). When you develop
 * against a real dsh source checkout, the packages resolve for real and this
 * file becomes redundant — remove it from `tsconfig.json` `include` in that
 * setup to typecheck against the authoritative types.
 *
 * The declarations are intentionally loose (`any`-shaped payloads) exactly
 * because they are a fallback, not a contract.
 */

// ── cordis ─────────────────────────────────────────────────────────────────

declare module '@deepseek-ai/cordis' {
  export interface Logger {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }

  export interface SystemPromptContextInput {
    name: string
    order: number
    text: string | ((context: { agent?: { session: import('@deepseek-ai/dsh-session').Session } }) => string)
  }

  export interface Context {
    on(event: string, handler: (...args: any[]) => unknown): () => void
    logger: Logger
    get(key: string): any
    tokenMeter: import('@deepseek-ai/dsh-token-meter').TokenMeter
    sessions: { flush(session: import('@deepseek-ai/dsh-session').Session): Promise<void> }
    tools: { register(tool: unknown): () => void }
    systemPrompt: { context(context: SystemPromptContextInput): () => void }
    llm: { stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<unknown> }
  }

  export class Service {
    constructor(ctx: Context, key: string)
    ctx: Context
  }
}

// ── dsh-llm ────────────────────────────────────────────────────────────────

declare module '@deepseek-ai/dsh-llm' {
  export interface TextBlock { type: 'text'; text: string }
  export interface ReasoningBlock { type: 'reasoning'; text: string }
  export interface ToolCallBlock { type: 'tool-call'; id: string; name: string; arguments: string }
  export interface ToolResultBlock {
    type: 'tool-result'
    toolCallId: string
    content: ContentBlock[]
    isError?: boolean
  }
  export interface ImageBlock { type: 'image'; attachment: unknown }
  export interface FileBlock { type: 'file'; attachment: unknown }
  export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock | ImageBlock | FileBlock

  export interface ContextSnapshotSection { name: string; text: string }

  export interface MessageSource {
    kind: string
    plugin?: string
    form?: string
    sections?: readonly ContextSnapshotSection[]
    callId?: string
    provider?: string
    model?: string
    [key: string]: unknown
  }

  export interface Message {
    id: string
    role: 'system' | 'user' | 'assistant'
    content: ContentBlock[]
    source: MessageSource
  }

  export interface UserMessage extends Message { role: 'user' }

  export interface ToolSchema {
    name: string
    description: string
    parameters: Record<string, unknown>
  }

  export type TokenUsage = Record<string, unknown>

  export type FinishReason =
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'max-tokens' }
    | { kind: 'aborted'; failure: { message: string; code: string } }
    | { kind: 'error'; failure: { message: string; code: string } }

  export interface LlmCallConfig {
    provider: string
    model: string
    [key: string]: unknown
  }

  export interface GenerateOptions {
    provider: string
    model: string
    messages: Message[]
    system?: string
    tools?: ToolSchema[]
    temperature?: number
    maxTokens?: number
    stop?: string[]
    signal?: AbortSignal
    sessionId?: string
    purpose?: 'compaction' | 'session-title'
  }

  export class BlockAssembler {
    push(chunk: unknown): void
    get finish(): FinishReason
    blocks(): ContentBlock[]
    get usage(): TokenUsage | undefined
  }

  export function createUserMessage(input: { content: ContentBlock[]; source: MessageSource }): UserMessage
  export function errorChain(error: unknown): string
  export const CONTEXT_WINDOW_EXCEEDED_CODE: string
  export class LlmError extends Error {}
}

// ── dsh-session ────────────────────────────────────────────────────────────

declare module '@deepseek-ai/dsh-session' {
  export type SessionSeq = number & { readonly __brand: 'SessionSeq' }
  export function SessionSeq(value: number): SessionSeq

  export interface SessionEvent {
    type: string
    seq: SessionSeq
    time: number
    data: any
    ignorable?: true
    surfaceOp?: 'append' | { op: 'replace'; start: SessionSeq; end: SessionSeq }
    sourceEventSeqs?: SessionSeq[]
  }

  export interface SessionSurface {
    nodes: readonly SessionSeq[]
    replaceGeneration: number
  }

  export interface EpochHeader {
    config: import('@deepseek-ai/dsh-llm').LlmCallConfig
    system?: string
    tools?: import('@deepseek-ai/dsh-llm').ToolSchema[]
  }

  export interface RequestContext {
    provider: string
    model: string
    contextWindow?: number
  }

  export class Session {
    get surface(): SessionSurface
    get id(): string
    get seq(): number
    eventAt(seq: SessionSeq): SessionEvent | undefined
    snapshotEvents(from?: number, to?: number): readonly SessionEvent[]
    requestHeader(): EpochHeader | undefined
    requestContext(): RequestContext | undefined
    deriveEventMessage(event: SessionEvent): import('@deepseek-ai/dsh-llm').Message | null
    append(
      type: string,
      data: unknown,
      opts?: { surfaceOp?: SessionEvent['surfaceOp']; sourceEventSeqs?: SessionSeq[] },
    ): SessionEvent
  }
}

// ── dsh-token-meter ────────────────────────────────────────────────────────

declare module '@deepseek-ai/dsh-token-meter' {
  import type { Session } from '@deepseek-ai/dsh-session'

  export interface TokenSurfaceNode {
    seq: number
    tokens: number
    heuristicTokens: number
  }

  export interface TokenMeasurement {
    logRevision: number
    baseline: unknown
    surfaceDeltaTokens: number
    totalTokens: number
    surfaceTokens: number
    nodes: readonly TokenSurfaceNode[]
  }

  export interface TokenMeter {
    measure(session: Session, requestHeader?: unknown): TokenMeasurement
    estimateMessage(message: import('@deepseek-ai/dsh-llm').Message): number
  }
}

// ── dsh-compaction ─────────────────────────────────────────────────────────

declare module '@deepseek-ai/dsh-compaction' {
  import type { Context } from '@deepseek-ai/cordis'
  import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
  import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'

  export type CompactionId = string & { readonly __brand: 'CompactionId' }
  export function CompactionId(id: string): CompactionId

  export type CompactionTrigger = 'pressure' | 'context-overflow'
  export type ManualCompactionErrorCode = 'busy' | 'cancelled' | 'changed' | 'summary' | 'commit' | 'persistence'

  export class ManualCompactionError extends Error {
    code: ManualCompactionErrorCode
    constructor(code: ManualCompactionErrorCode, message: string, options?: ErrorOptions)
  }

  export interface CompactionAgentContext {
    session: Session
    options: { provider?: string; model?: string }
  }

  export interface ManualCompactAgentContext extends CompactionAgentContext {
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  }

  export interface CompactionResult {
    compactionId: CompactionId
    sourceCommandId?: string
    startSeq: SessionSeq
    summarySeq: SessionSeq
    endSeq: SessionSeq
    summary: ContentBlock[]
    shadowedRange: { start: SessionSeq; end: SessionSeq }
    shadowedSeqs: SessionSeq[]
    shadowedTokenCount: number
  }

  export function compactCheckpointSource(compactionId: CompactionId, sourceCommandId?: string): MessageSource
  export function toolPairingBalancedBefore(session: Session, seq: SessionSeq): boolean
  export function toolPairingBalancedAfter(session: Session, seq: SessionSeq): boolean

  export abstract class CompactionEngine {
    constructor(ctx: Context)
    ctx: Context
    abstract compactIfNeeded(
      agent: CompactionAgentContext,
      trigger: CompactionTrigger,
      signal: AbortSignal,
    ): Promise<CompactionResult | null>
    abstract compactNow(
      agent: ManualCompactAgentContext,
      signal: AbortSignal,
      sourceCommandId?: string,
    ): Promise<CompactionResult | null>
    abstract compactRegion(
      start: SessionSeq,
      end: SessionSeq,
      agent: CompactionAgentContext,
      signal?: AbortSignal,
    ): Promise<CompactionResult>
  }
}

// ── dsh-tools ──────────────────────────────────────────────────────────────

declare module '@deepseek-ai/dsh-tools' {
  import type { ContentBlock } from '@deepseek-ai/dsh-llm'
  import type { Session } from '@deepseek-ai/dsh-session'

  export interface ParameterPropertySpec {
    type: string
    required?: true
    description?: string
    enum?: readonly string[]
    items?: unknown
    properties?: unknown
    additionalProperties?: boolean
  }

  export type ParameterSchemaSpec = Record<string, ParameterPropertySpec>

  type Primitive<P> = P extends { enum: readonly (infer E)[] } ? E
    : P extends { type: 'string' } ? string
    : P extends { type: 'integer' | 'number' } ? number
    : P extends { type: 'boolean' } ? boolean
    : unknown

  type InferArgs<S extends ParameterSchemaSpec> = {
    [K in keyof S as S[K] extends { required: true } ? K : never]: Primitive<S[K]>
  } & {
    [K in keyof S as S[K] extends { required: true } ? never : K]?: Primitive<S[K]>
  }

  export interface ToolRunContext {
    callId: string
    name: string
    arguments: unknown
    token: unknown
    agent?: { session: Session; options: { provider?: string; model?: string } }
    signal: AbortSignal
  }

  export interface ToolDefinition {
    name: string
    description: string
    parameters: unknown
    output: unknown
  }

  export function defineTool<const S extends ParameterSchemaSpec>(options: {
    name: string
    description: string
    parameters: S
    output: {
      schema: unknown
      render(args: InferArgs<S>, value: any): ContentBlock[]
      presentationMeta?(args: InferArgs<S>, value: any): unknown
    }
    timeoutMs?: number
    presentCall?(args: InferArgs<S>): { card: string; kind?: string; title: string } | undefined
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<unknown>
  }): ToolDefinition
}

// ── dsh-agent ──────────────────────────────────────────────────────────────

declare module '@deepseek-ai/dsh-agent' {
  export type PreStepDecision =
    | { kind: 'reject' }
    | { kind: 'enter'; messages: unknown[]; startsRequestSeries?: true }

  export type RequestErrorAction = { kind: 'retry' } | undefined
}

// ── dsh-commands/brand ─────────────────────────────────────────────────────

declare module '@deepseek-ai/dsh-commands/brand' {
  export type CommandId = string & { readonly __brand: 'CommandId' }
}

// ── dsh-compaction-tool-result-pruner (optional companion) ────────────────

declare module '@deepseek-ai/dsh-compaction-tool-result-pruner' {}

// ── schemastery ────────────────────────────────────────────────────────────

declare module '@deepseek-ai/schemastery' {
  interface Schema<T = unknown> {
    (value?: unknown): T
  }
  class Schema {
    static object(shape: Record<string, any>): Schema<any>
    static string(): any
    static number(): any
    static boolean(): any
    static array(item: any): any
  }
  export default Schema
}
