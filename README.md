# DSH WorkBuddy Provider

为 DeepSeek Harness（DSH）增加 `WorkBuddy 中国区` Provider。插件通过 WorkBuddy
提供的 API Key 调用模型，并在 DSH WebUI 中显示剩余积分。

> [!IMPORTANT]
> API Key 来自 **WorkBuddy**，用于调用供 WorkBuddy 使用的模型服务。本插件是第三方
> 适配器，不属于 WorkBuddy、CodeBuddy 或 DSH 官方项目。

> [!NOTE]
> 本包是 [`@axiaohungry/dsh-llm-workbuddy`](https://github.com/Axiaohungry/dsh-llm-workbuddy)
> 的 fork，改为仅支持 API Key 认证。原作者为 Axiaohungry，原项目以 MIT 许可发布，
> 版权归其所有。两个包会插入同一个 `llm-workbuddy` 组合行，**不要同时安装**；
> `install` 命令在检测到旧包时会先将其移除。

## 功能

- 在 DSH WebUI 中使用 `WorkBuddy 中国区`；
- 使用 WorkBuddy API Key 认证，支持环境变量与多个 DSH 保存值并随时切换；
- 输入框底部显示剩余积分胶囊，点击展开资源包明细；
- 自动从 WorkBuddy 获取当前 Key 可用模型；
- 模型 ID、名称、上下文窗口、最大输出 Token 和思考档位均可编辑；
- 不依赖本机 WorkBuddy / CodeBuddy CLI。

## 环境要求

- 已安装 DSH（`>= 0.1.2-alpha.2 < 0.2.0`）；
- Node.js `>= 22.19.0`；
- Windows、Linux 或 macOS。

## 依赖说明

插件复用 DSH 自带的 pi-ai 运行时，**不单独安装** `@earendil-works/pi-ai`：

- `@deepseek-ai/dsh-llm-pi-ai` 由 DSH 自带，并由它提供 pi-ai；
- 本插件把 pi-ai 声明为 `peerDependencies` 且**不设上界**
  （`>=0.84.2`），从而始终使用宿主那一份；
- 如果给 pi-ai 加上界，宿主升级 pi-ai 后范围不匹配，包管理器就会再装一份
  私有副本，从而出现两套 pi-ai —— 这正是本插件要避免的情况。

插件在 `cordis.patch.yml` 中禁用了宿主 `llm-pi-ai` 行并接管其职责，因此除
WorkBuddy 外，它也会继续代理 `settings.yaml` 中其它 pi-ai provider
（内置目录 provider 与手写通用 provider）。

## 安装

在 PowerShell 或终端执行：

```powershell
npx --yes @yudong22/dsh-llm-workbuddy@latest install
```

安装器会为 DSH 的 `web` 和 `headless` Profile 安装插件。安装完成后重启 DSH。

也可以只安装 Web Profile：

```powershell
dsh plugin --profile web add @yudong22/dsh-llm-workbuddy@latest
```

## WebUI 配置

打开 **设置 → 模型**，添加或编辑 `WorkBuddy 中国区`。

API 地址、协议与兼容开关已经由插件的 Provider 默认层填好，通常只需要提供 API Key：

- `API 地址` 默认为 `https://copilot.tencent.com/v2`；
- `协议` 默认为 `openai-completions`。

### 使用环境变量中的 Key

插件会自动检测：

```text
WORKBUDDY_API_KEY
```

存在时会在 API Key 来源下拉列表里显示“环境变量 WORKBUDDY_API_KEY”。选择它即可
使用；密钥值不会显示在页面中，也不会写入 `settings.yaml`。

### 在 DSH 中保存新的 Key

1. 在“API Key”输入框粘贴 WorkBuddy Key；
2. 点击应用 / 保存；
3. 新 Key 会出现在“当前 API Key”下拉列表中，并立即切换为当前 Key。

DSH 保存的 Key 存放在 DSH 凭据服务中。可以保存多个 Key 并随时切换；环境变量 Key
和 DSH 保存的 Key 互不覆盖。删除操作只允许删除 DSH 保存的 Key，不会删除环境变量。

## 剩余积分胶囊

输入框底部会显示一个积分胶囊按钮，点击展开明细：

- 剩余积分合计；
- 每个资源包的剩余量与到期时间。

胶囊在折叠状态下展示缓存的读数。只有展开弹层时才请求积分接口，且不使用定时器轮询；
同一份缓存写入 `localStorage`，在所有会话与窗口间共享，刷新后保留。距上次成功请求
不足 30 秒时直接复用缓存。如果接口暂时不可用，页面会显示“暂不可用”，不影响模型调用。

> [!NOTE]
> 积分查询使用与模型调用相同的 API Key。WorkBuddy 的“今日请求次数/今日积分用量”
> 接口只接受网页登录令牌，不接受 API Key，因此本插件不再显示这两项。

## 获取和编辑模型

1. 在 `WorkBuddy 中国区` 的设置中点击“获取可用模型”；
2. 插件使用当前选中的 API Key 请求 WorkBuddy 模型目录；
3. 选择要使用的模型并保存；
4. 再次编辑时，可以直接修改模型 ID、显示名称、上下文窗口和最大输出 Token。

模型目录按当前 API Key 的权限返回。更换 Key 后建议重新获取一次。如果在线目录暂时
失败，插件会使用内置目录作为兜底。

## ModLens 兼容性

插件兼容 `modlens-workbuddy-cn` 等包装 Provider。包装 Provider 会先由 ModLens 处理
图片，再把请求转发给 WorkBuddy：

- 会话历史中有图片时，首次响应可能比 WorkBuddy 直连慢；
- 超时、无响应或 `429`/“配额耗尽”通常来自 ModLens 的视觉引擎，不代表 WorkBuddy
  API Key 失效；
- 纯文本任务可切换到 `workbuddy-cn/<model-id>`，绕过视觉桥接；
- WorkBuddy 的积分与 ModLens 视觉引擎额度相互独立，插件不会混合统计。

## 思考程度

思考档位按模型分别决定，插件不会给所有模型强行使用同一套选项。在线模型目录会声明
每个模型是否支持思考、支持哪些档位以及默认档位，WebUI 会据此显示可用选项。

常见档位包括：

```text
off / minimal / low / medium / high / xhigh / max
```

实际选项可能因模型不同而不同。未手动指定时，使用 WorkBuddy 返回的默认档位。

## 认证和请求说明

- 请求使用 WorkBuddy 的 OpenAI-compatible 接口；
- DSH 负责 Agent 循环、上下文、工具调用和权限；
- WorkBuddy 负责模型推理并返回结果；
- API Key 不会写入模型目录或 `settings.yaml`。

## 更新

重新执行安装命令即可更新，已有的模型配置与 API Key 会保留：

```powershell
npx --yes @yudong22/dsh-llm-workbuddy@latest install
```

## 卸载

```powershell
npx --yes @yudong22/dsh-llm-workbuddy@latest uninstall
```

卸载会移除 `WorkBuddy 中国区` 的 Provider 和插件包，并备份 DSH 设置文件。API Key
默认保留在 DSH 凭据服务中。

## 常见问题

### 看不到 WorkBuddy Provider

重启 DSH 后重新打开 **设置 → 模型**。也可以检查：

```powershell
dsh plugin --profile web list --depth 0
```

### API Key 下拉列表只有环境变量

在 `WorkBuddy 中国区` 的 API Key 输入框粘贴 Key 并保存。成功后新 Key 会出现在
“当前 API Key”下拉列表。

### 获取模型失败

确认当前选中的 Key 来自 WorkBuddy 且仍然有效，然后重新获取模型目录。

### 积分显示“暂不可用”

积分查询依赖 WorkBuddy billing 接口。网络或接口暂时不可用时会显示“暂不可用”，
不影响模型调用。确认当前 API Key 有效即可。

### 调用时报 `500 status code (no body)`

先更新插件并重启 DSH。最新版会恢复 WorkBuddy 官方请求标识。

### 修改后页面仍显示旧布局

浏览器执行 `Ctrl+F5` 强制刷新；如果 DSH 进程已经运行较久，再关闭并重新启动 DSH。

## License

[MIT](./LICENSE)
