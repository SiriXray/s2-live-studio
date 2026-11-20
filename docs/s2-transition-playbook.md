# S2 组件版：转场动画、唱跳自然度参数手册

> 参数来源：[Vidu Live 组件版详细参数](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/component/parameters)（2026-11 版本）。  
> 结论先行：**“转场动画”不是 CSS，也不是前端遮罩，而是 `switch_avatar`（type=16）的 `switch_videos`**：先播一组视频，再切换资产形象。用它把“换人/换装/唱跳起落”的黑屏帧盖住。

---

## 1. 关键信令

### 1.1 `switch_avatar`（type=16）

```json
{
  "type": 16,
  "live_id": "1234567890",
  "conn_id": "<conn_id>",
  "seq_id": 7,
  "payload": {
    "switch_avatar": {
      "switch_videos": [
        "https://example.com/transition_1.mp4",
        "https://example.com/transition_2.mp4"
      ],
      "avatar_id": "100012345",
      "switch_on_ready": true
    }
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `switch_videos` | 是 | 1–10 个 `http(s)` 地址；单个 ≤30 分钟，累计 ≤60 分钟；按列表顺序播放，至少完整播放一轮 |
| `avatar_id` | 是 | **资产库形象 ID**（字符串），不是临时 `image_uri`；需要先注册资产 |
| `switch_on_ready` | 否 | 默认 `false`：等前序视频播完；`true`：数字人准备好后立刻切。短转场建议 `true` |

**成功/进度不靠“没回执”判断**：新协议用 type=104 下发 `preparing → running → finished`，共用同一 `seq_id`。  
- 进度帧只含 `source` / `status`；不要把它当失败。  
- 只看 `status=finished` 的 `success`。  
- 失败另发 type=103（`source=switch_avatar`）。  
- **不要“没回执就重发”**，会重复播放/重复切换。

### 1.2 `baseline_reset`（type=15）

```json
{ "type": 15, "seq_id": 8, "payload": {} }
```

把数字人复位到闭口静息态。适合：

- 唱完/跳完，手还抬着、嘴还张着；
- 转场前清掉上一个动作的残留；
- 从 MV/特效覆盖回到实时画面之前。

同样有 type=104 结果（`source=baseline_reset`）。

### 1.3 会话级参数

| 参数 | 取值 | 建议 |
|---|---|---|
| `resolution` | `720p` / `1080p` / `2k` | 社交直播 720p 稳；带货/大屏 1080p；2k 只在强网用。开播后不可改 |
| `action.enabled` | bool | 开；否则 type 9 动作不匹配 |
| `action.library_id` | string | `"0"` 默认库；自建库按账号 |
| `action_prompt` | string | 动作风格提示；不要写外形，写“动作/节奏/气质” |
| `persona` | string | 人设文本，和形象图**独立**；不要在 persona 里写“穿什么/长什么样” |

---

## 2. 转场视频怎么选

### 2.1 规格

- **1–3 秒**最自然；场景大转场可 3–5 秒，不要超过 8 秒。
- 9:16，与直播同分辨率；24/30fps。
- **首尾不能黑帧**；第一帧和最后一帧尽量接近直播画面。
- 建议无音轨或极轻环境音；声音走 TTS/伴奏，不要让转场视频抢音。
- 运动方向要能接上：  
  - 人物向右走 → 下一段从右侧入；  
  - 挥手/转身 → 下一段从背面或侧面接。
- 不要用硬切、闪白、强频闪；直播场景优先叠化、遮挡、推近、拉远、走位。

### 2.2 用同一 `avatar_id` 做“纯转场”

`switch_avatar` 必须切一个资产形象。  
如果只想盖黑帧、不想换人：**`avatar_id` 填当前形象注册的资产 ID**。  
效果：先播转场视频，再切回同一个形象；视觉上只看到转场，没有黑屏。

### 2.3 用不同 `avatar_id` 做“换人/换装”

- 目标形象先在资产库注册，拿 `avatar_id`；
- `switch_videos` 用 1–2 段转场；
- `switch_on_ready=true` 适合短转场；
- 切换后新形象生效；再切回原形象需要第二次 type=16（不要假设自动回退）。

---

## 3. 唱歌：转场 + 尾音 + 抑制 idle

### 推荐流程

```text
开唱前：
  baseline_reset（type 15）
  → 等 300–600ms
  → switch_avatar（type 16，1–2 段 1–3s 转场，same avatar_id）
  → 开始 TTS/伴奏

唱完：
  等 tail_pad_ms（400–800ms）
  → baseline_reset（type 15）
  → 恢复互动 tick
