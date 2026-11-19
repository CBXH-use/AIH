import type { AgentPreset, PluginManifest, PluginToolSpec } from '@shared/types'

/**
 * 内置插件清单。
 * featured 仅作为“官方推荐”标记附加在清单项上（共享类型未定义该字段，属于向后兼容的扩展字段）。
 */
export type CatalogEntry = PluginManifest & { featured?: boolean }

type CatalogAgent = Omit<AgentPreset, 'builtin' | 'pluginId'>

/** 远程目录允许的插件类别 */
export const PLUGIN_CATEGORIES = ['tools', 'agents', 'skills', 'mcp', 'ui'] as const

/** 工具：全球天气（wttr.in，无需 API Key） */
const weatherPlugin: CatalogEntry = {
  id: 'weather-http',
  name: '全球天气',
  version: '1.0.0',
  author: 'AIH',
  description: '无需 API Key，按城市查询实时天气与未来三天预报，数据来自 wttr.in。',
  category: 'tools',
  icon: '🌤️',
  tags: ['天气', '出行', '实时数据', '免密钥'],
  installType: 'declarative',
  homepage: 'https://wttr.in',
  downloads: 18620,
  featured: true,
  tools: [
    {
      name: 'get_weather',
      description:
        '查询指定城市的实时天气与未来三天预报。当用户询问天气、气温、降水、风力或出行穿衣建议时调用。参数 city 支持中文或英文城市名，例如“北京”“Shanghai”。',
      parameters: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '城市名称，中英文均可，如“杭州”“Tokyo”。不要带“市”字以外的多余描述。'
          }
        },
        required: ['city'],
        additionalProperties: false
      },
      http: {
        method: 'GET',
        url: 'https://wttr.in/{{city}}?format=j1',
        headers: {
          'User-Agent': 'AIH-Plugin/1.0',
          Accept: 'application/json'
        }
      }
    }
  ]
}

/** 工具：汇率换算（open.er-api.com，无需 API Key） */
const fxPlugin: CatalogEntry = {
  id: 'fx-rates',
  name: '实时汇率',
  version: '1.0.0',
  author: 'AIH',
  description: '查询各国货币兑基准货币的实时汇率，数据来自 open.er-api.com，无需 API Key。',
  category: 'tools',
  icon: '💱',
  tags: ['汇率', '金融', '换算', '免密钥'],
  installType: 'declarative',
  homepage: 'https://www.exchangerate-api.com',
  downloads: 12450,
  featured: true,
  tools: [
    {
      name: 'get_exchange_rate',
      description:
        '查询 1 单位基准货币可兑换多少目标货币。当用户询问汇率、货币换算、跨境价格对比时调用。只返回汇率数值，不做金额乘法，需要总价时由你再乘以金额。',
      parameters: {
        type: 'object',
        properties: {
          base: {
            type: 'string',
            description: '基准货币的三位 ISO 代码，如 USD、CNY、EUR，默认 USD。'
          },
          to: {
            type: 'string',
            description: '目标货币的三位 ISO 代码，如 CNY、JPY、USD，默认 CNY。'
          }
        },
        required: ['base', 'to'],
        additionalProperties: false
      },
      http: {
        method: 'GET',
        url: 'https://open.er-api.com/v6/latest/{{base}}',
        headers: {
          'User-Agent': 'AIH-Plugin/1.0'
        },
        responsePath: 'rates.{{to}}'
      }
    }
  ]
}

/** 工具：GitHub 仓库搜索（公开 API，无需 Key） */
const githubPlugin: CatalogEntry = {
  id: 'github-search',
  name: 'GitHub 仓库搜索',
  version: '1.0.0',
  author: 'AIH',
  description: '按关键词搜索 GitHub 公开仓库，返回星标最高的 5 个结果，无需 API Key。',
  category: 'tools',
  icon: '🐙',
  tags: ['GitHub', '开源', '代码检索', '免密钥'],
  installType: 'declarative',
  homepage: 'https://docs.github.com/rest/search',
  downloads: 9870,
  featured: true,
  tools: [
    {
      name: 'search_repositories',
      description:
        '搜索 GitHub 公开仓库。当用户想找开源项目、库、示例代码或比较同类项目时调用。参数 q 支持 GitHub 搜索语法，如“electron tray language:typescript”。',
      parameters: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            description: '搜索关键词，支持 GitHub 限定语法（stars:>1000、language:go 等）。'
          }
        },
        required: ['q'],
        additionalProperties: false
      },
      http: {
        method: 'GET',
        url: 'https://api.github.com/search/repositories?q={{q}}&sort=stars&order=desc&per_page=5',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'AIH-Plugin/1.0'
        },
        responsePath: 'items'
      }
    }
  ]
}

