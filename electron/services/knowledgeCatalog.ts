import type { CatalogKnowledgeBase } from '@shared/types'

/**
 * 内置离线知识包内容：AIH Harness 使用手册。
 * 无网络时也能直接安装，覆盖本地模型、权限、插件与知识库用法。
 */
const AIH_MANUAL = `# AIH Harness 使用手册

AIH（AI HOUSE）是一个本地优先的 AI Agent 工作台。它把模型、工具、插件与知识库组合成可运行的智能体，会话、设置与数据默认保存在本机。

## 一、快速开始
1. 在「模型」页选择本地运行时，或填写 OpenAI 兼容接口。
2. 选择默认模型，新建会话即可对话。
3. 需要读写文件或执行命令时，Agent 会请求工具权限。
4. 在「知识库」页导入资料，会话中勾选后即可自动检索。

## 二、本地模型
AIH 支持 Ollama、LM Studio、llama.cpp 与任意 OpenAI 兼容服务。本地模型不联网、不上传数据，适合隐私敏感场景。
显存估算：7B 模型 4bit 量化约需 5GB 显存，14B 约 10GB，32B 约 20GB；显存不足时会回退到 CPU，速度明显下降。
推荐组合：日常问答用 7B 级别中文模型；代码任务选择代码专精模型；长文档分析选择上下文窗口 32K 以上的模型。
如果扫描不到模型，请确认运行时已启动、端口正确（Ollama 默认 11434，LM Studio 默认 1234），并在设置中手动填写二进制路径。模型文件通常放在运行时的默认模型目录，也可以手动指定模型目录。

## 三、权限与安全
AIH 提供四种权限模式：
- 只读：仅允许读取文件与查看信息，不执行任何写入。
- 询问：每个写操作、命令执行都需要人工确认。
- 自动安全：低风险操作自动执行，高风险操作仍会询问。
- 完全：不再逐条确认，仅建议在隔离环境中使用。

安全策略默认开启工作区限制，Agent 只能访问当前工作区；写文件前会备份原文件；危险命令会按拦截规则拒绝执行。审批卡片会展示命令、参数和风险原因，确认前请仔细核对路径与参数。
所有工具调用都会写入审计日志，可在数据目录下的 audit 文件夹中查看。

## 四、工具与插件
内置工具包括列目录、读文件、写文件、编辑文件、文件搜索、内容搜索、执行命令、联网搜索、抓取网页、待办清单与知识库检索。
插件分为工具、智能体、技能、MCP 与界面五类。声明式插件只通过 HTTP 调用外部接口，不执行任意代码；MCP 插件用于接入外部服务。插件可以在「插件」页安装、启用、禁用或卸载，禁用后其工具不会出现在模型的工具列表中。
安装插件前请确认来源可信，尤其是包含 MCP 启动命令的插件。启用插件后建议在新会话中测试其工具是否可用。

## 五、知识库
知识库用于把私有资料变成可检索的上下文。支持的格式包括 txt、md、json、jsonl、csv、日志与常见代码文件，单个文件不超过 8MB，一次最多导入 300 个文件；文件夹会递归读取，并自动跳过 node_modules、.git、dist、out 等目录与二进制文件。
导入时按段落切块，每块约 900 字，保留标题行并带少量重叠，便于连续阅读。检索使用 BM25 排序，中文按双字切分，英文和数字按词切分，返回最相关的若干片段。
在会话中勾选知识库后，系统会把命中的片段连同来源标题注入上下文，并受预算限制，避免挤占模型窗口。回答应引用来源标题，找不到依据时应明确说明，而不是编造。
知识包可以在「知识库」页的目录中一键安装。离线时会展示内置手册，联网后可以下载公开资料。导出的训练集为 JSONL 对话格式，可直接用于 LoRA 微调，文件保存在数据目录的 knowledge-exports 文件夹。

## 六、常见问题
- 回答很慢：检查是否在使用 CPU 推理，或调小上下文窗口。
- 找不到文件：确认文件在工作区内，且权限模式允许读取。
- 检索不到内容：换用更具体的查询词，或确认知识库已完成导入。
- 下载知识包失败：检查网络，或改用镜像链接后手动导入。

提示：请定期备份数据目录，其中包含会话、设置、知识库分块与训练数据导出。`

/** 目录条目在 CatalogKnowledgeBase 基础上补充标签，供界面筛选与文档标记 */
export type CatalogEntry = CatalogKnowledgeBase & { tags: string[] }

