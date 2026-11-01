# Harness Link Plugin

**让手机安全接入正在运行的 DeepSeek Harness。**

[![macOS Apple Silicon](https://img.shields.io/badge/macOS-Apple%20Silicon-595959.svg)](#安装) [![License: MIT](https://img.shields.io/badge/License-MIT-595959.svg)](LICENSE)

**[下载安装包](https://github.com/GongShichen/dsh-mobile-plugin/releases/tag/v0.1.3) · [安装](#安装) · [连接手机](#连接手机) · [手机通知](#手机通知) · [协议](protocol/PROTOCOL.md)**

<img src="assets/HLBanner.webp" alt="Harness Link Plugin — Pair your phone. Keep your agent on your Mac." width="100%">

这是 [Harness Link 移动 App](https://github.com/GongShichen/dsh-mobile) 的桌面接入插件。它在现有 DSH profile 中提供配对、P2P 连接、状态同步和手机通知，复用官方接口，不修改 DSH 运行时。

## 安装

| 条件 | 当前适配基线 |
| --- | --- |
| 桌面 | macOS / Apple Silicon。 |
| 宿主 | DeepSeek Harness `0.2.2-alpha.2`，基线 [ce7073d](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447)。 |
| 工具链 | Node.js 24.9+、pnpm 11.28.5。 |
| 手机 | 配套 [Harness Link](https://github.com/GongShichen/dsh-mobile)，支持 Android 8.0+ / iOS 17.5+。 |

从 [v0.1.3 Preview](https://github.com/GongShichen/dsh-mobile-plugin/releases/tag/v0.1.3) 下载 `dsh-mobile-plugin-0.1.3.tgz`，校验同页的 `SHA256SUMS.txt`，再安装到实际使用的 profile。下面以 **Web profile** 为例，在安装包所在目录运行：

```sh
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile web add "$PWD/dsh-mobile-plugin-0.1.3.tgz"
npx @deepseek-ai/dsh@0.2.2-alpha.2 web
```

若使用 DSH Desktop，先打开应用完成 profile 初始化，再完全退出；将上面安装命令中的 `--profile web` 改为 `--profile desktop`，安装后重新打开 Desktop。两个 profile 的配置和设备授权相互独立。

插件通过 `engines.dsh` 限定已适配版本。Windows、Linux 和 Intel Mac 尚不在当前发布目标内。

## 连接手机

1. 在 DSH 侧栏或设置中打开 **移动访问**。
2. 生成二维码，让手机扫描；也可复制配对链接到 App。邀请五分钟后失效。
3. 在电脑核对手机名称并确认授权，手机随后同步会话与工作区。
4. 下次打开 App，选择已配对电脑即可重连；需要停止授权时，在电脑撤销设备。

授权手机可以操作这个 profile 的会话与工作区，请只配对自己信任的设备。撤销会立即断开连接、取消订阅，并移除该设备的推送注册。

## 一次配对，继续同一份工作

| 能力 | 插件提供的连接 |
| --- | --- |
| 会话与执行 | 官方会话、工作区、模型目录、流式输出、思考与工具过程、任务状态；手机与 Web 操作同一份 DSH 数据。 |
| 需要你决定的时刻 | 同步审批、计划审阅和用户询问，答复交回官方交互流程；另一端已处理的请求及时取消。 |
| 文件与结果 | 工作区浏览和下载、设备绑定的分块上传、官方附件 receipt，以及 Web 同源的按轮次文件改动和文本差异。 |

未打开的会话同步摘要，历史与文件按需读取。文件改动快照随桌面会话存活；桌面重启或释放会话后，旧快照不可用。文件修改通过桌面 Agent 工具执行。

`permissions` 能力将手机选择交给官方 `/permission` 命令，仅改变当前会话。权限目录随桌面贡献动态刷新；上下文、Token / 缓存和会话统计复用官方投影，不在手机重新统计历史。

## 连接与数据

**无需自建服务器。** 插件直接嵌入 iroh，优先建立直连；直连不可达时使用公共端到端加密中继。它不要求开放 DSH 公网监听端口，也不把 DSH 启动 token 或模型 API key 交给手机。

二维码只携带短期邀请与连接信息；连接身份经过认证后，设备仍需桌面批准。各 profile 拥有独立身份和设备授权；身份材料及推送凭据保存在 macOS Keychain。

Mac 必须保持唤醒，DSH 必须运行。手机进入后台后，系统可以暂停 P2P；重新打开 App 时获取当前状态。桌面未发送草稿和第三方插件 React 页面不转换为原生界面。

## 手机通知

在 **移动访问 → 通知设置** 导入凭据，点击“校验并启用手机通知”。Mac 直接调用 APNs / FCM，不另设通知网关。

| 平台 | 导入内容 | 配置结果 |
| --- | --- | --- |
| iOS | 自己的 APNs `.p8`；匹配的 Key ID、Team ID、Bundle ID 和推送环境。 | 从手机读取应用信息，从标准密钥文件名识别 Key ID；不能推导的字段补填一次。 |
| Android | `service-account.json` 与 `google-services.json`。 | 校验项目和 App，向手机下发公开 Firebase 配置，自动注册 token；首次启用无需重编 APK。 |

第一次创建 Apple 密钥、配置签名或创建 Firebase 项目，仍需在自己的开发者账号中完成。iOS 推送要求安装包与 APNs 凭据匹配的团队；免费 Personal Team 构建不提供 APNs。

服务端私钥留在 Mac。通知不包含对话正文；“服务已接收”和“手机已确认”分别展示。无 GMS、通知权限关闭或 Mac 离线、休眠时，后台提醒可能不可用。通知不承担会话同步。

## 开发与验证

从源码构建安装包：

```sh
git clone https://github.com/GongShichen/dsh-mobile-plugin.git
cd dsh-mobile-plugin
npx --yes pnpm@11.28.5 install --frozen-lockfile
npx --yes pnpm@11.28.5 pack --out dsh-mobile-plugin-0.1.3.tgz
```

`pack` 会先执行发布构建，再打包。完整检查可运行：

```sh
npx --yes pnpm@11.28.5 check
```

[CI](https://github.com/GongShichen/dsh-mobile-plugin/actions/workflows/check.yml) 运行 TypeScript、行为测试和发布构建。iroh 测试覆盖真实本机加密连接、配对门禁、RPC、事件流、二进制传输、重连和设备撤销。

实际 DSH 集成 fixture 与原生回归脚本使用隔离 profile，不读取用户模型凭据。APNs / FCM 单元测试使用可控 transport；真机推送和跨网络可达性分别验收。

- [src/bridge](src/bridge) 与 [src/sync](src/sync)：固定移动能力白名单，复用官方 Gateway / Connection Fetch。
- [src/transport](src/transport)、[src/pairing](src/pairing) 与 [src/storage](src/storage)：P2P、身份、设备授权和操作账本。
- [src/attachments](src/attachments)、[src/notifications](src/notifications) 与 [src/client](src/client)：附件、通知和官方 UI slots 扩展。
- [protocol/PROTOCOL.md](protocol/PROTOCOL.md)：共享协议、同步与交互语义；[scripts](scripts) 中的 Android / iOS QA 控制脚本支持 `--only changes` 文件改动回归。

源码开发可在构建后使用 `plugin --profile web add /absolute/path/to/dsh-mobile-plugin` 安装目录，再重启该 profile。

<details>
<summary>插件配置与默认值</summary>

配置由 Cordis schema 校验。默认数据保存在当前 profile 的 `mobile-access/`，不同 profile 的 SQLite、设备、操作账本和通知配置隔离。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `hostName` | 本机名称 | 手机显示的电脑名称。 |
| `dataDirectory` | 当前 profile 下的 `mobile-access/` | SQLite 与临时文件位置。 |
| `invitationTtlMs` | `300000` | 邀请有效期，最多五分钟。 |
| `maxFileBytes` | 32 MiB | 单个传输文件限制。 |
| `maxDeviceBytes` | 128 MiB | 单设备临时文件配额。 |
| `uploadTtlMs` | `3600000` | 临时文件有效期。 |
| `maxConnections` | `8` | 并发连接上限。 |
| `maxSubscriptions` | `32` | 每连接订阅上限。 |

身份、APNs / Firebase 私钥与推送 token 使用 Keychain；普通配置与临时文件不应提交到 Git。

</details>

## 许可证

[MIT](LICENSE)。第三方组件与授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

Harness Link Plugin 是独立社区扩展，与 DeepSeek 无隶属关系。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的名称及相关权利属于其各自权利人。
