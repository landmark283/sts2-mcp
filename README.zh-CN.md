# sts2-mcp

[English README](./README.md)

`sts2-mcp` 是一个面向 **Slay the Spire 2** 的本地控制栈，由“游戏内桥接模组 +
外部 MCP 服务”两部分组成。

这个项目不把截图、OCR、鼠标点击当作主要控制路径。它的核心思路是：

- 在游戏进程内加载一个原生桥接模组
- 直接读取当前可见游戏状态
- 直接暴露当前合法动作
- 再由外部 MCP 服务把这些能力提供给 agent

## 仓库内容

- `mods/sts2-bridge`
  - 运行在 `Slay the Spire 2` 进程内的 C# / .NET 9 桥接模组
  - 暴露本地 loopback HTTP 接口
  - 序列化当前 run / combat / reward / map 等状态
  - 执行当前合法的游戏动作
- `packages/mcp-server`
  - Node 22 的 stdio MCP 服务
  - 读取桥接发现文件
  - 对外暴露桥接驱动的 MCP tools，例如：
    - `sts2_get_state`
    - `sts2_list_actions`
    - `sts2_perform_action`
    - `sts2_play_card_sequence`
    - `sts2_resolve_room_rewards`
    - `sts2_resolve_rest_site`
    - `sts2_resolve_card_selection`
    - `sts2_resolve_shop_visit`

## 当前仓库范围

这个仓库现在主要发布的是**源码**，不是本地开发全量工作区。

不会放进公开仓库的内容包括：

- 本地规划文档
- 本地实验目录
- 构建产物
- 本地 MCP 配置
- 机器相关日志与 session 文件

## 当前能力

这套代码已经在本机 `Slay the Spire 2 0.99+` 版本上做过真实联调，当前包含：

- 通过 `%APPDATA%\\SlayTheSpire2\\bridge\\session.json` 发现 bridge
- 在窗口化运行时稳定读取状态
- 列出当前合法动作
- 带 `state_version` 保护的动作执行
- 战斗出牌
- 多张牌单次调用出牌，并在手牌重排后自动 rematch
- 关卡奖励一轮结算
- 营火一轮结算
- 选牌面一轮结算
- 商店购买一轮结算，并处理购买后的重排
- 地图路线摘要建模，供 agent 做选路

## 环境要求

- Windows
- Node.js 22 或更高
- .NET 9 SDK
- 本地安装的 `Slay the Spire 2`

## 构建桥接模组

可以直接显式传入游戏安装目录：

```powershell
dotnet build .\mods\sts2-bridge\sts2-bridge.csproj `
  -p:Sts2Dir="E:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2" `
  -p:Sts2SkipDeploy=true
```

也可以先设环境变量：

```powershell
$env:STS2_DIR="E:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2"
dotnet build .\mods\sts2-bridge\sts2-bridge.csproj -p:Sts2SkipDeploy=true
```

如果要把 DLL 直接部署到游戏目录下的 `mods\sts2-bridge`，去掉
`-p:Sts2SkipDeploy=true` 即可。

## 启动 MCP 服务

```powershell
node .\packages\mcp-server\index.js
```

默认 discovery 文件路径：

```text
%APPDATA%\SlayTheSpire2\bridge\session.json
```

如需覆盖，可设置：

```text
STS2_BRIDGE_SESSION_FILE
```

## 公开仓库约定

- `packages/mcp-server/package.json` 保持 `private: true`
  - 这表示它不是一个准备发布到 npm 的包
  - 不影响作为 GitHub 源码仓库公开
- `mods/sts2-bridge/sts2-bridge.csproj`
  - 不再硬编码本机游戏安装路径
  - 请使用 `Sts2Dir`、`STS2_DIR` 或 `SLAY_THE_SPIRE_2_DIR`
- `mods/sts2-bridge/sts2-bridge.json`
  - 保持最小化、偏 loader-facing 的 manifest 结构

## 免责声明

这是一个非官方项目，与 `Slay the Spire 2` 的开发者和发行方无隶属关系。

## 许可证

[MIT](./LICENSE)