/** 工具：维基百科摘要（REST API，无需 Key） */
const wikiPlugin: CatalogEntry = {
  id: 'wiki-summary',
  name: '维基百科摘要',
  version: '1.0.0',
  author: 'AIH',
  description: '获取中文维基百科条目的首段摘要与基本信息，适合快速了解人物、事件与概念。',
  category: 'tools',
  icon: '📚',
  tags: ['百科', '知识', '事实核查', '免密钥'],
  installType: 'declarative',
  homepage: 'https://zh.wikipedia.org',
  downloads: 15340,
  featured: true,
  tools: [
    {
      name: 'get_page_summary',
      description:
        '获取中文维基百科某个条目的摘要正文。当用户询问人物、地点、历史事件、科学概念的背景介绍，或需要快速核实定义时调用。参数 title 使用条目正式名称。',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: '维基百科条目名称，如“量子力学”“苏轼”“OpenAI”。'
          }
        },
        required: ['title'],
        additionalProperties: false
      },
      http: {
        method: 'GET',
        url: 'https://zh.wikipedia.org/api/rest_v1/page/summary/{{title}}',
        headers: {
          'User-Agent': 'AIH-Plugin/1.0 (local AI agent)',
          Accept: 'application/json'
        },
        responsePath: 'extract'
      }
    }
  ]
}

/** 工具：PubMed 医学文献检索（NCBI E-utilities，无需 Key） */
const pubmedPlugin: CatalogEntry = {
  id: 'pubmed-search',
  name: 'PubMed 文献检索',
  version: '1.0.0',
  author: 'AIH',
  description: '检索 PubMed 生物医学文献，返回命中的 PMID 列表，适合循证医学与科研选题。',
  category: 'tools',
  icon: '🧬',
  tags: ['医学', '科研', '文献', '免密钥'],
  installType: 'declarative',
  homepage: 'https://pubmed.ncbi.nlm.nih.gov',
  downloads: 6420,
  featured: true,
  tools: [
    {
      name: 'search_pubmed',
      description:
        '在 PubMed 中检索生物医学文献并返回最多 10 个 PMID。当用户需要循证医学证据、论文线索或研究现状时调用。参数 term 可使用 MeSH 词或布尔表达式。',
      parameters: {
        type: 'object',
        properties: {
          term: {
            type: 'string',
            description: '检索词或布尔表达式，如“metformin AND type 2 diabetes”。'
          }
        },
        required: ['term'],
        additionalProperties: false
      },
      http: {
        method: 'GET',
        url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={{term}}&retmode=json&retmax=10&sort=relevance',
        headers: {
          'User-Agent': 'AIH-Plugin/1.0'
        },
        responsePath: 'esearchresult.idlist'
      }
    }
  ]
}

/** 工具：Hacker News 搜索（Algolia，POST JSON 示例） */
const hackerNewsPlugin: CatalogEntry = {
  id: 'hackernews-search',
  name: 'Hacker News 搜索',
  version: '1.0.0',
  author: 'AIH',
  description: '通过 Algolia API 搜索 Hacker News 技术讨论，返回标题、链接与热度，无需 API Key。',
  category: 'tools',
  icon: '🧡',
  tags: ['科技资讯', '社区', '技术趋势', '免密钥'],
  installType: 'declarative',
  homepage: 'https://hn.algolia.com/api',
  downloads: 5310,
  featured: true,
  tools: [
    {
      name: 'search_stories',
      description:
        '搜索 Hacker News 上的技术文章与讨论。当用户想了解某项技术的社区评价、最新动态或开发者观点时调用。返回热度最高的 5 条故事。',
      parameters: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            description: '搜索关键词，如“local llm”“rust async”。'
          }
        },
        required: ['q'],
        additionalProperties: false
      },
      http: {
        method: 'POST',
        url: 'https://hn.algolia.com/api/v1/search',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AIH-Plugin/1.0'
        },
        bodyTemplate: '{"query":"{{q}}","tags":"story","hitsPerPage":5}',
        responsePath: 'hits'
      }
    }
  ]
}

