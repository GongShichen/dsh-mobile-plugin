# Harness Link Plugin

<img src="docs/assets/HLMark.svg" width="64" alt="Harness Link — Glide Ray">


通过 Android/iOS 原生客户端连接电脑上的 DeepSeek Harness。插件嵌入 iroh，优先直连，在需要时使用公共端到端加密中继；不需要自己部署服务器。

本项目是独立社区扩展，与 DeepSeek 无隶属关系。配对手机可以操作所连接 profile 的会话和工作区，只授权自己的设备。

## 兼容基线

- macOS Apple Silicon，Node.js 24.9 或更高。
- DeepSeek Harness `0.2.2-alpha.2`，源码提交 `ce7073d51254c26cd63b22a60835b8f948deb447`。
- iroh Node binding `1.2.0`（核心 `1.4.1`）。
- 对应移动端：[GongShichen/dsh-mobile](https://github.com/GongShichen/dsh-mobile)。

DSH 接口仍在变化。插件通过 `engines.dsh` 限定已适配版本，不绕过宿主兼容检查。Windows、Linux 与 Intel Mac 不在此版本的发布目标中。

## 开发、构建和安装

```bash
git clone git@github.com:GongShichen/dsh-mobile-plugin.git
cd dsh-mobile-plugin
npx --yes pnpm@11.28.5 install --frozen-lockfile
npx --yes pnpm@11.28.5 check
npx --yes pnpm@11.28.5 pack
```

将预构建包安装进实际使用的 DSH profile。下面是 Web profile 的例子：

```bash
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile web add ./dsh-mobile-plugin-0.1.1.tgz
npx @deepseek-ai/dsh@0.2.2-alpha.2 web
```

源码开发也可使用 `plugin --profile web add /absolute/path/to/dsh-mobile-plugin`，先构建，再重启 profile。桌面应用使用自己的 profile，应在其插件管理界面安装构建包，不要假定与 `web` 共用配置。

## 使用

1. 打开侧栏或设置中的“移动访问”。
2. 生成二维码，在 Harness Link 中扫描；邀请五分钟后失效。
3. 在电脑上核对手机名称并批准。
4. 手机保存电脑身份，以后自动重连；界面区分直连与加密中继。
5. 丢失手机或不再使用时，在电脑上撤销设备。所有该设备连接和推送注册同时失效。

不需要打开 DSH 的公网监听端口，不需要把启动 token 或模型 API key复制到手机。电脑必须保持唤醒且 DSH 正在运行。

## 配置

插件配置由 Cordis schema 校验。默认数据保存在当前 profile 下的 `mobile-access/`；不同 profile 的身份、授权设备、操作账本和通知配置隔离。

| 配置 | 默认值 | 用途 |
|---|---|---|
| `hostName` | 本机名称 | 手机显示的电脑名称 |
| `dataDirectory` | 当前 profile/mobile-access | SQLite 与临时文件位置 |
| `invitationTtlMs` | 300000 | 邀请有效期，不得超过五分钟 |
| `maxFileBytes` | 32 MiB | 单文件限制 |
| `maxDeviceBytes` | 128 MiB | 单设备临时文件配额 |
| `uploadTtlMs` | 3600000 | 临时文件有效期 |
| `maxConnections` | 8 | 并发连接上限 |
| `maxSubscriptions` | 32 | 每连接订阅上限 |

身份 seed、APNs 私钥、Firebase 私钥和推送 token 存储在 macOS Keychain，不写入配置文件或 Git。运行时会将必要身份材料加载进内存，因此不宣称私钥永远不离开硬件安全区。

## 手机通知

Mac 直接请求 APNs/FCM，不部署通知网关。在“移动访问 → 手机通知”导入凭据，自动校验后向已配对手机发送测试通知。

Apple 首次密钥创建及 App 签名必须使用自己的匹配开发者团队。Firebase 导入 `service-account.json` 与 `google-services.json`，手机自动接收公开配置，不接收服务端私钥。详见[通知配置说明](docs/notifications.md)。

推送服务接受不等于手机已经收到；打开测试通知会回传确认。无 GMS Android、系统通知权限关闭、电脑离线或休眠时，后台提醒可能不可用。通知不替代状态同步。

## 源码结构

- `src/transport`：真实 iroh 连接、鉴权门禁、RPC/事件/文件流。
- `src/pairing`、`src/storage`：邀请、授权设备、Keychain、SQLite、操作幂等账本。
- `src/bridge`、`src/sync`：固定移动方法白名单，调用官方 Gateway，转换领域流。
- `src/attachments`：设备绑定的断点临时文件和官方 receipt。
- `src/notifications`：凭据导入、APNs/FCM、持久通知队列。
- `src/client`：官方 Slot 扩展，不修改 DSH 页面源码。
- `protocol`：两端共享的版本化协议和测试样例。

数据和界面的协议边界见 [mobile/v1](protocol/PROTOCOL.md)。未打开的会话同步摘要，历史与文件按需读取。归档不删除原始 DSH 日志。文件修改通过原有 Agent 工具执行。

## 验证

`pnpm check` 包括 TypeScript 检查、行为测试与发布构建。真实 iroh 本机加密连接测试覆盖配对、权限门禁、RPC、独立事件流、二进制传输、持久重连和撤销。APNs/FCM 单元测试使用可控 provider transport，不向真实设备发送通知。

权限确认、计划审阅与询问的同步范围、计时和补答语义，以及 Android 跨端回归方法见 [移动端交互说明](docs/HLInteractions.md)。

实际 DSH 集成 fixture 位于 `tests/fixtures`，使用隔离的 `DSH_HOME`，不读取用户模型凭据。真机推送、蜂窝网络与 App 签名必须另外验收；具体已执行结果见 [验证记录](docs/VALIDATION.md)。

## 桌面界面

“移动访问”入口沿用 DSH 侧栏的文字、间距和悬停样式；面板分为“连接设备”和“通知设置”。二维码、配对确认与设备状态集中在连接页，通知凭据按平台逐步配置。界面使用宿主的浅色/深色主题变量，支持窄窗口及减少动效设置。

Source naming conventions: [HL naming](docs/HLNaming.md).
