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
npm run test:browser
npm run test:campaign # 三地图 × 四模式 × 两种子
npm run test:sdk      # 真实打包安装验证
npm run demo:agent
npm run serve:agent  # http://127.0.0.1:8789/decide
```

默认只显示地图、线路色点、乘客与底部资源。采用带有清晰目的地形状标识的立体车站和玩具列车，去掉场景装饰与厚底座；镜头随新站扩张自动调整，手动缩放/平移后可点「⌂」恢复自动取景。

拖过车站绘制线路，从端点延长；也可以拖动线路中段接入新站。左侧色点选线，「···」展开重画、闭环、加车、车厢与回收工具。点一下车站查看候车详情。空格暂停，1–7 选线，Esc 收起工具。右上角「调度」「回放」按需打开相应面板。

Agent 接口的观察字段、动作、HTTP 示例和内部状态边界见 [AGENT.md](AGENT.md)。在「调度」中可直接查看实际发送的观察 JSON。

本项目实现三张原创地图与经典、无尽、极限、创意四种模式。具体差异见 FIDELITY.md；不能将功能覆盖率当作已实测达到原版 90% 还原。

界面名称为「小小地铁 / Little Metro」。为兼容已有脚本、存档与录像，包名、协议、地图键 `orchard` 和发布文件名继续沿用原技术标识 `orchard-metro`。

## 独立 SDK

构建后 `dist-sdk` 可通过本地目录或 npm tarball 安装。入口不依赖 DOM，也不导入 Three.js。

```js
import { createSession, ReplayPlayer, dispatcherPolicy, hash } from './dist-sdk/index.mjs';
const game = createSession({ seed: 420, city: 'orchard', mode: 'normal' });
game.submit({ action: { type: 'route', line: 0, stops: [1, 2, 3] }, reason: '连接三种基础形状' });
game.step(200); // 20 Hz，推进 10 秒；补给和失败时停住
const observation = game.observe();
game.submit(dispatcherPolicy(observation), 'baseline');
const replay = game.exportReplay();
const player = new ReplayPlayer(replay); // 全量重算并校验导入
player.seek(100);
player.observationAtDecision(0); // 同一 tick 多条决策也能精确重建各自的前置观察
```

`window.metro` 暴露 `observe / getState / submit / step / pause / restart / startAgent / stopAgent / connectHttp / exportReplay / loadReplay / seek / focusDecision / observationAtDecision / capture / projectStation / hash`。`focusDecision(index)` 会暂停并在地图上显示这条决策执行前的现场；按播放继续查看后续过程。

`capture()` 返回当前 WebGL 游戏画面 PNG data URL。结构化状态接口和 `projectStation` 明确属于白盒控制；屏幕 VLM 应只使用截图和实际鼠标键盘输入，并自行声明采用的观察边界。页面中的 DOM 标签包含站点形状、候车和拥挤指示，屏幕 Agent 应使用 Playwright 页面截图以包含标签与界面。

`createBrowserGame` 从 `@snack-lab/orchard-metro/browser` 导出一个独立浏览器控制器，可挂接自己的 UI；它不自动挂载本项目的 Three.js 渲染器。

## Agent 协议

POST JSON：`{ protocol:'orchard-metro.agent.v1', tick, state, budget }`。
响应：`{ protocol, tick, action, reason?, candidates?:[{label,value}] }`。
支持的动作见 `src/types.ts`：`route / addTrain / removeTrain / moveTrain / carriage / interchange / upgrade / station / wait`。机车、隧道等不足会返回 `ok:false` 并记录，不能绕过资源约束。

HTTP 请求使用 AbortSignal，最多 64 KiB 响应。浏览器等待 Agent 时冻结时钟；超时、错误和非法操作都被记录，连续三次失败暂停并交还控制。接管、重开、回放、暂停会取消未完成请求，旧响应不会污染新局。SDK `runAgent` 可独立运行并输出录像；没有绑定任何真实模型服务，内置策略是启发式基线。

## 回放语义

固定 20 Hz、种子随机数、严格顺序动作。决策包括操作前观察哈希、操作后状态哈希、控制器来源、公开说明、候选得分、耗时、实际执行结果和错误。`step` 只推进模拟；暂停/倍速属于宿主播放设置，不改游戏状态。

导入对所有动作、阶段切换、检查点及最终状态重新模拟；不信任录像里携带的状态。`seek(tick)` 表示该 tick 所有已录动作之后，`observationAtDecision(index)` 表示指定动作之前。回放不再调用任何 Agent。哈希用于确定性校验，不是密码学签名。JSON 导入上限 32 MiB / 50,000 条决策 / 6 小时。

本机历史最多保存五局；导出 JSON 可以独立分享与重放。决策说明仅记录控制器主动提供的公开摘要，不生成或索取模型私有思维链。

GPL-3.0-or-later；来源、许可与第三方说明见 NOTICE.md。
