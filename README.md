# S2 Live Studio

Vidu S2-Avatar 组件版数字人直播工作台：**S2 Avatar + 腾讯 TRTC + DeepSeek / MiniMax / Soul**，支持 16:9 直播画布、9:16 数字人画面、底部单行弹幕、动作库、礼物事件、永久记忆、拉丁舞双模式与 Motion Sync。

> 这是单机工作台，默认只监听 `127.0.0.1`。不要直接暴露到公网；需要远程访问时请放在 Nginx/Caddy 后并加 Basic Auth / HTTPS。

## 功能

- 16:9 直播画布，中间 9:16 实时数字人
- 底部单行滚动弹幕，不再占用大块对话面板
- S2 动作库 + type 9 动作匹配，支持“小动作 + 归位”
- 拉丁舞双模式：
  - 实时动作序列：6 段 × 2s，type 9 下发
  - Motion Sync：公开视频链接 / 本地上传视频，`image2dance` 生成 12s MV
- 礼物事件：金额档位 → 动作组 + 礼物特效
- 永久记忆：常驻嘉宾、偏好、话题；每轮摘要回写
- 人设组合策略：教育 / 娱乐 / 带货 / 电台 / 生活
- MiniMax 拟声标签、Soul 口语填充词、自然停顿与动作冷却
- S2 Editing：实时换装 / 换背景 / 风格迁移 / 主体替换

## 环境

- Node.js >= 22
- 现代 Chrome / Edge
- 一个可用的 Vidu API Key、RTC 账号（默认 TRTC）
- MiniMax / Soul / LLM（recaption）密钥按需配置

项目**没有 npm 依赖**，不需要 `npm install`。

## 启动

```bash
cp config.example.json config.json
# 编辑 config.json，填入自己的 Vidu / RTC / LLM / TTS 凭据
node server.js
```

打开：

```text
http://127.0.0.1:8792
```

也可以：

```bash
npm start
```

> `config.json` 包含密钥，已被 `.gitignore` 忽略，不要提交。

## 配置说明

`config.example.json` 是完整字段模板：

- `vidu`：Vidu API Key 与接入域名
- `rtc`：TRTC / ARTC / Agora 凭据
- `llm`：recaption / LLM 接口
- `minimax`：MiniMax TTS
- `soul`：Soul（Loxinity）TTS
- `vlm`：可选的视觉模型
- `singing`：本地音乐目录
- `live`：默认主播人设与形象

首次启动如果相邻存在 `vidu-s1-quickstart/config.json`，会只读继承其 `vidu` 与 `rtc` 配置；独立部署请直接使用 `config.json`。

## 目录

```text
server.js              HTTP / WebSocket / API 服务
lib/                   对话、人设、规则、动作库、TTS、effect、MV
web/                   工作台、中控台、业务链路、播放页面
tests/                 Node 单元测试
NATURALNESS.md         自然度 / 动作机制说明
config.example.json    配置模板
```

## 部署

推荐：

```text
浏览器 → Nginx (HTTPS + Basic Auth) → 127.0.0.1:8792 → S2 Avatar / TRTC
```

`server.js` 默认只绑定 `127.0.0.1`；远程访问请勿直接改成 `0.0.0.0` 裸奔。

systemd 示例：

```ini
[Unit]
Description=S2 Live Studio
After=network.target

[Service]
Type=simple
User=s2live
WorkingDirectory=/opt/s2-live/app
Environment=S2_PORT=8792
Environment=S2_PUBLIC_ORIGIN=https://your-domain.example
Environment=S2_NATURAL_PAUSE=1
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## 注意

- S2 / TTS / LLM / 模板生成都会产生真实费用；先在试听/演练模式验证。
- 动作库需要绑定自己的 `library_id`；不同账号不能复用同一个库。
- 动作“已发送”不等于动作语义完成，仍需看画面验收。
- 竖屏编舞要求全身图；半身图请用 Motion Sync，或只用上半身手势。
- 本项目不包含任何真实密钥、用户上传图片或个人配置。

## 相关文档

- [自然度与动作机制](NATURALNESS.md)
- [Vidu S2 文档](https://platform.vidu.cn/vidu-stream/doc)