```

### 参数建议

| 参数 | 建议 | 原因 |
|---|---|---|
| `tail_pad_ms` | 400–800ms | 尾音不被硬切；超过 1s 会像冷场 |
| `ducking` | 0.2–0.5 | 唱歌时压低其他音频/互动音量 |
| `suppress_idle` | true | 唱歌中不要插小动作/闲聊 |
| 转场时长 | 1–2s | 前奏/间奏盖切点；不要每段都转 |
| 转场位置 | 开唱前、间奏、唱完 | 不要在主歌中切 |

### 不要

- 不要在长音中途 `switch_avatar`；
- 不要唱完立刻切形象，先 `baseline_reset`；
- 不要用带强鼓点的转场盖人声。

---

## 4. 跳舞：分段 + 桥接动作 + 转场

### 推荐流程

```text
跳舞前：
  baseline_reset
  → 300–600ms
  → switch_avatar（1 段 1–3s 转场，same avatar_id）
  → 舞蹈序列

舞蹈结束：
  baseline_reset
  → 回实时
```

### 参数建议

| 参数 | 建议 | 原因 |
|---|---|---|
| `dance.segment_seconds` | 1–3s | 动作库匹配粒度；太长匹配不到，太短像抽搐 |
| `bridge_action` | true | 段间用一个自然动作过渡（如“面向镜头微笑”） |
| `bridge_text` | 短语 | 不要用长句，动作名 ≤20 字符 |
| 转场 | 开场 1 段，结束 1 段 | 中间不要每段都切 |
| `switch_on_ready` | true（短转场） | 避免等整轮 |

### 不要

- 不要把 12 秒编舞硬塞成一条 type 9；
- 不要在脚部动作中途切形象；
- 不要用 30 秒转场盖 2 秒动作。

---

## 5. 场景 / 形象切换

- 换场景（背景/服装）：1–3 秒转场，先 `baseline_reset`，再切；
- `switch_on_ready=true`：短转场、目标形象已就绪时更顺；
- 换人设：**只换 persona 文本，不换形象**；换形象：只换 `avatar_id`；
- 不要把“人设”和“形象图”绑定：  
  - persona 写性格/语气/知识/边界；  
  - image/avatar 写外观；  
  - 同一人设可以配多套形象，同一形象可以配多个人设。

---

## 6. 参数怎么调：一张表

| 目标 | 调整 | 注意 |
|---|---|---|
| 转场更顺 | `switch_videos` 1–2 段、1–3s、首尾无黑帧；`hold_ms` 300–600 | 不要超过 3 段 |
| 转场更快 | `switch_on_ready=true`；`hold_ms` 200–300 | 目标形象要已就绪 |
| 转场更稳 | `switch_on_ready=false`；`hold_ms` 500–800 | 会慢一点 |
| 唱歌更自然 | `tail_pad_ms` 400–800；`ducking` 0.2–0.5；`suppress_idle=true` | 不要在长音中切 |
| 跳舞更自然 | `segment_seconds` 1–3；`bridge_action=true` | 一段一个动作 |
| 小动作少而自然 | `idle.interval_s` 8–20；`rest_s` 3–8 | 做完要收势 |
| 清晰度优先 | `resolution=1080p` | 开播后不可改 |
| 稳定优先 | `resolution=720p`；`switch_on_ready=false` | 弱网 |

---

## 7. 当前工作台怎么用

右侧中控台 → **「S2 自然度参数」**：

1. `resolution`：720p / 1080p / 2k；
2. `action.library_id`：0 默认库；
3. `action_prompt`：动作风格，不写外形；
4. `s2Videos`：转场视频 URL，每行一个；
5. `s2Hold`：复位后等待多久再切；
6. `s2Baseline`：转场前先 type=15；
7. `s2Tail` / `s2Ducking` / `s2SuppressIdle`：唱歌；
8. `s2DanceSeg` / `s2Bridge`：跳舞；
9. `s2Idle` / `s2Rest`：小动作；
10. `s2AvatarId` + **注册当前形象**：拿资产 ID；
11. **播放转场**：先 baseline_reset → hold → switch_avatar；
12. **复位静息**：type=15；
13. **保存参数** / **预览 payload**。

`type=104` 的 `preparing/running/finished` 会显示在按钮下方；`finished.success=false` 才是失败。

---

## 8. 一句话建议

**唱跳的黑屏不是“再加一个动画”能解决的，正确顺序是：先复位，再转场，再开始；结束先留尾音，再复位。**  
转场视频只负责“盖住切点”，不要让它承担内容；内容仍然由 TTS、动作库和脚本负责。
