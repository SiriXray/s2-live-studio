# S2 数字人组件版：参数配置、选型与社交直播自然度

> 基于 Vidu S2-Avatar 组件版协议、本项目当前实现，以及社交直播的工程实践整理。  
> 官方参数以 [Vidu Live 组件版文档](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/component/introduction) 为准；不同账号/版本字段可能略有差异，接入前先用测试会话验证。

---

## 1. 先选型：组件版 vs 实时版 vs 离线版

| 维度 | 组件版 `component` | 实时版 `realtime` | 离线版 `offline` |
|---|---|---|---|
| 平台负责 | 数字人渲染 + 推流到你的 RTC | 渲染 + ASR + LLM + TTS + VAD + 动作 + 记忆 | 图片 + 音频/文本 → 视频文件 |
| 你负责 | ASR、LLM、TTS、VAD、RTC、动作编排、记忆 | 形象/人设/音色，少量编排 | 素材、任务轮询/回调 |
| 控制力 | **最高** | 中 | 低（异步） |
| 上线速度 | 慢 | **快** | 中 |
| 自然度上限 | **高**（可自定义 TTS/停顿/语气词/动作） | 中（受平台语音与策略约束） | 不适用实时互动 |
| 实时互动 | 是 | 是 | 否 |
| 适合 | 社交直播、品牌自有中控、已有 RTC/LLM/TTS 的团队 | MVP、快速验证、轻运营 | MV、短视频、预录节目 |

### 结论

- **做“社交直播自然度”优先组件版**：你能控制 TTS、语气词、停顿、动作、打断、记忆；平台只负责“像人一样动”。
- **赶上线/没有语音团队用实时版**：VAD、LLM、TTS、记忆、知识库都内置，但自然度调参空间小。
- **离线版只做内容资产**：MV、切片、预录，不承担实时互动。

---

## 2. 组件版创建参数

### 2.1 创建会话

`POST /live/s_avatar/component`

```json
{
  "model": "vidu-s2",
  "image_uri": "https://example.com/avatar.jpg",
  "rtc_info": {
    "provider": "trtc",
    "app_id": "your-rtc-app-id",
    "channel_id": "your-channel-id",
    "user_id": "push-user-id",
    "token": "your-rtc-token"
  }
}
```

| 字段 | 必填 | 建议/说明 |
|---|---|---|
| `model` | 否 | 固定 `vidu-s2`；传其他值 400 |
| `image_uri` | 二选一 | 单人图，PNG/JPG/JPEG/WEBP，≤50MB；支持 URL / base64 / 上传 ID |
| `avatar_id` | 二选一 | 平台图片上传 ID；与 `image_uri` 二选一 |
| `rtc_info.provider` | 是 | `trtc` / `artc` / `agora` / `volcengine` |
| `rtc_info.app_id` | 视 provider | ARTC 可省略；TRTC 必填 |
| `rtc_info.channel_id` | 视 provider | token 已包含时可省略 |
| `rtc_info.user_id` | 视 provider | 推流用户 ID |
| `rtc_info.token` | 是 | RTC 鉴权 token；有效期按 RTC 配置 |

> 本项目的 `server.js` 历史代码使用 `customer_rtc` 字段，平台当前可兼容；新接入建议按官方 `rtc_info` 写，避免版本差异。

### 2.2 组件版没有平台 LLM / VAD / TTS

官方组件版创建参数支持 **形象 + RTC + resolution + persona + action + action_prompt**，但以下能力仍需你自己实现：

- ASR / VAD / endpointing
- LLM 台词
- TTS（MiniMax / Soul / 其他）
- 记忆 / 知识库
- 打断与 turn-taking

这意味着：

- `persona` 是组件版的表演/动作人设字段，**不是平台 LLM**；台词仍要写进你自己的 system prompt。
- `action.enabled` / `action.library_id` 是官方字段；动作仍靠 **type 9 `input_transcription`** 的文本匹配。
- `action_prompt` 只描述动作/节奏/气质，不要写“长什么样/穿什么”，形象与 persona 独立。
- 不要指望组件版帮你做“服务端 VAD/LLM/记忆”；这些是实时版的能力。

### 2.3 形象图建议

社交直播的“自然感”从图开始：

- **9:16 竖屏**，1080×1920 优先；至少 720×1280。
- 单人、正脸清晰、无遮挡、无多人。
- 表情中性、嘴部自然闭合；不要大笑/张嘴，否则口型容易怪。
- 半身：胸口以上，保留肩颈和手部活动空间。
- 全身：脚在画面内，适合舞蹈/走位；但实时动作库对脚部控制弱。
- 光位稳定、背景干净；不要强逆光、重滤镜、过度磨皮。
- 服装与场景匹配：社交直播不要“卖场西装”配“卧室背景”。

