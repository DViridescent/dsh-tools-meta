// dsh-tools-meta runner — 被插件 spawn 的子进程入口，永远不在宿主进程内执行用户脚本。
//
// usage:
//   node runner.mjs --inspect <file>             → 输出 { functions, description, parameters, output }
//   node runner.mjs --call <file> <name> <json>  → 输出函数返回值的 JSON
//
// 用户脚本是 TS 模块（Node 22 原生 type stripping，仅可擦除语法）：
//   export const description = '...'
//   export const parameters = { ... }   // 可省略
//   export const output = { ... }       // 可省略
//   export async function <name>(input) { return ... }

import { pathToFileURL } from 'node:url'

const [mode, file, name, argsJson] = process.argv.slice(2)

if (mode === undefined) throw new Error('runner: missing mode (--inspect | --call)')

const module = await import(pathToFileURL(file).href)

if (mode === '--inspect') {
  const result = {
    functions: Object.keys(module).filter((key) => typeof module[key] === 'function'),
    description: typeof module.description === 'string' ? module.description : '',
    parameters: isPlainRecord(module.parameters) ? module.parameters : undefined,
    output: isPlainRecord(module.output) ? module.output : undefined,
  }
  process.stdout.write(JSON.stringify(result))
} else if (mode === '--call') {
  if (typeof module[name] !== 'function') throw new Error(`"${name}" is not an exported function`)
  const value = await module[name](JSON.parse(argsJson))
  process.stdout.write(JSON.stringify(value ?? null))
} else {
  throw new Error(`runner: unknown mode "${mode}"`)
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