/**
 * 精选知识包目录。
 * installUrl 为空表示内容内置；hf-dataset 仅提供可打开的链接，不在应用内下载。
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'cat-aih-manual',
    name: 'AIH Harness 使用手册',
    description: '离线内置手册：本地模型接入、权限模式、插件系统与知识库用法，适合作为第一份上手资料。',
    docs: [],
    updatedAt: 0,
    recommendedFor: ['通用助手', '新手引导', '本地部署'],
    sizeBytes: 4600,
    minRamGb: 0,
    installUrl: '',
    format: 'text',
    tags: ['AIH', '手册', '本地模型', '权限', '插件', '知识库']
  },
  {
    id: 'cat-python-zh',
    name: 'Python 官方教程（中文入门）',
    description: 'Python 官方中文教程的入门章节，涵盖解释器使用、数值、字符串、列表与编程初体验。',
    docs: [],
    updatedAt: 0,
    recommendedFor: ['通用助手', '后端工程师', '数据分析'],
    sizeBytes: 73000,
    minRamGb: 0.5,
    installUrl: 'https://docs.python.org/zh-cn/3/tutorial/introduction.html',
    format: 'text',
    tags: ['Python', '编程', '官方文档', '中文']
  },
  {
    id: 'cat-mdn-js',
    name: 'MDN JavaScript 指南（中文）',
    description: 'MDN 中文 JavaScript 指南导论，介绍语言基础、运行环境与学习路径，适合前端入门查阅。',
    docs: [],
    updatedAt: 0,
    recommendedFor: ['前端工程师', '通用助手'],
    sizeBytes: 230000,
    minRamGb: 0.5,
    installUrl: 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide/Introduction',
    format: 'text',
    tags: ['JavaScript', 'MDN', '前端', 'Web']
  },
  {
    id: 'cat-rust-book-zh',
    name: 'Rust 程序设计语言（中文版）',
    description: 'Rust 官方书籍中文翻译的完整合订页，覆盖所有权、结构体、枚举、错误处理、泛型与并发。',
    docs: [],
    updatedAt: 0,
    recommendedFor: ['后端工程师', '系统开发'],
    sizeBytes: 1750000,
    minRamGb: 1,
    installUrl: 'https://kaisery.github.io/trpl-zh-cn/print.html',
    format: 'text',
    tags: ['Rust', '系统编程', '官方书籍', '中文']
  },
  {
    id: 'cat-ts-handbook',
    name: 'TypeScript 官方手册导论',
    description: 'TypeScript 官方 Handbook 导论，说明类型系统定位、安装方式与后续章节的学习顺序。',
    docs: [],
    updatedAt: 0,
    recommendedFor: ['前端工程师', 'Node.js 开发'],
    sizeBytes: 90000,
    minRamGb: 0.5,
    installUrl: 'https://www.typescriptlang.org/docs/handbook/intro.html',
    format: 'text',
    tags: ['TypeScript', '类型系统', '官方文档']
  },
  {
    id: 'cat-node-learn',
    name: 'Node.js 官方入门介绍',
    description: 'Node.js 官方 Learn 站点的入门文章，解释事件循环、非阻塞 IO 与常见使用场景。',
    docs: [],
    updatedAt: 0,
    recommendedFor: ['后端工程师', '前端工程师'],
    sizeBytes: 120000,
    minRamGb: 0.5,
    installUrl: 'https://nodejs.org/en/learn/getting-started/introduction-to-nodejs',
    format: 'text',
    tags: ['Node.js', 'JavaScript', '服务端', '官方文档']
  },
  {
    id: 'cat-hf-wikipedia-zh',
    name: '中文维基百科数据集（HuggingFace）',
    description: 'HuggingFace 上的维基百科多语言数据集，可筛选中文子集用于预训练或检索增强，本应用不自动下载。',
    docs: [],
    updatedAt: 0,
    recommendedFor: ['数据工程', '模型微调'],
    sizeBytes: 1500000000,
    minRamGb: 8,
    installUrl: 'https://huggingface.co/datasets/wikimedia/wikipedia',
    format: 'hf-dataset',
    tags: ['数据集', '中文', 'HuggingFace', '预训练']
  }
]

/** 内置离线知识包正文，按目录 id 索引 */
export const BUILTIN_PACKS: Record<string, string> = {
  'cat-aih-manual': AIH_MANUAL
}