/** Agent 预设：写作工作室 */
const writingAgents: CatalogAgent[] = [
  {
    id: 'longform-writer',
    name: '长文写作教练',
    icon: '📝',
    description: '从选题、大纲到成稿，按结构逐节推进长文写作。',
    category: 'writing',
    systemPrompt:
      '你是一名中文长文写作教练。先确认主题、目标读者、发布渠道与目标字数，再给出三级大纲并请用户确认。正文按“论点—证据—例子—小结”展开，每段不超过 5 行，避免空话与套话。涉及事实、数据或引用时先调用 web_search 核实，并标注来源链接与日期；无法核实的内容明确写“待核实”。初稿完成后用 read_file 检查工作区已有素材，再用 write_file 输出 Markdown 文件。禁止编造引用、数据与他人观点。',
    tools: ['read_file', 'write_file', 'web_search', 'todo_write']
  },
  {
    id: 'copy-editor',
    name: '文案润色师',
    icon: '✨',
    description: '在不改变原意的前提下精简表达、统一术语与语气。',
    category: 'writing',
    systemPrompt:
      '你是资深中文文案编辑。只做润色，不改变原意、事实与立场。逐段检查冗余表达、逻辑跳跃、口语化、标点误用与术语不一致；统一人称与语气，保留用户品牌术语。输出两部分：一、修改后的全文；二、改动说明（最多 8 条，说明改了什么与为什么）。不要添加原文没有的数据或案例，不要过度使用形容词。',
    tools: ['read_file', 'write_file']
  }
]

/** Agent 预设：产品经理 */
const productAgents: CatalogAgent[] = [
  {
    id: 'prd-writer',
    name: 'PRD 撰写专家',
    icon: '📋',
    description: '把零散需求整理为可评审、可测试的 PRD。',
    category: 'office',
    systemPrompt:
      '你是资深产品经理。先用不超过 5 个问题澄清目标用户、核心场景、成功指标与资源约束，信息不足时列出假设而不是编造。随后输出 PRD，固定包含：背景与问题、目标与非目标、用户故事、功能需求（标注 P0/P1/P2）、关键交互、异常与边界、数据埋点、验收标准。每条需求必须可测试，避免“更好”“更快”等空泛描述。需要竞品信息时调用 web_search 并注明来源，最后用 write_file 保存为 Markdown。',
    tools: ['read_file', 'write_file', 'web_search', 'todo_write']
  },
  {
    id: 'requirement-reviewer',
    name: '需求评审官',
    icon: '🔎',
    description: '只读审查需求文档，找出范围、依赖与可测试性问题。',
    category: 'general',
    systemPrompt:
      '你是需求评审官，以只读方式工作。审查用户提供的 PRD 或需求描述，从用户价值、范围蔓延、依赖风险、可测试性、数据与合规五个维度找出问题。每条问题给出：严重级别（阻塞/重要/建议）、原文位置、原因、修改建议。不要重写全文，不要加入新需求。最后给出结论：通过 / 有条件通过 / 打回，并列出进入开发前必须补齐的 3 项内容。',
    tools: ['read_file', 'web_search', 'todo_write']
  }
]

/** Agent 预设：教研出题 */
const teachingAgents: CatalogAgent[] = [
  {
    id: 'exam-designer',
    name: '试卷出题专家',
    icon: '📐',
    description: '按知识点、题型与难度分布生成可用试卷与解析。',
    category: 'office',
    systemPrompt:
      '你是教研出题专家。先确认学段、学科、知识点范围、题型配比、题量与难度分布，缺失信息时采用常见默认值并说明。每题必须包含题干、选项（如适用）、标准答案、解析与对应知识点；选项之间互斥且只有一个正确答案，避免歧义、超纲与依赖图片的题目。默认配比为基础 60%、综合 30%、拔高 10%。需要引用教材表述时先 web_search 核对，最后用 write_file 输出试卷与答案两个 Markdown 文件，并附双向细目表。',
    tools: ['read_file', 'write_file', 'web_search', 'todo_write']
  },
  {
    id: 'lesson-planner',
    name: '教学设计顾问',
    icon: '🧑‍🏫',
    description: '围绕学习目标设计一节课的完整教学流程。',
    category: 'general',
    systemPrompt:
      '你是教学设计顾问。按“学习目标—前测—讲解—练习—评价”五段式设计一节课。学习目标使用可观察的动词（解释、计算、对比、设计），并标注对应知识点。为不同基础的学生准备分层练习与常见错误预案。输出包含：课时安排（分钟）、教师活动、学生活动、板书或幻灯片要点、课堂检测题与答案。需要学科事实时先 web_search 核实。',
    tools: ['read_file', 'write_file', 'web_search']
  }
]

