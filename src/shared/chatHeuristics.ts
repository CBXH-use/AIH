/** 判断助手回复是否在向用户提问 / 等待用户确认，用于暂停 agent 循环 */
export function asksForUserReply(text: string): boolean {
  if (!text) return false
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<aih_(?:write|write_file|edit|edit_file)[\s\S]*?<\/(?:aih_write|aih_write_file|aih_edit|aih_edit_file)>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return false
  const tail = clean.slice(-220)
  // 礼貌收尾（「如有其他需求，请告知」等）不算在等待回复
  if (/(其他|别的|更多)[^。！!]{0,10}(问题|需求|需要|要求)|(如有|如果)[^。！!]{0,12}(告知|告诉|联系|随时)/.test(tail)) {
    return false
  }
  // 结尾是问句
  if (/[?？]\s*$/.test(tail)) return true
  // 明确要求用户回复 / 确认 / 选择 / 补充信息
  if (/(请|需要你|你可以|能否|是否)[^。！!]{0,40}(回复|确认|选择|告知|告诉我|提供|说明)/.test(tail)) return true
  if (/(回复|输入)\s*["“']?(确认|是|好|继续)/.test(tail)) return true
  return false
}
