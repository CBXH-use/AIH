import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, promises as fsp, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EvalEvent, EvalReport, EvalRunOptions, EvalTaskResult, EvalSummary } from '@shared/eval'
import { evalTasksByIds, type EvalContext, type EvalTask } from '@shared/evalTasks'
import type { ChatMessage, ModelRef, PermissionMode, Provider, Session } from '@shared/types'
import type { Store } from './store'
import type { ModelService } from './modelService'
import type { KnowledgeService } from './knowledgeService'
import type { PluginService } from './pluginService'
import type { AttachmentService } from './attachments'
import { ChatEngine } from './chatEngine'

const TASK_TIMEOUT_MS = 240_000
const EVAL_DIR = 'eval-workspaces'
const REPORT_DIR = 'eval-reports'

export interface EvalServiceDeps {
  store: Store
  models: ModelService
  knowledge: KnowledgeService
  plugins: PluginService
  attachments: AttachmentService
  userDataDir: string
  emit?: (event: EvalEvent) => void
}

export interface EvalRunInternalOptions extends EvalRunOptions {
  /** 临时供应商（自检/mock 模型用），不会写入长期设置 */
  provider?: Provider
  permissionMode?: PermissionMode
  signal?: AbortSignal
}

function messageText(message: ChatMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/**
 * 评测服务：在临时工作区里让 Agent 真正执行 20 条任务，再用校验函数判定结果。
 * 每次运行都会落盘 JSON 报告（成功率 / 平均耗时 / token / 思考量），方便比较模型和版本。
 */
export class EvalService {
  private deps: EvalServiceDeps
  private running: { id: string; cancel: () => void } | null = null

  constructor(deps: EvalServiceDeps) {
    this.deps = deps
  }

  get isRunning(): boolean {
    return !!this.running
  }

  list(): EvalTask[] {
    return evalTasksByIds()
  }

  cancel() {
    this.running?.cancel()
  }

  private emit(event: EvalEvent) {
    try {
      this.deps.emit?.(event)
    } catch {
      /* 事件失败不影响评测 */
    }
  }

  /** 解析并准备本次评测使用的 provider/model；临时 provider 会写进设置（仅当前数据目录） */
  private resolveModel(options: EvalRunInternalOptions): { ref: ModelRef; provider: Provider } {
    if (options.provider) {
      const provider = options.provider
      const existing = this.deps.store.settings.modelSettings.providers || []
      const next = [...existing.filter((p) => p.id !== provider.id), provider]
      this.deps.store.updateSettings({
        modelSettings: { ...this.deps.store.settings.modelSettings, providers: next }
      })
      const ref: ModelRef = options.model || {
        providerId: provider.id,
        modelId: (provider.models && provider.models[0]) || 'default',
        label: `${provider.name} · ${(provider.models && provider.models[0]) || 'default'}`
      }
      return { ref, provider }
    }
    const ref = options.model || this.deps.store.settings.lastModel
    if (!ref) throw new Error('请先选择一个模型再运行评测')
    const provider =
      this.deps.models.getProviders().find((p) => p.id === ref.providerId) ||
      (this.deps.store.settings.modelSettings.providers || []).find((p) => p.id === ref.providerId)
    if (!provider) throw new Error(`找不到模型供应商 ${ref.providerId}`)
    return { ref, provider }
  }

  async run(options: EvalRunInternalOptions = {}): Promise<EvalReport> {
    if (this.running) throw new Error('评测正在运行')
    const { ref, provider } = this.resolveModel(options)
    const tasks = evalTasksByIds(options.taskIds)
    if (!tasks.length) throw new Error('没有匹配的评测任务')

    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`
    const workspaceRoot = join(this.deps.userDataDir, EVAL_DIR, runId)
    mkdirSync(workspaceRoot, { recursive: true })
    const startedAt = Date.now()

    let cancelled = false
    const controllers = new Set<string>()
    const engine = new ChatEngine({
      store: this.deps.store,
      models: this.deps.models,
      knowledge: this.deps.knowledge,
      plugins: this.deps.plugins,
      attachments: this.deps.attachments,
      emit: () => undefined,
      emitApproval: () => undefined,
      // 评测无人值守：需要审批的高风险操作一律拒绝（readonly-guard 任务依赖这个行为）
      requestApproval: async () => 'deny',
      // 评测在临时工作区里运行，shell 任务需要「完全放行」才能验证
      fullAccessOverride: true
    })
    this.running = {
      id: runId,
      cancel: () => {
        cancelled = true
        for (const id of controllers) engine.stop(id)
      }
    }

    this.emit({ phase: 'start', total: tasks.length, taskId: '', title: `${ref.label}` })
    const results: EvalTaskResult[] = []
    try {
      for (let i = 0; i < tasks.length; i++) {
        if (cancelled || options.signal?.aborted) break
        const task = tasks[i]
        this.emit({ phase: 'task-start', index: i, total: tasks.length, taskId: task.id, title: task.title })
        const result = await this.runTask(engine, task, {
          runId,
          workspaceRoot,
          ref,
          permissionMode: task.permissionMode || options.permissionMode || 'auto-safe',
          controllers,
          isCancelled: () => cancelled || !!options.signal?.aborted
        })
        results.push(result)
        this.emit({
          phase: 'task-done',
          index: i,
          total: tasks.length,
          taskId: task.id,
          title: task.title,
          result
        })
      }
    } finally {
      this.running = null
    }

    const passed = results.filter((r) => r.ok).length
    const summary: EvalSummary = {
      total: results.length,
      passed,
      successRate: results.length ? Math.round((passed / results.length) * 1000) / 10 : 0,
      avgDurationMs: average(results.map((r) => r.durationMs)),
      avgTokens: average(results.map((r) => r.tokens)),
      totalThinkingChars: results.reduce((sum, r) => sum + r.thinkingChars, 0)
    }
    const report: EvalReport = {
      startedAt,
      finishedAt: Date.now(),
      model: ref.label || ref.modelId,
      provider: provider.id,
      tasks: results,
      summary,
      workspaceRoot
    }
    try {
      const reportDir = join(this.deps.userDataDir, REPORT_DIR)
      await fsp.mkdir(reportDir, { recursive: true })
      const reportPath = join(reportDir, `eval-${runId}.json`)
      await fsp.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
      report.reportPath = reportPath
    } catch {
      /* 报告落盘失败不影响返回 */
    }
    if (cancelled) this.emit({ phase: 'cancelled', report, message: '评测已取消' })
    else this.emit({ phase: 'done', report })
    return report
  }

  private async runTask(
    engine: ChatEngine,
    task: EvalTask,
    ctx: {
      runId: string
      workspaceRoot: string
      ref: ModelRef
      permissionMode: PermissionMode
      controllers: Set<string>
      isCancelled: () => boolean
    }
  ): Promise<EvalTaskResult> {
    const started = Date.now()
    const workspace = join(ctx.workspaceRoot, task.id)
    try {
      await fsp.rm(workspace, { recursive: true, force: true })
      await fsp.mkdir(workspace, { recursive: true })
      for (const [rel, content] of Object.entries(task.setup || {})) {
        const full = join(workspace, rel)
        await fsp.mkdir(join(full, '..'), { recursive: true })
        await fsp.writeFile(full, content, 'utf8')
      }
    } catch (err) {
      return this.failure(task, 0, `准备工作区失败：${String(err)}`)
    }

    const sessionId = `eval-${ctx.runId}-${task.id}`
    const session: Session = {
      id: sessionId,
      title: `[eval] ${task.title}`,
      projectId: 'default',
      mode: task.mode || 'task',
      agentId: 'general',
      model: ctx.ref,
      permissionMode: ctx.permissionMode,
      messages: [],
      workspaceDir: workspace,
      archived: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'idle',
      tokenUsage: { input: 0, output: 0, compressed: 0 },
      knowledgeBaseIds: []
    }
    this.deps.store.upsertSession(session)
    ctx.controllers.add(sessionId)
    try {
      const before = Date.now()
      await engine.send(sessionId, task.prompt)
      await Promise.race([
        engine.waitForRun(sessionId),
        new Promise<void>((resolve) => setTimeout(resolve, TASK_TIMEOUT_MS))
      ])
      if (engine.isRunning(sessionId)) engine.stop(sessionId)
      const stored = this.deps.store.getSession(sessionId)
      const messages = stored?.messages || []
      const usage = stored?.tokenUsage || { input: 0, output: 0, compressed: 0 }
      const toolCalls = messages.flatMap((m) =>
        m.parts
          .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'tool-call' }> => p.type === 'tool-call')
          .map((p) => ({ name: p.call.name, arguments: p.call.arguments }))
      )
      const toolResults = messages.flatMap((m) =>
        m.parts
          .filter((p): p is Extract<ChatMessage['parts'][number], { type: 'tool-result' }> => p.type === 'tool-result')
          .map((p) => ({ name: p.result.name, ok: p.result.ok, output: p.result.output }))
      )
      const thinkingChars = messages.reduce(
        (sum, m) => sum + m.parts.filter((p) => p.type === 'reasoning').reduce((s, p) => s + (p.type === 'reasoning' ? p.text.length : 0), 0),
        0
      )
      const finalText = messages
        .filter((m) => m.role === 'assistant')
        .map((m) => messageText(m))
        .join('\n')
        .trim()
      const evalCtx: EvalContext = {
        workspace,
        read: (rel) => {
          try {
            const full = join(workspace, rel)
            return existsSync(full) ? readFileSync(full, 'utf8') : null
          } catch {
            return null
          }
        },
        exists: (rel) => existsSync(join(workspace, rel)),
        list: (rel = '') => {
          try {
            return readdirSync(join(workspace, rel), { withFileTypes: true })
              .filter((e) => e.isFile())
              .map((e) => e.name)
          } catch {
            return []
          }
        },
        toolCalls,
        toolResults,
        finalText
      }
      let reason: string | null = null
      try {
        reason = task.validate(evalCtx)
      } catch (err) {
        reason = `校验函数异常：${String(err)}`
      }
      return {
        id: task.id,
        title: task.title,
        category: task.category,
        expectTools: task.expectTools,
        mode: task.mode,
        ok: reason === null,
        reason: reason || undefined,
        durationMs: Date.now() - before,
        tokens: usage.input + usage.output,
        toolCalls: toolCalls.length,
        thinkingChars,
        finalText: finalText.slice(0, 800)
      }
    } catch (err) {
      return {
        ...this.failure(task, Date.now() - started, err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - started
      }
    } finally {
      ctx.controllers.delete(sessionId)
      this.deps.store.deleteSession(sessionId)
    }
  }

  private failure(task: EvalTask, durationMs: number, error: string): EvalTaskResult {
    return {
      id: task.id,
      title: task.title,
      category: task.category,
      expectTools: task.expectTools,
      mode: task.mode,
      ok: false,
      reason: error,
      error,
      durationMs,
      tokens: 0,
      toolCalls: 0,
      thinkingChars: 0,
      finalText: ''
    }
  }
}

function average(values: number[]): number {
  if (!values.length) return 0
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}