---

## 3. WebSocket 与音频参数

### 3.1 连接

```text
wss://{host}/live/v1/external-lives/{live_id}/stream?conn_id={conn_id}&client_secret={client_secret}
```

- 首帧必须是 `conn_init`（type=1，version=1）。
- 收到 `conn_init_ack.success=true` 后才开始计费，也才允许发 PCM。
- `NOT_READY`：等 2–3 秒重发 `conn_init`，**不要重连**、不要重建会话。
- `LIVE_ENDED`：会话已结束，需要重新创建。
- 心跳：服务端约 5 秒 ping，约 15 秒无 pong 断开；客户端要回 pong。
- 断线重连：同一 `live_id` + 同一 `conn_id`，重连后重发 `conn_init`。

### 3.2 PCM

| 参数 | 值 |
|---|---|
| 编码 | PCM 16-bit signed little-endian（s16le） |
| 采样率 | 24000 Hz |
| 声道 | 单声道 |
| 码率 | 48 字节/毫秒 |
| 推荐帧长 | 20ms（960B）或 100ms（4800B） |
| 单帧上限 | 16MiB |

**20ms vs 100ms 的取舍：**

- 20ms：更平滑、更适合频繁打断、口型更细；HTTP/WS 开销更大。
- 100ms：更稳、抗抖动；但打断粒度粗、容易出现“多播了半秒”。
- 社交直播建议：网络稳定用 20ms；弱网/移动端用 100ms；不要混用不同帧长。

### 3.3 信令类型

| type | 方向 | 用途 |
|---|---|---|
| 1 / 2 | C→S / S→C | `conn_init` / `conn_init_ack` |
| 5 | C→S | `call_hangup` |
| 6 | S→C | `force_hangup`（超时/风控/余额） |
| 7 | C→S | `audio_interrupted`，打断当前播报 |
| 9 | C→S | `input_transcription`：动作文本 / 你的 ASR 文本 |
| 10 | C→S | `output_transcription`：你的 LLM 回复文本（字幕/口型辅助） |

> 组件版**没有** type 99/100/101/102；这些是实时版/封装层。当前项目里保留的 99/100/101/102 只适用于实时版，不要误发到组件版。

### 3.4 动作文本

组件版动作靠 type 9 文本匹配：

```json
{ "type": 9, "payload": { "text_msg": { "msg_id": "a1", "content": "请做轻轻点头", "timestamp": 1710000000000 } } }
```

建议：

- 统一格式：`请做{动作名}`。
- 动作名 ≤ 20 字符；不要带标点/emoji/多动作长句。
- 动作描述里写“起势 → 保持 → 回落/归位”。
- 动作先于 PCM 发送；不要等一句话说完再补动作。
- 没有逐动作成功回执；以画面为准。
- 动作库按账号隔离；`library_id` 不能跨账号复用。

---

## 4. 社交直播自然度：参数与编排建议

### 4.1 目标指标（建议值）

| 指标 | 建议 | 说明 |
|---|---|---|
| 首句响应 | < 1.2s | 冷启动用模板/缓存，不等 LLM |
| ASR endpoint | 300–600ms | 组件版自己控制；太短截断，太长迟钝 |
| 打断延迟 | 200–300ms | 用户开口 → type 7 → 停 PCM |
| 句间停顿 | 150–300ms | TTS 句末 + 播放间隔 |
| 段落停顿 | 0.5–1s / 3–5 句 | 让观众插话 |
| 语气词 | 0.5–1 个/轮 | “嗯/其实/说实话”，不要每句 |
| 动作 | 1 个/2–3 句 | 讲完收势，不连续比划 |
| 注视镜头 | 60–80% | 其余看弹幕/侧下方，像真人 |
| 单段独白 | ≤ 20–30s | 超过要提问/停顿/看弹幕 |
| 记忆召回 | 1 次/3–5 轮 | 常驻观众名字/上次话题 |

### 4.2 会话状态机

```text
idle → listening → thinking → speaking → listening
                    ↓
              backchannel / fillers
```

- **listening**：ASR + VAD；检测到用户开口，type 7 打断。
- **thinking**：先出“嗯/我想一下”填充，避免静默；LLM 超时要有兜底。
- **speaking**：TTS 分句发送；type 10 文本与 PCM 对齐；动作先发。
- **backchannel**：用户说话时用“嗯/对/我在听”短音频，不抢话。
- **idle**：20–30 秒无输入，抛一个轻话题或小动作；不要每 5 秒自动说话。

