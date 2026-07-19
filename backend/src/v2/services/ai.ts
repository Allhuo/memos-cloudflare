// AIService — 语音转写(规格书 §2.9 Transcribe)。
// 显式注册为 "required" 以便未来实现;当前直接返回 unimplemented。
// 实现依赖 instance setting `AI`(aiSetting.providers + transcription.providerId/model),
// 需把音频转发到配置的 OpenAI(/audio/transcriptions, whisper-1)或 Gemini。
// TODO: 读取 system_setting AI 配置后转发音频,返回 { text }。

import { unimplemented } from "../connect";
import { rpc } from "../router";

rpc("AIService", "Transcribe", "required", async (_request, _ctx) => {
  throw unimplemented("Transcribe");
});
