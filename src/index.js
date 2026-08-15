// dsh-tools-meta — 元工具（host half）。
//
// 形态：插件 + 一个 skill，零模型工具。
// 工具 = $DSH_HOME/tools-meta/<name>.ts（TS 模块；工具名 = 函数名 = 文件名）
// 注册 = 目录的纯函数：每个模型 step 前（agent/pre-step）检查目录指纹，
// 变了就重建整个注册（旧代际 fiber 销毁、新代际现场扫描注册）。
// 没有 watcher、没有防抖、没有内存注册表。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { mkdirSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-tools-meta'

export const inject = ['tools', 'subprocess']

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = join(HERE, 'runner.mjs')
const TOOLS_DIR = dshHomePath('tools-meta')
const META_PREFIX = '[meta-tool] '
const GRACE_MS = 5000
const CALL_BYTES = 1 << 20
const DIAG_BYTES = 1 << 16
const INSPECT_TIMEOUT_MS = 30_000
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

const SKILL_TEMPLATE = `# meta-tools

工具目录：\`<TOOLS_DIR>\`

## 添加

在工具目录写入 \`<name>.ts\`。工具名 = 文件名 = 导出的函数名。

\`\`\`ts
export const description = '工具用途。'
export const parameters = { text: { type: 'string', required: true, description: '参数说明。' } } // 可选
export const output = { type: 'object', additionalProperties: false, properties: { characters: { type: 'integer', required: true } } } // 可选
export async function <name>(input) { return { /* lossless JSON */ } }
\`\`\`

- 路径一律绝对路径
- 仅可擦除 TS 语法（无 enum / namespace / 参数属性），顶层无副作用
- parameters 为 properties 记录；output 为 value schema（type 必填）或省略
- 写入后无需验证；下一个模型 step 自动注册，描述带 \`[meta-tool]\` 前缀
- 修改文件即热更新；删除文件即移除

## 删除

\`Remove-Item '<TOOLS_DIR>\\<name>.ts'\`（pwsh）

## 工具未出现时

读插件源码：\`<INDEX_JS>\`（注册与扫描）、\`<RUNNER_MJS>\`（脚本执行）。
`

export function apply(ctx) {
  mkdirSync(TOOLS_DIR, { recursive: true })
  let generation // 当前代际 fiber；销毁即卸载名下全部注册
  let stamp = '' // 上次重建时的目录指纹
  let rebuilding = false

  async function run(mode, file, toolName, argsJson, signal) {
    const handle = ctx.subprocess.spawn({
      argv: [process.execPath, RUNNER, mode, file, toolName, argsJson].filter((v) => v !== undefined),
      cwd: TOOLS_DIR,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: CALL_BYTES },
        stderr: { maxBytes: DIAG_BYTES },
      },
      graceMs: GRACE_MS,
      signal,
    })
    const outcome = await handle.done
    if (signal?.aborted === true) throw new Error('tool call aborted')
    const err = handle.collected.stderr.readFrom(0).text.trim()
    if (outcome.exitCode !== 0) throw new Error(err || `script exited with code ${outcome.exitCode}`)
    const out = handle.collected.stdout.readFrom(0).text
    try {
      return JSON.parse(out)
    } catch {
      throw new Error(`script stdout is not JSON: ${out.slice(0, 200)}`)
    }
  }

  // 校验一个脚本并构建工具定义（不注册）；失败抛出且无副作用。
  async function buildScript(file, scriptName) {
    if (scriptName === 'run_code') throw new Error('tool name "run_code" is reserved')
    const meta = await run('--inspect', file, undefined, undefined, AbortSignal.timeout(INSPECT_TIMEOUT_MS))
    if (meta.functions.length !== 1) throw new Error(`expected exactly one exported function, got ${meta.functions.length}`)
    if (meta.functions[0] !== scriptName) throw new Error(`function name "${meta.functions[0]}" must equal file name "${scriptName}"`)
    if (typeof meta.description !== 'string' || meta.description.trim() === '') throw new Error('script must export a non-empty description string')
    return defineTool({
      name: scriptName,
      description: `${META_PREFIX}${meta.description}`,
      parameters: meta.parameters ?? {},
      output: {
        schema: meta.output ?? { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        return run('--call', file, scriptName, JSON.stringify(args), exec.signal)
      },
    })
  }

  async function dirStamp() {
    const parts = []
    for (const entry of await readdir(TOOLS_DIR)) {
      if (!entry.endsWith('.ts')) continue
      parts.push(`${entry}:${(await stat(join(TOOLS_DIR, entry))).mtimeMs}`)
    }
    return parts.join('|')
  }

  async function ensureCurrent() {
    if (rebuilding) return
    const next = await dirStamp()
    if (next === stamp) return
    rebuilding = true
    try {
      const previous = generation
      if (previous !== undefined) {
        await Promise.resolve(previous.dispose())
        while (previous.inertia !== undefined) await previous.inertia
      }
      generation = ctx.plugin(async (child) => {
        for (const entry of await readdir(TOOLS_DIR)) {
          if (!entry.endsWith('.ts')) continue
          const scriptName = entry.slice(0, -3)
          if (!NAME_PATTERN.test(scriptName)) {
            console.error(`[dsh-tools-meta] ${entry}: file name must be a valid JS identifier and equal the exported function name`)
            continue
          }
          try {
            child.tools.register(await buildScript(join(TOOLS_DIR, entry), scriptName))
          } catch (error) {
            console.error(`[dsh-tools-meta] ${scriptName}: ${error.message}`)
          }
        }
      })
      stamp = next
    } finally {
      rebuilding = false
    }
  }

  ctx.on('agent/pre-step', (_payload, next) => ensureCurrent().catch((error) => {
    console.error('[dsh-tools-meta]', error)
  }).then(next))

  const skills = ctx.get('skills')
  if (skills !== undefined) {
    const content = SKILL_TEMPLATE
      .replaceAll('<TOOLS_DIR>', TOOLS_DIR)
      .replaceAll('<INDEX_JS>', join(HERE, 'index.js'))
      .replaceAll('<RUNNER_MJS>', RUNNER)
    ctx.effect(() => skills.register({
      name: 'meta-tools',
      source: 'dsh-tools-meta',
      description: 'How to add, modify, or remove the agent\'s own persistent tools (scripts in the meta-tools directory). Use when the agent needs a new persistent tool, wants to change or remove one, or a written script did not appear in the tool catalog.',
      content,
    }))
  }
}
