import type { AgentPreset, AppSettings, HarnessConfig, RecommendedModel } from './types'

export const DEFAULT_HARNESS: HarnessConfig = {
  maxSteps: 40,
  temperature: 0.7,
  parallelTools: true,
  loopGuard: 3,
  toolMode: 'auto',
  thinking: {
    mode: 'auto',
    adaptive: true,
    budgetTokens: 2048,
    simpleTaskMaxChars: 60
  },
  retryCount: 1,
  maxToolOutputChars: 24000,
  toolTimeoutSec: 180,
  autoTitle: true,
  // 本地 8B 模型在 32K 上下文下会明显变慢（KV cache 变大、容易落到 CPU），
  // 8K 对日常对话足够，任务模式也可以按需在设置里调大。
  maxOutputTokens: 4096,
  keepAliveMin: 30,
  context: {
    window: 8192,
    compressEnabled: true,
    compressMode: 'summary',
    thresholdPct: 75,
    keepRecentMessages: 8,
    periodic: false,
    periodicEveryTurns: 10
  },
  safety: {
    workspaceOnly: true,
    backupBeforeWrite: true,
    shellTimeoutSec: 120,
    backupRetentionDays: 7,
    denyPatterns: [
      'rm -rf /',
      'format ',
      'del /s /q c:',
      'rd /s /q c:',
      'shutdown',
      'reg delete',
      'diskpart',
      'bcdedit',
      'Remove-Item -Recurse -Force C:\\'
    ]
  },
  systemSuffix: ''
}

export const BUILTIN_AGENTS: AgentPreset[] = [
  {
    id: 'general',
    name: '通用助手',
    icon: '✳️',
    description: '能思考、能动手的全能助手，适合日常问答与任务执行。',
    category: 'general',
    builtin: true,
    systemPrompt:
      '你是 AIH 的通用智能体。先理解用户目标，再制定简短计划并执行。需要读写文件、运行命令或联网时主动使用工具。回答简洁准确，引用你查看过的文件路径与行号。',
    tools: ['list_dir', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'shell', 'web_search', 'web_fetch', 'todo_write', 'knowledge_search']
  },
  {
    id: 'frontend-engineer',
    name: '前端工程师',
    icon: '🎨',
    description: 'React / CSS / 交互实现，注重还原度与可维护性。',
    category: 'engineering',
    builtin: true,
    systemPrompt:
      '你是一名资深前端工程师。使用 React + TypeScript + 现代 CSS 实现界面，严格还原设计稿，处理响应式与可访问性。修改前先阅读相关文件；优先复用现有组件与样式变量。完成后说明改动文件与验证方式。',
    tools: ['list_dir', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'shell', 'web_fetch', 'todo_write']
  },
  {
    id: 'backend-engineer',
    name: '后端工程师',
    icon: '⚙️',
    description: 'API、数据库、性能与稳定性优先。',
    category: 'engineering',
    builtin: true,
    systemPrompt:
      '你是一名资深后端工程师。设计清晰的 API 与数据结构，关注错误处理、并发、性能与安全。修改代码前先阅读调用链，避免破坏既有契约。给出可执行的验证命令。',
    tools: ['list_dir', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'shell', 'todo_write']
  },
  {
    id: 'fullstack-engineer',
    name: '全栈工程师',
    icon: '🧱',
    description: '从数据库到界面的端到端交付。',
    category: 'engineering',
    builtin: true,
    systemPrompt:
      '你是一名全栈工程师。按“数据层 → 接口层 → 界面层”的顺序推进，保持跨层契约一致。小步修改、及时验证，避免一次性大重构。',
    tools: ['list_dir', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'shell', 'web_search', 'web_fetch', 'todo_write']
  },
  {
    id: 'ppt-maker',
    name: 'PPT 制作者',
    icon: '📊',
    description: '梳理大纲、组织叙事并生成演示文稿内容。',
    category: 'office',
    builtin: true,
    systemPrompt:
      '你是一名演示文稿设计专家。先确认受众与目标，再输出结构化大纲（10-20 页），每页包含标题、要点、讲述提示与视觉建议。语言精炼，数据准确，避免空洞口号。需要输出文件时生成 Markdown 或 HTML 幻灯片。',
    tools: ['list_dir', 'read_file', 'write_file', 'web_search', 'web_fetch', 'todo_write']
  },
  {
    id: 'writer',
    name: '文案写手',
    icon: '✍️',
    description: '公众号、产品文案、营销长文与润色。',
    category: 'writing',
    builtin: true,
    systemPrompt:
      '你是一名中文文案专家。先明确受众、渠道与目标，再写作。语言具体、有画面感，拒绝套话。提供 2 个版本供选择时可说明差异。除非用户要求，不要使用夸张营销词。',
    tools: ['read_file', 'write_file', 'web_search', 'web_fetch']
  },
  {
    id: 'data-analyst',
    name: '数据分析师',
    icon: '📈',
    description: '清洗数据、统计分析并给出可执行结论。',
    category: 'data',
    builtin: true,
    systemPrompt:
      '你是一名数据分析师。先检查数据质量与字段含义，再用脚本完成清洗与统计，明确口径与假设。结论必须由数据支撑，输出关键指标、图表建议与下一步行动。',
    tools: ['list_dir', 'read_file', 'write_file', 'edit_file', 'shell', 'glob', 'grep', 'todo_write']
  },
  {
    id: 'code-reviewer',
    name: '代码审查员',
    icon: '🔍',
    description: '只读审查，找出真实缺陷与风险。',
    category: 'engineering',
    builtin: true,
    systemPrompt:
      '你是一名严格的代码审查员。以只读方式工作，不修改文件。重点关注正确性、并发、边界条件、安全与性能，忽略纯风格偏好。每条问题给出文件路径、行号、原因与修复建议。',
    tools: ['list_dir', 'read_file', 'glob', 'grep', 'shell']
  },
  {
    id: 'harness-engineer',
    name: 'Harness 工程师',
    icon: '🧠',
    description: '为小模型编写技能、提示词与工作流。',
    category: 'general',
    builtin: true,
    systemPrompt:
      '你是一名 Agent Harness 工程师。帮助用户为本地小模型设计清晰的角色、工具使用规则、分步工作流与自检清单。输出可直接使用的系统提示词或 skill 文档，避免依赖模型不具备的能力。',
    tools: ['list_dir', 'read_file', 'write_file', 'edit_file', 'web_search', 'web_fetch', 'todo_write']
  }
]

