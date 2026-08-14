# dsh-tools-meta · 元工具

> Meta tools for DeepSeek Harness：让模型以文件为载体制建、使用、移除自己的工具。

## 愿景

我们对未来模型的判断：

- 上下文不会无限大，模型依旧在有限上下文里工作
- 短期内做不到动态权重调整：今天告诉它的信息，不会自动变成永久的记忆
- 模型会获得元认知，能够自我剖析

由这几点推出的方向：

- 有了元认知，模型可以自己控制自己的上下文。今天大部分 harness（包括 DSH）的做法是越过阈值后被动压缩，模型无法干预
- 未来的 harness 应该配合模型的元认知：让模型容易地编辑自己的上下文，容易地为自己添加和删除工具

DeepSeek 的下一步是长期学习，DSH 是面向开发者的基座。

这个插件做的是其中一块：把"为自己添加和删除工具"变成模型可以直接调用的动作。

## 工具脚本

一个脚本 = 一个工具。TypeScript 模块，`create_tool` 后持久化到 `$DSH_HOME/tools-meta/<name>.ts`：

```ts
// text_stats.ts
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
```

规则：

- 工具名 = 函数名 = 文件名（base name）
- `description` 必填；`parameters`（官方 ParameterSchemaSpec）/ `output`（官方 JSON Schema 子集）可省略
- 函数第一个参数收到校验后的调用参数，返回值（lossless JSON）即工具结果
- 仅可擦除 TS 语法（无 enum / namespace / 参数属性）；顶层无副作用
- 每次调用由 `node` 子进程执行脚本（与官方 bash 工具一致的进程哲学）

## 能力

- `create_tool(path)`：校验脚本（恰好一个导出函数、名字与文件名一致、schema 合法）→ 持久化 → 注册；下一轮可见，所有会话可用
- `remove_tool(name)`：立即卸载注册 + 删除脚本文件
- 重名拒绝；启动时自动扫描 `$DSH_HOME/tools-meta` 重建注册
- 已注册工具的 description 带 `[meta-tool]` 前缀

## 依赖

- 主机平面服务：`tools`、`subprocess`（web profile 默认具备）
- Node ≥ 22.18（`.ts` 原生 type stripping）

## 安装

```sh
dsh plugin --profile <name> add dsh-tools-meta
# 或从 GitHub 安装：
dsh plugin --profile <name> add "github:DViridescent/dsh-tools-meta"
```
