# dsh-tools-meta · 元工具

> Meta tools for DeepSeek Harness：以文件为载体制建、使用、修改自己的工具。

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

## 形态

插件 + 一个 skill，零模型工具：

- 工具 = `$DSH_HOME/tools-meta/<name>.ts`（TS 模块，工具名 = 函数名 = 文件名）
- 插件监听该目录：新增自动注册、修改热更新（先验证后替换）、删除即卸载
- skill（`meta-tools`）在运行时注册，内容注入工具目录与插件源码的绝对路径

模型按 skill 指示写入/修改/删除脚本，即可增改删自己的工具；上一轮的工具目录随之变化。

## 脚本格式

```ts
export const description = '一句话：工具做什么、何时用。'
export const parameters = { text: { type: 'string', required: true, description: '参数说明。' } } // 可选
export const output = { type: 'object', additionalProperties: false, properties: { characters: { type: 'integer', required: true } } } // 可选
export async function <name>(input) { return { /* lossless JSON */ } }
```

约束：仅可擦除 TS 语法；顶层无副作用；路径一律绝对路径。

## 依赖

- 主机平面服务：`tools`、`subprocess`（web profile 默认具备）；`skills` 可选（存在则注册 skill）
- Node ≥ 22.18（`.ts` 原生 type stripping）

## 安装

```sh
dsh plugin --profile <name> add dsh-tools-meta
# 或从 GitHub 安装：
dsh plugin --profile <name> add "github:DViridescent/dsh-tools-meta"
```