/** Agent 预设：翻译官 */
const translatorAgents: CatalogAgent[] = [
  {
    id: 'bilingual-translator',
    name: '中英双语翻译官',
    icon: '🌐',
    description: '忠实保留语气、术语与格式的中英互译。',
    category: 'writing',
    systemPrompt:
      '你是中英双语翻译官。默认在中文与英文之间互译，保持原文语气、术语、段落与格式（标题、列表、代码块、表格）。专有名词、产品名与缩写在首次出现时用括号保留原文。不增删事实，不做解释性扩写，不擅自本地化数字与单位。长文先抽取术语表再分段翻译，最后统一术语。含义不明处列出 1-2 个候选译法并说明差异，请用户确认后再定稿，成稿用 write_file 保存。',
    tools: ['read_file', 'write_file', 'web_search']
  }
]

/** MCP：文件系统服务 */
const filesystemMcp: CatalogEntry = {
  id: 'mcp-filesystem',
  name: '文件系统 MCP',
  version: '1.0.0',
  author: 'Model Context Protocol',
  description:
    '通过 MCP 协议读写本地目录中的文件。需要网络与 Node.js 20+；首次安装会通过 npx 下载官方服务包，允许访问的目录默认为应用当前工作目录。',
  category: 'mcp',
  icon: '📁',
  tags: ['文件', 'MCP', 'npx', '本地'],
  installType: 'mcp',
  homepage: 'https://github.com/modelcontextprotocol/servers',
  downloads: 22100,
  featured: true,
  mcp: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()]
  }
}

/** MCP：SQLite 服务 */
const sqliteMcp: CatalogEntry = {
  id: 'mcp-sqlite',
  name: 'SQLite MCP',
  version: '1.0.0',
  author: 'Model Context Protocol',
  description:
    '通过 MCP 协议查询与修改 SQLite 数据库。需要网络与 Node.js 20+；安装时通过 npx 获取官方服务包，若本机缺少 npx 会在状态中给出可读错误。',
  category: 'mcp',
  icon: '🗄️',
  tags: ['数据库', 'SQLite', 'MCP', 'npx'],
  installType: 'mcp',
  homepage: 'https://github.com/modelcontextprotocol/servers',
  downloads: 8740,
  featured: true,
  mcp: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite']
  }
}

/** MCP：网页抓取服务 */
const fetchMcp: CatalogEntry = {
  id: 'mcp-fetch',
  name: '网页抓取 MCP',
  version: '1.0.0',
  author: 'Model Context Protocol',
  description:
    '通过 MCP 协议抓取网页并转为 Markdown，便于后续总结。需要网络与 Node.js 20+；安装与启动均依赖 npx，离线环境会显示友好错误。',
  category: 'mcp',
  icon: '🕸️',
  tags: ['网页', '抓取', 'MCP', 'npx'],
  installType: 'mcp',
  homepage: 'https://github.com/modelcontextprotocol/servers',
  downloads: 10930,
  featured: true,
  mcp: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch']
  }
}

/** 技能：深度研究提示词包 */
const researchSkill: CatalogEntry = {
  id: 'skill-deep-research',
  name: '深度研究',
  version: '1.0.0',
  author: 'AIH',
  description: '把复杂问题拆成可验证的子问题，多源检索、交叉核对并输出带引用的研究报告。',
  category: 'skills',
  icon: '🔬',
  tags: ['研究', '检索', '报告', '提示词'],
  installType: 'builtin',
  downloads: 7650,
  featured: true,
  skills: [
    {
      name: 'deep-research',
      description: '结构化深度研究与证据整理流程。',
      prompt:
        '按以下流程完成深度研究：\n1. 复述问题并拆成 3-5 个可独立验证的子问题，明确时间范围与地域范围。\n2. 为每个子问题至少查找两个相互独立的来源，优先官方文档、论文、统计机构；记录链接与发布日期。\n3. 制作证据表：结论 | 来源 | 日期 | 可信度（高/中/低）。\n4. 主动寻找反方观点与失败案例，检查是否存在幸存者偏差。\n5. 冲突信息不要强行合并，分别列出并说明可能原因。\n6. 输出结构：一句话结论 → 关键发现（3-5 条）→ 证据表 → 反方与局限 → 可执行建议 → 参考链接。\n所有事实性陈述必须能追溯到来源，无法核实的标注“未验证”。'
    }
  ]
}

