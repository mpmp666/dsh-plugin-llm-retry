# dsh-plugin-llm-retry

DeepSeek Harness 的**可配置模型重试**插件：把「请求失败后怎么重试」从写死的指数退避
变成设置页里的几个数字——**关闭逐次等待越来越长**、**每次增加多少秒**、**最多重试多少次**、
**初次等多少秒**，改完**立即生效**，不用重启。

## 它解决什么

DSH 自带 `@deepseek-ai/dsh-llm-retry`：模型请求失败（限流、超时、服务端错误……）后
按 `重试策略` 自动重试，但策略来自 provider 适配器配置，且**等待时间固定是指数退避**
（500ms → 1s → 2s → 4s …，带 ±10% 抖动），只能在 `cordis.yml` 里改。本插件在同一个
`agent/request-error` 瀑布事件上**注册一个更外层的监听器**并接管重试，于是全部参数
都进了设置页。

## 设置

**设置 → 插件 → 模型重试** 标签页（侧栏「插件」面板 → 官方 → 模型重试 是同一张卡片），
或直接编辑 profile 的 `cordis.patch.yml`，在 `id: llm-retry-settings` 那一节的 `config` 下。
（0.1.7-rc.2 起设置不再存 `~/.dsh/settings.yaml`；旧的 `llm-retry` 节在导入时按节名找入口，
因为入口 id 叫 `llm-retry-settings` 而被丢弃。）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后完全交回 DSH 自带的 llm-retry |
| `exponentialBackoff` | `false` | **逐步等待越来越长（指数退避）**。关（默认）= 用下面的「每次增加」控制 |
| `stepSeconds` | `0` | **每次增加多少秒**。`0` = 每次都等同样长；`2` = 1s → 3s → 5s → … |
| `maxRetries` | `5` | **最多重试多少次**（不含最初的第一次请求） |
| `initialDelaySeconds` | `1` | **初次等待多少秒** |
| `maxDelaySeconds` | `60` | 单次等待上限：线性/指数增长都不会超过它 |
| `jitterRatio` | `0` | 抖动比例。`0` = 严格按设置的秒数等待；`0.1` = 每次 ±10% |
| `respectProviderRetryAfter` | `true` | 服务端给了 `Retry-After` 且不超过上限时采纳它 |
| `retryableCodes` | `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT` | 只有这些失败码会被重试 |

设置页底部会实时画出**等待序列**（如 `1s → 3s → 5s → 7s …（共 5 次）`），改数字立刻能看到效果。

### 常见用法

| 想要的效果 | 怎么设置 |
| --- | --- |
| 关掉「越等越久」，每次都等 2 秒 | `exponentialBackoff` 关闭，`initialDelaySeconds: 2`，`stepSeconds: 0` |
| 每次比上次多等 3 秒 | `exponentialBackoff` 关闭，`initialDelaySeconds: 1`，`stepSeconds: 3` |
| 恢复经典指数退避 | `exponentialBackoff` 打开，`initialDelaySeconds: 1`，`maxDelaySeconds: 30` |
| 疯狂重试直到成功 | `maxRetries: 1000`，`initialDelaySeconds: 0.05`（约 20 次/秒上限由服务端决定） |
| 不重试，失败就报错 | `maxRetries: 0` 或 `enabled` 关闭 |

## 行为细节

- **每次重试都写进会话日志**（`llm/retry` / `llm/retry-started`），和内置实现完全一致，
  所以对话界面照常显示「已排定重试 / 等待 N 秒」。
- **先落盘再等待**：等待期间取消或崩溃，日志里仍能看到已排定的尝试；取消不会留下多余的 `llm/retry-started`。
- **尝试次数以会话日志为准**（同一 provider + 同一策略键），所以刷新页面、恢复会话后计数不会错乱；
  改了任何影响行为的设置 → 策略键变化 → 从 1 重新计数。
- **只接管自己认识的失败码**：不在 `retryableCodes` 里的失败（例如 `CONTEXT_WINDOW_EXCEEDED`）
  原样交给下游策略（上下文压缩等），行为与内置实现一致。
- **不重复重试**：本插件用 `prepend` 注册，是最外层监听器；它决定重试时不会调用 `next()`，
  内置 llm-retry 不会对同一次失败再排一次。额度用尽时调用 `next()` 交回内置实现。
- **`enabled: false`** 时一行都不插手，等于没装这个插件。

## 安装

```powershell
# 1) 插件放进 profile 的 node_modules
xcopy /E /I /Y C:\Users\Administrator\dsh-plugin-llm-retry `
  "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-llm-retry"

# 2) profile 的 package.json：dependencies 加
#    "dsh-plugin-llm-retry": "file:./node_modules/dsh-plugin-llm-retry"
#    并把 "dsh-plugin-llm-retry" 追加到 dsh.profile.bundles

# 3) 重启 dsh web
```

## 自测

```powershell
node tests/retry-settings.test.mjs
```

覆盖等待时间表（固定/线性/指数/封顶/抖动）、`Retry-After` 取舍、失败码解析、策略键身份、
监听器状态机（排定、编号、retryId 沿用、额度用尽交回下游、取消、实时改设置、处置）。

## 兼容性

- 依赖 DSH 的公开扩展点：`agent/request-error` 瀑布事件、`settings` 服务、
  `settings.plugins.tab` / `plugins.item` 设置卡片槽位与 `configForms` 配置表单，
  以及 `llm/retry` 会话事件（与 `@deepseek-ai/dsh-llm-retry` 的公开事件类型一致）。
  客户端半边按 DSH 0.1.7-rc.2 的槽位契约编写（`settings.plugin.item` /
  `settingsScope` 已在该版本移除）。
- 宿主未挂载 `settings` 服务时，插件仍工作，使用组合层（`cordis.patch.yml` 的 `config`）或默认值。
