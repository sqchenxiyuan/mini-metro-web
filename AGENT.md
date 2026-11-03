# 当前 Agent 接入方式

这是完整结构化状态接口。游戏负责列车行驶、上下客、寻路和换乘；Agent 负责规划线路、分配运力和选择补给。它目前没有绑定任何大模型厂商。

## Agent 能看到什么

实际发送的对象为 `{ protocol, tick, state, budget }`，由 `src/session.ts` 的 `observeState()` 生成。`state` 是整个模拟状态的深拷贝。

| 数据 | 具体内容 |
|---|---|
| 车站 | 编号、坐标、形状、每位候车乘客的目的地形状/生成时间/换乘次数、拥挤计时、是否为枢纽 |
| 线路 | 线路编号、有序站点列表、是否为环线 |
| 列车 | 所属线路、当前区间的起终站、行驶进度和方向、停站剩余 tick、车上乘客、附加车厢、回收/调动状态 |
| 资源与进度 | 空闲机车/车厢/枢纽、总隧道与剩余隧道、当前周次、游戏阶段、当前补给选项、累计送达人数 |
| 内部状态 | seed、rng、nextStation（新站生成时刻）、各站 nextPassenger（乘客生成时刻）、实体序号和累计统计也会发送 |
| 基础参数 | 20 Hz / 每 tick 0.05 秒、每节基础容量 6、普通站拥挤阈值 6；列车实际容量需结合车厢数，枢纽容量见规则 |

因此它比人类看画面获得的信息更多，**不属于仅看屏幕的 VLM 测试**。当前没有对 rng 或未来生成时刻做过滤。没有额外提供“推荐线路”“预计到站时间”“每线吞吐率”或完整合法动作列表；这些需由控制器基于状态自行分析。内置策略会自行评估新站连接、绕行代价、候车压力与资源约束。

在游戏右上角打开「调度」→「查看 Agent 收到的数据」，可以看到当前完整 JSON（会暂停游戏）。`window.metro.observe()` 返回运行中局面的同一契约；回放中的观察用 `observationAtDecision(index)` 重建。

## Agent 能做什么

| 动作 | 作用 |
|---|---|
| `route` | 创建、重画、延长、闭合或撤销指定线路 |
| `addTrain` / `removeTrain` / `moveTrain` | 增派、到站回收、到站清客后调往指定线路/车站 |
| `carriage` | 加挂或拆卸车厢，`delta` 为 `1` 或 `-1` |
| `interchange` | 用枢纽资源升级车站 |
| `upgrade` | 从当前每周补给中选择一项 |
| `station` | 创意模式手动建站 |
| `wait` | 保持现状，继续推进模拟 |

游戏验证资源、站点、模式限制等。非法操作会记录 `ok:false` 和原因，不会绕过规则。返回的 `reason` 是 Agent 提供的公开决策摘要，`candidates` 是可选的候选方案与得分。

## 两种接法

**直接函数 / Node SDK：**

```js
import { createSession } from './dist-sdk/index.mjs';
const game = createSession({ seed: 420 });
const observation = game.observe();
game.submit({
  action: { type: 'route', line: 0, stops: [1, 2, 3] },
  reason: '先连通三种基础形状的车站',
}, 'my-agent');
game.step(80); // 推进 4 秒模拟时间，然后再次观察
```

网页也可使用 `window.metro.startAgent(async (observation, signal) => decision)`。纯 Node 批量运行用 `runAgent({ policy, interval, maxTicks })`。

**外部 HTTP 服务：**游戏向你填写的地址 POST 观察 JSON。服务可调用 LLM、搜索算法或自定义策略，回复如下格式。`protocol` 与 `tick` 必须回传请求中的值：

```json
{
  "protocol": "orchard-metro.agent.v1",
  "tick": 0,
  "action": { "type": "route", "line": 0, "stops": [1, 2, 3] },
  "reason": "连通圆形、三角形和方形车站",
  "candidates": [{ "label": "基础三站线", "value": 1 }]
}
```

运行 `npm run serve:agent` 后，示例端点为 `http://127.0.0.1:8789/decide`。它调用的是内置**启发式策略**，并非 LLM。自定义服务需要处理浏览器 CORS / OPTIONS；示例提供了完整实现。模型请求与密钥应放在自己的服务端适配层，游戏只认识这份 JSON 契约。

## 调用节奏、失败与回放

浏览器每推进 80 ticks（4 秒模拟时间）请求一次，遇到每周补给会立即请求。等待回复时冻结模拟时钟；网页请求超时为 5 秒。HTTP 只接收最多 64 KiB 的回复，拒绝错误协议、过期 tick 和非法结构。连续三次控制器错误或非法操作后暂停并交还手动控制。

接管、暂停、重开与进入回放会取消旧请求；旧回复不能改写新局。纯 Node `runAgent` 的默认超时为 3 秒、默认 interval 为 80 ticks，均可通过参数调整。

每条记录包含输入状态哈希、动作、执行结果、来源、耗时、公开摘要、候选得分及错误。回放从种子和实际操作重算，可以定位到指定决策前的观察和画面，无需再次请求 Agent。当前没有录制模型的私有思维链。

接口依据：`src/types.ts`、`src/session.ts`、`src/agent.ts`、`src/browser.ts`；生产浏览器验证还会检查面板中显示的观察与当前游戏状态哈希一致。
