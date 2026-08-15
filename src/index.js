// dsh-tools-meta — 元工具（host half）。
//
// 形态：插件 + 一个 skill，零模型工具。
// - 工具 = $DSH_HOME/tools-meta/<name>.ts（TS 模块；工具名 = 函数名 = 文件名）
// - 插件监听该目录：新增注册、修改热更新（先验证后替换）、删除即卸载
// - skill 在运行时注册，内容注入本插件与 runner 的绝对路径（源码即权威）
//
// 脚本格式：
//   export const description = '...'                    // 必填
//   export const parameters = { ... }                   // 官方 ParameterSchemaSpec，可省略
//   export const output = { ... }                       // 官方 ValueSchemaSpec，可省略
//   export async function <name>(input) { return ... }  // 返回值 = 工具结果（lossless JSON）

import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { mkdirSync, watch } from 'node:fs'
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
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/

const SKILL_TEMPLATE = `# meta-tools

工具目录：\`<TOOLS_DIR>\`（本 skill 中一切路径均用绝对路径）

## 添加工具

在工具目录写入 \`<name>.ts\`；工具名 = 文件名 = 导出的函数名。

\`\`\`ts
export const description = '一句话：工具做什么、何时用。'
export const parameters = { text: { type: 'string', required: true, description: '参数说明。' } } // 可选，无参可省略
export const output = { type: 'object', additionalProperties: false, properties: { characters: { type: 'integer', required: true } } } // 可选
export async function <name>(input) { return { /* lossless JSON */ } }
\`\`\`

约束：仅可擦除 TS 语法（无 enum / namespace / 参数属性）；顶层无副作用；parameters 为 properties 记录，output 为 value schema（type 必填，或省略整个 output）。

写入后约 1 秒自动注册，下一轮出现在工具目录，描述带 \`[meta-tool]\` 前缀。修改文件即热更新；删除文件即移除工具。

## 删除

\`Remove-Item '<TOOLS_DIR>\\<name>.ts'\`（pwsh）

## 诊断

- 注册失败或行为不符：读权威源码 \`<INDEX_JS>\`（注册与监听逻辑）、\`<RUNNER_MJS>\`（脚本执行）
- 手动验证脚本：\`node "<RUNNER_MJS>" --inspect "<脚本绝对路径>"\`
`

export function apply(ctx) {
  mkdirSync(TOOLS_DIR, { recursive: true })
  const registered = new Map() // name -> { dispose, mtimeMs }

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

  // 校验 + 注册一个脚本；返回 { dispose, mtimeMs }，失败抛出且不留任何注册。
  async function registerScript(file, scriptName, mtimeMs) {
    if (scriptName === 'run_code') throw new Error('tool name "run_code" is reserved')
    const meta = await run('--inspect', file)
    if (meta.functions.length !== 1) throw new Error(`expected exactly one exported function, got ${meta.functions.length}`)
    if (meta.functions[0] !== scriptName) throw new Error(`function name "${meta.functions[0]}" must equal file name "${scriptName}"`)
    if (typeof meta.description !== 'string' || meta.description.trim() === '') throw new Error('script must export a non-empty description string')
    const definition = defineTool({
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
    return { dispose: ctx.tools.register(definition), mtimeMs }
  }

  // 全量对账：新增注册、mtime 变化先验证后替换（失败保留旧版）、删除卸载。
  async function reconcile() {
    const seen = new Set()
    for (const entry of await readdir(TOOLS_DIR)) {
      if (!entry.endsWith('.ts')) continue
      const scriptName = entry.slice(0, -3)
      if (!NAME_PATTERN.test(scriptName)) continue
      seen.add(scriptName)
      const mtimeMs = (await stat(join(TOOLS_DIR, entry))).mtimeMs
      const current = registered.get(scriptName)
      if (current !== undefined && current.mtimeMs === mtimeMs) continue
      try {
        const fresh = await registerScript(join(TOOLS_DIR, entry), scriptName, mtimeMs)
        registered.get(scriptName)?.dispose()
        registered.set(scriptName, fresh)
      } catch (error) {
        console.error(`[dsh-tools-meta] ${scriptName}: ${error.message}`)
      }
    }
    for (const [scriptName, entry] of registered) {
      if (!seen.has(scriptName)) {
        entry.dispose()
        registered.delete(scriptName)
      }
    }
  }

  ctx.effect(() => {
    let timer
    const watcher = watch(TOOLS_DIR, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        reconcile().catch((error) => console.error('[dsh-tools-meta]', error))
      }, 300)
    })
    return () => {
      clearTimeout(timer)
      watcher.close()
    }
  })

  const skills = ctx.get('skills')
  if (skills !== undefined) {
    const content = SKILL_TEMPLATE
      .replaceAll('<TOOLS_DIR>', TOOLS_DIR)
      .replaceAll('<INDEX_JS>', join(HERE, 'index.js'))
      .replaceAll('<RUNNER_MJS>', RUNNER)
    ctx.effect(() => skills.register({
      name: 'meta-tools',
      source: 'dsh-tools-meta',
      description: 'How to give this agent new persistent tools: write a script into the meta-tools directory.',
      content,
    }))
  }

  reconcile().catch((error) => console.error('[dsh-tools-meta]', error))
}