export const RECOMMENDED_MODELS: RecommendedModel[] = [
  {
    id: 'qwen2.5:7b',
    name: 'Qwen2.5 7B',
    publisher: '阿里通义',
    params: '7B',
    sizeBytes: 4.7e9,
    minRamGb: 8,
    description: '中文能力优秀，工具调用稳定，适合日常对话与轻量 Agent。',
    tags: ['中文推荐', '工具调用'],
    modes: ['chat'],
    ollamaTag: 'qwen2.5:7b',
    downloadUrl: 'https://ollama.com/library/qwen2.5',
    mirrorUrl: 'https://modelscope.cn/models/Qwen/Qwen2.5-7B-Instruct',
    gguf: { repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', sizeBytes: 4.68e9 }
  },
  {
    id: 'qwen2.5-coder:7b',
    name: 'Qwen2.5 Coder 7B',
    publisher: '阿里通义',
    params: '7B',
    sizeBytes: 4.7e9,
    minRamGb: 8,
    description: '代码补全与重构能力强，适合 8GB 显存笔记本。',
    tags: ['代码', '工具调用'],
    modes: ['code'],
    ollamaTag: 'qwen2.5-coder:7b',
    downloadUrl: 'https://ollama.com/library/qwen2.5-coder',
    mirrorUrl: 'https://modelscope.cn/models/Qwen/Qwen2.5-Coder-7B-Instruct',
    gguf: { repo: 'unsloth/Qwen2.5-Coder-7B-Instruct-GGUF', file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', sizeBytes: 4.68e9 }
  },
  {
    id: 'deepseek-r1:8b',
    name: 'DeepSeek R1 8B',
    publisher: 'DeepSeek',
    params: '8B',
    sizeBytes: 5.2e9,
    minRamGb: 10,
    description: '推理链清晰，适合解题、分析与规划类任务。',
    tags: ['推理'],
    modes: ['reasoning'],
    ollamaTag: 'deepseek-r1:8b',
    downloadUrl: 'https://ollama.com/library/deepseek-r1',
    mirrorUrl: 'https://modelscope.cn/models/deepseek-ai/DeepSeek-R1-Distill-Llama-8B',
    gguf: { repo: 'unsloth/DeepSeek-R1-Distill-Llama-8B-GGUF', file: 'DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf', sizeBytes: 4.92e9 }
  },
  {
    id: 'llama3.1:8b',
    name: 'Llama 3.1 8B',
    publisher: 'Meta',
    params: '8B',
    sizeBytes: 4.9e9,
    minRamGb: 8,
    description: '通用英文能力均衡，生态与插件兼容性好。',
    tags: ['通用'],
    modes: ['chat'],
    ollamaTag: 'llama3.1:8b',
    downloadUrl: 'https://ollama.com/library/llama3.1',
    gguf: { repo: 'unsloth/Llama-3.1-8B-Instruct-GGUF', file: 'Llama-3.1-8B-Instruct-Q4_K_M.gguf', sizeBytes: 4.92e9 }
  },
  {
    id: 'gemma2:9b',
    name: 'Gemma 2 9B',
    publisher: 'Google',
    params: '9B',
    sizeBytes: 5.4e9,
    minRamGb: 12,
    description: '写作与知识问答表现稳定，支持较长上下文。',
    tags: ['写作'],
    modes: ['chat'],
    ollamaTag: 'gemma2:9b',
    downloadUrl: 'https://ollama.com/library/gemma2',
    mirrorUrl: 'https://modelscope.cn/models/google/gemma-2-9b-it',
    gguf: { repo: 'bartowski/gemma-2-9b-it-GGUF', file: 'gemma-2-9b-it-Q4_K_M.gguf', sizeBytes: 5.76e9 }
  },
  {
    id: 'qwen2.5-vl:7b',
    name: 'Qwen2.5-VL 7B',
    publisher: '阿里通义',
    params: '7B',
    sizeBytes: 6.0e9,
    minRamGb: 12,
    description: '多模态视觉理解，可识别截图、图表与图片。',
    tags: ['视觉'],
    modes: ['vision'],
    ollamaTag: 'qwen2.5vl:7b',
    downloadUrl: 'https://ollama.com/library/qwen2.5vl',
    mirrorUrl: 'https://modelscope.cn/models/Qwen/Qwen2.5-VL-7B-Instruct'
  },
  {
    id: 'deepseek-coder-v2:16b',
    name: 'DeepSeek Coder V2 16B',
    publisher: 'DeepSeek',
    params: '16B',
    sizeBytes: 8.9e9,
    minRamGb: 16,
    description: '更强代码理解与长文件编辑能力，适合台式机。',
    tags: ['代码', '进阶'],
    modes: ['code'],
    ollamaTag: 'deepseek-coder-v2:16b',
    downloadUrl: 'https://ollama.com/library/deepseek-coder-v2'
  },
  {
    id: 'nomic-embed-text',
    name: 'Nomic Embed Text',
    publisher: 'Nomic',
    params: '137M',
    sizeBytes: 2.7e8,
    minRamGb: 2,
    description: '轻量向量模型，用于知识库语义检索。',
    tags: ['向量', '知识库'],
    modes: ['embedding'],
    ollamaTag: 'nomic-embed-text',
    downloadUrl: 'https://ollama.com/library/nomic-embed-text'
  },
  {
    id: 'qwen3:8b',
    name: 'Qwen3 8B',
    publisher: '阿里通义',
    params: '8B',
    sizeBytes: 5.2e9,
    minRamGb: 12,
    description: '新一代中文通用模型，支持思考模式与工具调用，8GB 显存可运行。',
    tags: ['中文推荐', '工具调用', '思考'],
    modes: ['chat', 'reasoning'],
    ollamaTag: 'qwen3:8b',
    downloadUrl: 'https://ollama.com/library/qwen3',
    mirrorUrl: 'https://modelscope.cn/models/Qwen/Qwen3-8B',
    runtime: 'ollama',
    gguf: { repo: 'Qwen/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', sizeBytes: 5.03e9 }
  },
  {
    id: 'qwen3:14b',
    name: 'Qwen3 14B',
    publisher: '阿里通义',
    params: '14B',
    sizeBytes: 9.0e9,
    minRamGb: 20,
    description: '更强推理与代码能力，建议 12GB 以上显存或 24GB 内存。',
    tags: ['进阶', '工具调用'],
    modes: ['chat', 'reasoning', 'code'],
    ollamaTag: 'qwen3:14b',
    downloadUrl: 'https://ollama.com/library/qwen3',
    mirrorUrl: 'https://modelscope.cn/models/Qwen/Qwen3-14B',
    runtime: 'ollama',
    gguf: { repo: 'Qwen/Qwen3-14B-GGUF', file: 'Qwen3-14B-Q4_K_M.gguf', sizeBytes: 9.0e9 }
  },
  {
    id: 'gemma3:12b',
    name: 'Gemma 3 12B',
    publisher: 'Google',
    params: '12B',
    sizeBytes: 8.1e9,
    minRamGb: 16,
    description: '支持多模态与长上下文，写作与图像理解均衡。',
    tags: ['视觉', '长上下文'],
    modes: ['chat', 'vision'],
    ollamaTag: 'gemma3:12b',
    downloadUrl: 'https://ollama.com/library/gemma3',
    mirrorUrl: 'https://modelscope.cn/models/google/gemma-3-12b-it',
    runtime: 'ollama'
  },
  {
    id: 'phi4:14b',
    name: 'Phi-4 14B',
    publisher: 'Microsoft',
    params: '14B',
    sizeBytes: 9.1e9,
    minRamGb: 20,
    description: '数学、逻辑与推理表现突出，适合分析与解题。',
    tags: ['推理', '数学'],
    modes: ['reasoning'],
    ollamaTag: 'phi4:14b',
    downloadUrl: 'https://ollama.com/library/phi4',
    gguf: { repo: 'bartowski/phi-4-GGUF', file: 'phi-4-Q4_K_M.gguf', sizeBytes: 9.05e9 }
  },
  {
    id: 'glm4:9b',
    name: 'GLM-4 9B',
    publisher: '智谱 AI',
    params: '9B',
    sizeBytes: 5.5e9,
    minRamGb: 12,
    description: '中文理解与工具调用稳定，适合国内办公场景。',
    tags: ['中文', '工具调用'],
    modes: ['chat'],
    ollamaTag: 'glm4:9b',
    downloadUrl: 'https://ollama.com/library/glm4',
    mirrorUrl: 'https://modelscope.cn/models/ZhipuAI/GLM-4-9B-0414'
  },
  {
    id: 'deepseek-r1:14b',
    name: 'DeepSeek R1 14B',
    publisher: 'DeepSeek',
    params: '14B',
    sizeBytes: 9.0e9,
    minRamGb: 20,
    description: '推理链更完整的蒸馏版本，适合复杂分析与规划。',
    tags: ['推理', '进阶'],
    modes: ['reasoning'],
    ollamaTag: 'deepseek-r1:14b',
    downloadUrl: 'https://ollama.com/library/deepseek-r1',
    mirrorUrl: 'https://modelscope.cn/models/deepseek-ai/DeepSeek-R1-Distill-Qwen-14B',
    gguf: { repo: 'unsloth/DeepSeek-R1-Distill-Qwen-14B-GGUF', file: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf', sizeBytes: 8.99e9 }
  },
  {
    id: 'minicpm-v:8b',
    name: 'MiniCPM-V 8B',
    publisher: '面壁智能',
    params: '8B',
    sizeBytes: 5.5e9,
    minRamGb: 12,
    description: '轻量视觉理解模型，适合截图、表格与文档识别。',
    tags: ['视觉', '轻量'],
    modes: ['vision'],
    ollamaTag: 'minicpm-v:8b',
    downloadUrl: 'https://ollama.com/library/minicpm-v',
    mirrorUrl: 'https://modelscope.cn/models/OpenBMB/MiniCPM-V-2_6'
  },
  {
    id: 'wan2.1-t2v-1.3b',
    name: 'Wan2.1 T2V 1.3B',
    publisher: '阿里通义万相',
    params: '1.3B',
    sizeBytes: 2.8e9,
    minRamGb: 16,
    vramGb: 8,
    description: '本地文生视频入门模型，可通过 ComfyUI 或 Diffusers 运行，生成 480P 短视频。',
    tags: ['视频生成', '文生视频', 'ComfyUI'],
    modes: ['video'],
    downloadUrl: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B',
    mirrorUrl: 'https://modelscope.cn/models/Wan-AI/Wan2.1-T2V-1.3B',
    runtime: 'comfyui'
  },
  {
    id: 'wan2.1-t2v-14b',
    name: 'Wan2.1 T2V 14B',
    publisher: '阿里通义万相',
    params: '14B',
    sizeBytes: 2.2e10,
    minRamGb: 32,
    vramGb: 24,
    description: '高质量文生视频模型，建议 24GB 显存，需 ComfyUI / Diffusers。',
    tags: ['视频生成', '高质量'],
    modes: ['video'],
    downloadUrl: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-14B',
    mirrorUrl: 'https://modelscope.cn/models/Wan-AI/Wan2.1-T2V-14B',
    runtime: 'comfyui'
  },
  {
    id: 'ltx-video-2b',
    name: 'LTX-Video 2B',
    publisher: 'Lightricks',
    params: '2B',
    sizeBytes: 4.0e9,
    minRamGb: 16,
    vramGb: 12,
    description: '生成速度快，支持文生视频与图生视频，适合 12GB 显存。',
    tags: ['视频生成', '快速'],
    modes: ['video'],
    downloadUrl: 'https://huggingface.co/Lightricks/LTX-Video',
    mirrorUrl: 'https://modelscope.cn/models/Lightricks/LTX-Video',
    runtime: 'diffusers'
  },
  {
    id: 'cogvideox-2b',
    name: 'CogVideoX 2B',
    publisher: '智谱 AI',
    params: '2B',
    sizeBytes: 5.0e9,
    minRamGb: 16,
    vramGb: 12,
    description: '中文文生视频模型，生态完善，适合 12GB 显存起步。',
    tags: ['视频生成', '中文'],
    modes: ['video'],
    downloadUrl: 'https://huggingface.co/THUDM/CogVideoX-2b',
    mirrorUrl: 'https://modelscope.cn/models/ZhipuAI/CogVideoX-2b',
    runtime: 'diffusers'
  },
  {
    id: 'hunyuanvideo',
    name: 'HunyuanVideo',
    publisher: '腾讯混元',
    params: '13B',
    sizeBytes: 2.5e10,
    minRamGb: 48,
    vramGb: 24,
    description: '高质量中文视频生成模型，配置要求高，建议 24GB 以上显存。',
    tags: ['视频生成', '高质量', '高配置'],
    modes: ['video'],
    downloadUrl: 'https://huggingface.co/tencent/HunyuanVideo',
    mirrorUrl: 'https://modelscope.cn/models/Tencent-Hunyuan/HunyuanVideo',
    runtime: 'diffusers'
  },
  {
    id: 'svd-xt',
    name: 'Stable Video Diffusion XT',
    publisher: 'Stability AI',
    params: '1.5B',
    sizeBytes: 9.5e9,
    minRamGb: 24,
    vramGb: 16,
    description: '经典图生视频模型，输入一张图片生成数秒视频。',
    tags: ['视频生成', '图生视频'],
    modes: ['video'],
    downloadUrl: 'https://huggingface.co/stabilityai/stable-video-diffusion-img2vid-xt',
    mirrorUrl: 'https://modelscope.cn/models/AI-ModelScope/stable-video-diffusion-img2vid-xt',
    runtime: 'diffusers'
  }
]

export const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh',
  theme: 'light',
  onboardingDone: false,
  fullAccessAcknowledged: false,
  defaultPermissionMode: 'ask',
  pluginCatalogUrl: '',
  mcpApprovedHashes: [],
  autoUpdateCheck: true,
  ui: {
    fontSize: 'normal',
    showReasoning: true,
    sendOnEnter: true,
    showTokenUsage: true,
    compactSidebar: false
  },
  harness: DEFAULT_HARNESS,
  harnessSnapshots: [],
  modelSettings: {
    providers: [],
    defaultModel: null,
    installedModelIds: [],
    detectedBinaryPaths: {},
    toolProtocol: {}
  },
  webSearch: { enabled: true, endpoint: 'https://duckduckgo.com/html/?q=' },
  lastModel: null
}

export const APP_NAME = 'AIH'
export const APP_FULL_NAME = 'AIH · AI HOUSE'
