// text_stats.ts — dsh-tools-meta 示例工具脚本。
// 工具名 = 函数名 = 文件名（text_stats）。

export const description = 'Count characters and words in a text string.'

export const parameters = {
  text: { type: 'string', required: true, description: 'The text to analyze.' },
}

export const output = {
  type: 'object',
  additionalProperties: false,
  properties: {
    characters: { type: 'integer', required: true },
    words: { type: 'integer', required: true },
  },
}

export async function text_stats(input: { text: string }) {
  const trimmed = input.text.trim()
  return { characters: input.text.length, words: trimmed === '' ? 0 : trimmed.split(/\s+/).length }
}
