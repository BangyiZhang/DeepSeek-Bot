# 本地 Codex CLI 模型来源

本地改造：在 API、DeepSeek 账号之外，把已安装的 Codex CLI 接到现有模型选择器。用户选 `local-codex/default`，不用另建 Bot 或配置 API Key。

通过 DSH 公开的 `LlmAdapter` / `registerAdapter()` 接口注册来源，通过 Codex 公开的 `app-server --listen stdio://` 协议请求模型。CLI 的登录、模型供应商、模型和默认推理强度均从现有配置加载；不读取、复制或修改凭据文件，也不覆盖 CODEX_HOME。

## 对话与工具

- DSH 是会话、记忆、上下文压缩、权限和工具的所有者。
- 每次模型请求启动专用子进程和临时 Codex thread，将完整、带角色的 DSH 历史交给 Codex。不会附着到用户现有的 Codex 聊天，也不向它们发消息。
- 文本增量映射回 DSH 的标准流；DSH 工具以 Codex dynamicTools 注册。收到真实工具调用后，将名称和参数映射回 DSH 工具调用，由原执行链路处理；下一次请求带上已记录的工具结果。
- 每次请求关闭原生 shell、MCP、插件、Hooks、子 Agent、电脑操作和生图能力，并使用只读沙箱限制原生文件修改；实际操作交给 DSH 工具权限系统。这些只是子进程/临时 thread 的覆盖，不修改用户配置。
- 停止、失败、工具交接和结束时清理专用进程。插件卸载也清理尚在运行的进程。服务端错误使用固定诊断，协议内容和 stderr 不写日志。

## 安装与设置

需要支持 app-server 和 experimental dynamicTools 的 Codex CLI。先在终端正常运行并登录 `codex`。命令从 PATH 查找，macOS 也检查常见安装位置。可在 `ds-bot` 配置中指定 `codexCommand: /absolute/path/to/codex`；`localCodex: false` 关闭此来源。

本版提供一个“配置中的模型”选项，模型与推理强度跟随 CLI 默认值。图片暂由 DSH 的图片转文字流程处理。上下文采用保守的 128K 窗口；模型输出长度以 CLI 默认值为准。Codex 在工具交接前未报告 Token 时，用量页不会估算或捏造这部分消耗。

## 验证

用无凭据的协议模拟器覆盖文本增量、工具调用与结果续接、错误、停止和子进程退出。运行插件单元测试、构建一致性检查、lint，以及隔离数据上的桌面冒烟验证。真实本地 CLI 验证只做最小的聊天和测试目录内的工具操作。


## 进度与思考摘要

本地 CLI 调用从启动开始显示固定阶段与实时秒表，首个可见内容出现前由插件补充聊天状态栏容器；完成、失败或停止后自动收起状态行，不在聊天中保留最终统计。进度通过现有 state/feed 接口发布，只包含阶段和时间，下一回合清理。

Codex `item/reasoning/summaryTextDelta` 中公开的摘要映射为 DSH 标准 reasoning 流，复用原有可折叠思考区及会话存储。没有摘要事件时只显示真实调用状态，不生成或猜测思考内容。总耗时包含进程启动、等待和工具往返；原有思考区的计时仍只统计实际 reasoning 流。
