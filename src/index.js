// dsh-tools-meta — 元工具（host half）。
//
// 工具脚本 = 一个 TS 模块（Node 22 原生 type stripping，仅可擦除语法）：
//   export const description = '...'                        // 必填
//   export const parameters = { ... }                       // 官方 ParameterSchemaSpec，可省略（无参）
//   export const output = { ... }                           // 官方 JSON Schema 子集，可省略（任意 JSON）
//   export async function <name>(input) { return ... }      // 工具名 = 函数名 = 文件名
//
// 生命周期全部是运行时行为，持久化在 $DSH_HOME/tools-meta/<name>.ts：
// - create_tool(path)：校验 → 复制进 tools-meta → 注册（下一轮可见）
// - remove_tool(name)：卸载注册 + 删除文件
// - 启动时扫描 tools-meta 重建注册
// 执行：spawn node runner.mjs，用户脚本永远在子进程里跑。

import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-tools-meta'

export const inject = ['tools', 'subprocess']

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs')
const TOOLS_DIR = dshHomePath('tools-meta')
const META_PREFIX = '[meta-tool] '
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const GRACE_MS = 5000
const CALL_BYTES = 1 << 20
const DIAG_BYTES = 1 << 16

export function apply(ctx) {
  const workspaceRoot = ctx.get('sandboxPolicy')?.workspaceRoot ?? process.cwd()
  const registered = new Map()

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

  function registerScript(file, scriptName, meta, exec) {
    if (meta.functions.length !== 1) throw new Error(`expected exactly one exported function, got ${meta.functions.length}`)
    if (meta.functions[0] !== scriptName) throw new Error(`function name "${meta.functions[0]}" must equal file name "${scriptName}"`)
    if (typeof meta.description !== 'string' || meta.description.trim() === '') throw new Error('script must export a non-empty description string')
    if (registered.has(scriptName)) throw new Error(`tool "${scriptName}" is already registered`)
    const definition = defineTool({
      name: scriptName,
      description: `${META_PREFIX}${meta.description}`,
      parameters: meta.parameters ?? {},
      output: {
        schema: meta.output ?? {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        return run('--call', file, scriptName, JSON.stringify(args), exec.signal)
      },
    })
    registered.set(scriptName, ctx.tools.register(definition))
  }

  ctx.effect(async () => {
    await mkdir(TOOLS_DIR, { recursive: true })
    for (const entry of await readdir(TOOLS_DIR)) {
      if (!entry.endsWith('.ts')) continue
      try {
        const scriptName = entry.slice(0, -3)
        registerScript(join(TOOLS_DIR, entry), scriptName, await run('--inspect', join(TOOLS_DIR, entry)))
      } catch (error) {
        console.error(`[dsh-tools-meta] skipped ${entry}: ${error.message}`)
      }
    }
  })

  ctx.tools.register(defineTool({
    name: 'create_tool',
    description: [
      'Create a persistent tool from a local script file, available in the next step and in every session.',
      '',
      'The script is a TypeScript module: `export const description` (required), optional',
      '`export const parameters` (the JSON Schema shape built-in tools use) and',
      '`export const output`, and exactly one `export async function` whose name must',
      'equal the file base name — that name becomes the tool name.',
      'The function receives the validated tool call arguments as its first parameter',
      'and its return value (lossless JSON) becomes the tool result.',
      '',
      'Only erasable TypeScript syntax is supported (no enums, namespaces, or',
      'parameter properties). The script runs out-of-process via `node` on every call;',
      'keep its top level side-effect-free.',
    ].join('\n'),
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the script file (.ts); relative paths resolve against the workspace root.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { created: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Created meta-tool \`${value.created}\`.` }],
    },
    async execute(args, exec) {
      const source = resolve(workspaceRoot, args.path)
      if (extname(source) !== '.ts') throw new Error('tool scripts must be .ts files')
      const scriptName = basename(source, '.ts')
      if (!NAME_PATTERN.test(scriptName)) throw new Error(`invalid tool name "${scriptName}": use [a-z][a-z0-9_]*`)
      const target = join(TOOLS_DIR, `${scriptName}.ts`)
      const meta = await run('--inspect', source, undefined, undefined, exec.signal)
      try {
        await mkdir(TOOLS_DIR, { recursive: true })
        await copyFile(source, target, 1) // COPYFILE_EXCL：重名拒绝
      } catch (error) {
        if (error.code === 'EEXIST') throw new Error(`tool "${scriptName}" already exists`)
        throw error
      }
      try {
        registerScript(target, scriptName, meta, exec)
      } catch (error) {
        await rm(target, { force: true })
        throw error
      }
      return { created: scriptName }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'remove_tool',
    description: [
      'Remove a tool created by create_tool. Deletes its script from disk; the tool',
      'disappears from the catalog immediately.',
    ].join('\n'),
    parameters: {
      name: { type: 'string', required: true, description: 'The tool name to remove.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { removed: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `Removed meta-tool \`${value.removed}\`.` }],
    },
    async execute(args) {
      if (!NAME_PATTERN.test(args.name)) throw new Error(`invalid tool name "${args.name}"`)
      const dispose = registered.get(args.name)
      if (dispose === undefined) throw new Error(`tool "${args.name}" is not registered`)
      dispose()
      registered.delete(args.name)
      await rm(join(TOOLS_DIR, `${args.name}.ts`), { force: true })
      return { removed: args.name }
    },
  }))
}