### 4.3 社交直播的内容节奏

社交直播不是带货，也不是客服。自然感来自“像一个人待在直播间”：

1. **欢迎新观众**：读名字 + 一句具体观察，不要只“欢迎”。
2. **接住弹幕**：复述关键词 → 回应 → 反问一个具体问题。
3. **分享/故事**：一段 20–30 秒，讲人，不讲参数。
4. **礼物感谢**：轻礼物一句带过；重礼物给专属回应，不每礼必尖叫。
5. **冷场**：小动作/看弹幕/抛话题；不要连续追问。
6. **结束**：明确告别，不突然消失。

### 4.4 让 TTS 更像人

- **分句合成**：一句一合成，句间留 150–300ms；不要整段 1000 字一次合成。
- **预取下一句**：当前句播放时生成下一句，隐藏 TTS 延迟。
- **语气词**：每轮 0.5–1 个；MiniMax 用 `(laughs)/(sighs)/(emm)`；Soul 转成“哈哈/唉/嗯”。
- **语速**：社交 0.95–1.05；带货 1.05–1.15；教育 0.95–1.0。
- **重音**：关键词放慢/加重，不要全程一个调。
- **停顿**：标点停顿 + 手动 100–300ms 静音；不要用长静音填时间。
- **避免**：每句“家人们”、每句“哈哈哈”、机械升调、把“。”读成重音。

### 4.5 动作自然度

- 一个段落一个动作组；不要每句换动作。
- 动作库描述写“缓慢起势 → 保持 1–2 秒 → 沿原路径回落”。
- 讲细节：凑近/前倾；讲适合谁：摊手；讲重点：点头；思考：手点下巴。
- 动作冷却 3–5 秒；同一动作不要连续两次。
- 半身图只用手臂/肩颈/头部动作；脚部动作要用全身图。
- 动作发出后不要立刻发下一个；留出回落时间。

### 4.6 记忆与关系感

- 只记 3–5 个高价值事实：名字、城市、职业/考试、偏好、上次话题。
- 召回要自然：“上次你说在准备考试，今天进度怎么样？”
- 不要每轮都提记忆；3–5 轮一次。
- 观众不想被记住时，给“可以不记”的边界。
- 记忆按 `user_id` 隔离；不要跨用户串。

### 4.7 社交直播的“不要”

- 不要每句都追问，像查户口。
- 不要用“最后一天/全网最低”做社交直播。
- 不要假装有画面/能看见观众；没有视觉就说“我看不到你的画面”。
- 不要过度承诺、编造经历、假装真人。
- 不要用高频重复的“哈哈哈”掩盖冷场。
- 不要在用户说话时继续播 PCM；先 type 7。

---

## 5. 推荐配置（社交直播）

```text
模型：vidu-s2
形象：9:16，1080×1920，单人半身，中性表情
RTC：TRTC（已有生态优先）
PCM：24kHz / mono / s16le
帧长：20ms（稳定网络）或 100ms（弱网）
信令：conn_init → ack → type 9 动作 / type 10 文本 / PCM → type 7 打断
首句：模板/缓存，<1.2s
TTS：分句 + 预取下一句；社交 0.95–1.05
动作：1 个/2–3 句，先发动作再发 PCM
停顿：句间 150–300ms；每 3–5 句 0.5–1s
记忆：3–5 个事实，3–5 轮召回一次
冷场：20–30s 一次轻话题/小动作
```

### 组件版 vs 实时版最终建议

- **有自研 LLM/TTS/ASR、要做品牌社交直播、需要精细自然度** → 组件版。
- **没有语音团队、要 1–2 周上线、能接受平台音色/策略** → 实时版。
- **要 MV/切片/预录** → 离线版。
- **不要用组件版省掉 VAD/打断**：省掉的复杂度会以“抢话/延迟/冷场”的形式回到直播间。

---

## 6. 参考

- [Vidu Live 组件版整体介绍](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/component/introduction)
- [Vidu Live 组件版详细参数](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/component/parameters)
- [Vidu Live 实时版详细参数](https://platform.vidu.cn/vidu-stream/doc/s2-avatar/realtime/parameters)
- [Vidu S 数字人与实时视频编辑 API 文档（协议镜像）](http://docs.apiverse.ai/docs/vidu-s-live/)
- [自然度与动作机制](NATURALNESS.md)
- [教育 / 带货直播自然度 Playbook](live-playbook.md)
