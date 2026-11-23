/** 评测（eval）相关的共享类型：主进程跑任务，渲染层展示结果 */
export type EvalTaskCategory = 'file' | 'edit' | 'shell' | 'search' | 'reason' | 'safety'

export interface EvalTaskInfo {
  id: string
  title: string
  category: EvalTaskCategory
  /** 期望用到的工具，用于统计工具使用是否合理 */
  expectTools?: string[]
  mode?: 'task' | 'chat'
}

export interface EvalTaskResult extends EvalTaskInfo {
  ok: boolean
  /** 失败原因（通过时为空） */
  reason?: string
  durationMs: number
  tokens: number
  toolCalls: number
  /** 思考内容字符数：用于观察自适应思考是否生效 */
  thinkingChars: number
  finalText: string
  error?: string
}

export interface EvalSummary {
  total: number
  passed: number
  successRate: number
  avgDurationMs: number
  avgTokens: number
  totalThinkingChars: number
}

export interface EvalReport {
  startedAt: number
  finishedAt: number
  model: string
  provider: string
  tasks: EvalTaskResult[]
  summary: EvalSummary
  workspaceRoot: string
  /** 报告 JSON 的落盘路径 */
  reportPath?: string
}

export type EvalPhase = 'start' | 'task-start' | 'task-done' | 'done' | 'error' | 'cancelled'

export interface EvalEvent {
  phase: EvalPhase
  index?: number
  total?: number
  taskId?: string
  title?: string
  result?: EvalTaskResult
  report?: EvalReport
  message?: string
}

export interface EvalRunOptions {
  taskIds?: string[]
  /** 覆盖使用的模型（不传则用当前默认模型） */
  model?: { providerId: string; modelId: string; label: string }
}
