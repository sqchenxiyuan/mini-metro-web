# 小小地铁 · Little Metro

Mini Metro 核心玩法的独立 Web 重建，借鉴 Boomerang Fu 的低多边形造型、明快配色、柔和阴影和哑光玩具质感，题材保持为城市地铁。当前视觉使用浅粉、薄荷青、淡紫与浅蓝的粉彩配色，车站与列车采用圆角造型；较深的形状标识和彩色线路保持辨识度。

```powershell
git clone https://github.com/sqchenxiyuan/mini-metro-web.git
cd mini-metro-web
npm ci
npm run dev          # http://127.0.0.1:5175
npm run build
npm run preview      # http://127.0.0.1:4175
npm test
npx playwright install chromium # 初次安装；容器内可设置 PLAYWRIGHT_BROWSERS_PATH 为可写目录
npm run test:browser # 默认用 Playwright 管理的 Chromium；METRO_BROWSER_EXECUTABLE_PATH 可选指定浏览器
npm run test:campaign # 三地图 × 四模式 × 两种子
npm run test:sdk      # 真实打包安装验证
npm run demo:agent
npm run serve:agent  # http://127.0.0.1:8789/decide
```

默认只显示地图、线路色点、乘客与底部资源。**普通入口**为 [直接游玩](https://sqchenxiyuan.github.io/mini-metro-web/)；[AI 集成入口](https://sqchenxiyuan.github.io/mini-metro-web/integration.html)将相同游戏置于中央，画面截取、结构化观察、动作 JSON 与 HTTP Agent 设置在游戏外部。完整边界见 [ARCHITECTURE-vNext.md](ARCHITECTURE-vNext.md)。采用带有清晰目的地形状标识的立体车站和玩具列车，去掉场景装饰与厚底座；镜头随新站扩张自动调整，手动缩放/平移后可点「⌂」恢复自动取景。

拖过车站绘制线路，从端点延长；也可以拖动线路中段接入新站。左侧色点选线，「···」展开重画、闭环、加车、车厢与回收工具。点一下车站查看候车详情。空格暂停，1–7 选线，Esc 收起工具。右上角「调度」「回放」按需打开相应面板。

Agent 接口的观察字段、动作、HTTP 示例和内部状态边界见 [AGENT.md](AGENT.md)。普通入口只面向人类游玩；AI 集成页提供完整状态观察、截图和外部动作入口。

本项目实现三张原创地图与经典、无尽、极限、创意四种模式。具体差异见 FIDELITY.md；不能将功能覆盖率当作已实测达到原版 90% 还原。

十种 Workshop 文档支持的车站形状已可在创意模式手动选择，目的地、渲染与回放也支持这些形状。普通/无尽/极限的自动扩站仍使用本版旧规则，只会生成其中六种；原版各城市的特殊形状池、生成时序与替换行为尚未对照或实现。该增加不表示已实现与原版的城市级生成一致性。所有模式的乘客目的地都按**已有且与本站形状不同的车站数**加权抽取：一种形状有多少站，就占多少份权重。因此单座新特殊站不会立刻与常见形状承担同等目的地需求；每座站自身的乘客生成间隔仍按游戏周数计算，不随站点数直接缩短。这是本项目的平衡规则，尚未对照原版。

界面名称为「小小地铁 / Little Metro」。包名、协议和地图键 `orchard` 沿用原技术标识 `orchard-metro`；规则和回放协议分别为 `rules.7`、`replay.v7`，旧录像不可直接导入。服务时间以 1× 现实秒数定义：普通站每位上/下车 0.20 秒，换乘枢纽 0.15 秒；同列车先下后上，结束后另停顿 0.35 秒。逻辑层内部以固定 tick 确定性换算，车站与车内的形状在归属变化时直接切换，不绘制移动中的乘客。

`npm run test:browser` 需先运行 `npm run build` 和本地预览服务；`PLAYWRIGHT_BROWSERS_PATH` 可用于容器中的浏览器缓存。`PLAYWRIGHT_BROWSERS_PATH=… node scripts/ui-verify.mjs` 验收地图优先的桌面/手机 UI、错误提示与同种子重试；`VITE_BASE_PATH=/mini-metro-web/ npm run build` 后运行 `node scripts/pages-verify.mjs` 验证 Pages 子路径下字体及所有静态资源加载。局中中文使用自托管精简版 Noto Sans SC WOFF2（移除原 10 MB TTF），许可证见 `public/fonts/OFL.txt` 和 `NOTICE.md`。场景中的乘客目的地与拥挤提示由 WebGL 绘制，DOM 站点按钮仅作触控和无障碍操作。

**首版地图边界：** `src/map-generation.ts` 提供独立、可验证的城市区域/站型池/日程原型及种子事件记录；它仍是未接入线上游戏的 opt-in `rules.2` 提案，以原有 240 tick/日独立运行，和当前游戏的 `rules.7` 互不兼容。线上游玩仍使用统一扩站器；城市原版参数及特殊站替换规则尚未做原版实机对照。不要把地图原型测试通过写成已上线的城市级生成。

## GitHub Pages 部署

提交到 `main` 后，`.github/workflows/pages.yml` 会运行 `npm ci`、`npm test`、`npm run build`，并仅将构建产物 `dist/` 作为静态站点部署到 [GitHub Pages](https://sqchenxiyuan.github.io/mini-metro-web/)。仓库所有者需先在 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；不需要部署密钥或额外服务端。工作流需要允许 GitHub Actions 运行，`GITHUB_TOKEN` 权限在工作流中声明为 `contents:read`、`pages:write`、`id-token:write`。首次发布需要将工作流推送到 `main` 并等待构建与部署成功，公开地址并非当前本地修改已上线的证明。

Pages 构建通过 `VITE_BASE_PATH=/mini-metro-web/` 指定仓库子路径；本地未设置该变量时保持相对资源路径，`npm run dev` 和 `npm run preview` 仍可从根路径访问。可用 `VITE_BASE_PATH=/mini-metro-web/ npm run build` 本地检查待发布资产；Pages 只上传 `dist/`，不会上传源码或 `dist-sdk/`。这是独立的可玩 Web 版本，不代表与原版功能完全一致。

## 独立 SDK

构建后 `dist-sdk` 可通过本地目录或 npm tarball 安装。入口不依赖 DOM，也不导入 Three.js。

```js
import { createSession, ReplayPlayer, dispatcherPolicy, hash } from './dist-sdk/index.mjs';
const game = createSession({ seed: 420, city: 'orchard', mode: 'normal' });
game.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3] }, reason: '连接三种基础形状' });
game.step(500); // 50 Hz，推进 10 秒；补给和失败时停住
const observation = game.observe();
game.submit(dispatcherPolicy(observation), 'baseline');
const replay = game.exportReplay();
const player = new ReplayPlayer(replay); // 全量重算并校验导入
player.seek(100);
player.observationAtDecision(0); // 同一 tick 多条决策也能精确重建各自的前置观察
```

`window.metro` 暴露 `observe / getState / submit / step / pause / restart / startAgent / stopAgent / connectHttp / exportReplay / loadReplay / seek / focusDecision / observationAtDecision / capture / projectStation / hash`。`focusDecision(index)` 会暂停并在地图上显示这条决策执行前的现场；按播放继续查看后续过程。

`capture()` 返回当前 WebGL 游戏画面 PNG data URL（含场景内乘客/拥挤标记，不含外层 DOM 控件）。结构化状态接口和 `projectStation` 明确属于白盒控制；屏幕 VLM 应只使用截图和实际鼠标键盘输入，并自行声明采用的观察边界。截取整个页面请使用浏览器截图；透明 DOM 站点按钮保留用于触摸与屏幕阅读器。

`createBrowserGame` 从 `@snack-lab/orchard-metro/browser` 导出一个独立浏览器控制器，可挂接自己的 UI；它不自动挂载本项目的 Three.js 渲染器。

## Agent 协议

POST JSON：`{ protocol:'orchard-metro.agent.v1', tick, state, budget }`。
响应：`{ protocol, tick, action, reason?, candidates?:[{label,value}] }`。
支持的动作见 `src/types.ts`：`route / addTrain / removeTrain / moveTrain / carriage / interchange / upgrade / station / wait`。机车、隧道等不足会返回 `ok:false` 并记录，不能绕过资源约束。

HTTP 请求使用 AbortSignal，最多 64 KiB 响应。浏览器等待 Agent 时冻结时钟；超时、错误和非法操作都被记录，连续三次失败暂停并交还控制。接管、重开、回放、暂停会取消未完成请求，旧响应不会污染新局。SDK `runAgent` 可独立运行并输出录像；没有绑定任何真实模型服务，内置策略是启发式基线。

## 回放语义

固定 50 Hz、种子随机数、严格顺序动作。决策包括操作前观察哈希、操作后状态哈希、控制器来源、公开说明、候选得分、耗时、实际执行结果和错误。`step` 只推进模拟；暂停/倍速属于宿主播放设置，不改游戏状态。

导入对所有动作、阶段切换、检查点及最终状态重新模拟；不信任录像里携带的状态。`seek(tick)` 表示该 tick 所有已录动作之后，`observationAtDecision(index)` 表示指定动作之前。回放不再调用任何 Agent。哈希用于确定性校验，不是密码学签名。JSON 导入上限 32 MiB / 50,000 条决策 / 6 小时。

本机历史最多保存五局；导出 JSON 可以独立分享与重放。决策说明仅记录控制器主动提供的公开摘要，不生成或索取模型私有思维链。

GPL-3.0-or-later；来源、许可与第三方说明见 NOTICE.md。
