export interface QuestionOption {
  title: string
  desc?: string
  recommended?: boolean
}

export interface ParsedQuestion {
  title: string
  options: QuestionOption[]
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`>#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const OPTION_RE = /^(?:(\d+)[.、)]\s+|[-*]\s+)(.+)$/

function parseOptionLines(lines: string[]): QuestionOption[] {
  const out: QuestionOption[] = []
  for (const line of lines) {
    const match = OPTION_RE.exec(line)
    if (!match) continue
    const raw = match[2].trim()
    const recommended = raw.includes('推荐')
    const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(raw)
    let title = ''
    let desc: string | undefined
    if (bold) {
      title = stripMarkdown(bold[1])
      desc = stripMarkdown(bold[2].replace(/推荐/g, '')) || undefined
    } else {
      const body = stripMarkdown(raw)
      const sep = /^([^：:]{1,40})[：:]\s*(.+)$/.exec(body) || /^(.{1,40}?)\s+[-—]\s+(.+)$/.exec(body)
      if (sep) {
        title = sep[1].trim()
        desc = sep[2].trim() || undefined
      } else {
        title = body
      }
    }
    if (title) out.push({ title, desc, recommended })
    if (out.length >= 6) break
  }
  return out
}

/** 从助手回复中提取「问题标题 + 选项列表」，用于输入框上方的提问卡片 */
export function parseQuestion(raw: string): ParsedQuestion {
  const text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<aih_(?:write|write_file|edit|edit_file)[\s\S]*?<\/(?:aih_write|aih_write_file|aih_edit|aih_edit_file)>/gi, ' ')
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) return { title: '', options: [] }

  let questionIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/[?？]/.test(lines[i]) && !OPTION_RE.test(lines[i])) {
      questionIndex = i
      break
    }
  }
  const question = questionIndex >= 0 ? lines[questionIndex] : ''
  const fallback = [...lines].reverse().find((line) => !OPTION_RE.test(line)) || ''
  const title = stripMarkdown(question || fallback)

  let options = questionIndex >= 0 ? parseOptionLines(lines.slice(questionIndex + 1)) : []
  if (!options.length && /哪个|哪些|选择|方向|方案|方式/.test(title)) {
    options = parseOptionLines(lines.slice(0, questionIndex >= 0 ? questionIndex : lines.length))
  }
  return { title, options }
}