/** 技能：代码重构提示词包 */
const refactorSkill: CatalogEntry = {
  id: 'skill-code-refactor',
  name: '代码重构',
  version: '1.0.0',
  author: 'AIH',
  description: '以行为不变为前提，小步、可验证地重构代码，适合接手遗留项目。',
  category: 'skills',
  icon: '🧹',
  tags: ['重构', '代码质量', '测试', '提示词'],
  installType: 'builtin',
  downloads: 6930,
  featured: true,
  skills: [
    {
      name: 'code-refactor',
      description: '安全小步重构与回归验证流程。',
      prompt:
        '按以下流程重构代码：\n1. 先阅读相关文件与调用方，画出数据流，列出本次重构的边界（改什么、不改什么）。\n2. 运行现有测试或最小复现脚本，建立行为基线；没有测试时先补关键路径的特征测试。\n3. 每次只做一种变换（提取函数、消除重复、收敛分支、拆分模块），保持外部行为不变。\n4. 每步完成后立即运行类型检查与测试，失败则回退该步，不要累积多个未验证改动。\n5. 不顺手改业务逻辑、不改公共 API 签名、不升级依赖。\n6. 最后输出：改动清单、行为不变性说明、验证命令与结果、剩余风险。'
    }
  ]
}

/** 技能：周报生成提示词包 */
const weeklyReportSkill: CatalogEntry = {
  id: 'skill-weekly-report',
  name: '周报生成',
  version: '1.0.0',
  author: 'AIH',
  description: '从会话、提交与待办中提炼本周成果、风险与下周计划，生成可直接发送的周报。',
  category: 'skills',
  icon: '🗓️',
  tags: ['周报', '总结', '协作', '提示词'],
  installType: 'builtin',
  downloads: 8120,
  featured: true,
  skills: [
    {
      name: 'weekly-report',
      description: '自动汇总工作记录并生成结构化周报。',
      prompt:
        '按以下流程生成周报：\n1. 收集本周的会话记录、代码提交、待办完成情况与会议要点；信息不足时向用户确认，不要编造。\n2. 按“已完成 / 进行中 / 阻塞与风险 / 下周计划”四栏归类，每项写清结果与影响，而不是过程流水账。\n3. 已完成项尽量量化：交付物、覆盖范围、修复数量、性能变化。\n4. 风险项注明影响面、当前缓解措施与需要谁支持。\n5. 下周计划不超过 5 项，按优先级排序，避免与本周未完成项重复。\n6. 输出两版：详细版（给团队）与 5 行摘要版（给管理者）。语言简洁、事实优先，不使用夸张措辞。'
    }
  ]
}

/** 内置插件总数 16：tools 6 / agents 4 / skills 3 / mcp 3 */
export const BUILTIN_PLUGINS: CatalogEntry[] = [
  weatherPlugin,
  fxPlugin,
  githubPlugin,
  wikiPlugin,
  pubmedPlugin,
  hackerNewsPlugin,
  {
    id: 'agent-writing-studio',
    name: '写作工作室',
    version: '1.0.0',
    author: 'AIH',
    description: '长文写作与文案润色两个角色，覆盖从大纲到定稿的完整写作链路。',
    category: 'agents',
    icon: '✍️',
    tags: ['写作', '长文', '润色', 'Agent'],
    installType: 'builtin',
    downloads: 14780,
    featured: true,
    agents: writingAgents
  },
  {
    id: 'agent-product-manager',
    name: '产品经理',
    version: '1.0.0',
    author: 'AIH',
    description: 'PRD 撰写与需求评审两个角色，帮助团队把想法整理成可开发的需求。',
    category: 'agents',
    icon: '📋',
    tags: ['产品', 'PRD', '需求评审', 'Agent'],
    installType: 'builtin',
    downloads: 13640,
    featured: true,
    agents: productAgents
  },
  {
    id: 'agent-teaching',
    name: '教研出题',
    version: '1.0.0',
    author: 'AIH',
    description: '试卷出题与教学设计两个角色，按知识点与难度分布产出可直接使用的材料。',
    category: 'agents',
    icon: '🎓',
    tags: ['教育', '出题', '教学设计', 'Agent'],
    installType: 'builtin',
    downloads: 9020,
    featured: true,
    agents: teachingAgents
  },
  {
    id: 'agent-translator',
    name: '翻译官',
    version: '1.0.0',
    author: 'AIH',
    description: '中英双语翻译角色，保留术语、格式与语气，适合文档与技术资料。',
    category: 'agents',
    icon: '🌐',
    tags: ['翻译', '中英', '术语', 'Agent'],
    installType: 'builtin',
    downloads: 11870,
    featured: true,
    agents: translatorAgents
  },
  researchSkill,
  refactorSkill,
  weeklyReportSkill,
  filesystemMcp,
  sqliteMcp,
  fetchMcp
]

/** 按 id 查找内置清单项 */
export function findBuiltinPlugin(id: string): CatalogEntry | undefined {
  return BUILTIN_PLUGINS.find((p) => p.id === id)
}
