// lib/tiny_llm.js
import { CreateMLCEngine } from "@mlc-ai/web-llm";

let enginePromise = null;

const DEFAULT_MODEL = "Llama-3.2-3B-Instruct-q4f32_1-MLC";

function buildRewritePrompt(text) {
  return `Rewrite the following assistant message to be short, friendly, and voice-first for a blind user.
Rules:
- Keep it under 1 sentence if possible.
- Remove UI noise, dates, repeated labels, points/percentages unless essential.
- Don’t sound like a screen reader.
Message:
${text}`;
}

function buildSummaryPrompt(text) {
  return `Summarize the following Canvas page content for a blind user.
Rules:
- 3–6 bullets max.
- Keep only actionable items (titles, due dates ONLY if present and important).
- Remove boilerplate like "not available until" unless user asked.
Content:
${text}`;
}

async function getEngine(model = DEFAULT_MODEL, onProgress) {
  if (!enginePromise) {
    enginePromise = CreateMLCEngine(model, {
      initProgressCallback: (report) => {
        try {
          onProgress?.(report);
        } catch {}
      },
    });
  }
  return enginePromise;
}

async function runOneShot(engine, userContent) {
  // WebLLM is OpenAI-API compatible in-browser :contentReference[oaicite:4]{index=4}
  const res = await engine.chat.completions.create({
    model: engine.model, // engine holds model id
    messages: [{ role: "user", content: userContent }],
    temperature: 0.2,
    stream: false,
  });

  const out = res?.choices?.[0]?.message?.content?.trim();
  return out || "";
}

export async function llmRewriteForSpeech(text, { model, onProgress } = {}) {
  const t = String(text || "").trim();
  if (!t) return t;
  const engine = await getEngine(model, onProgress);
  const out = await runOneShot(engine, buildRewritePrompt(t));
  return out || t;
}

export async function llmSummarizeForSpeech(text, { model, onProgress } = {}) {
  const t = String(text || "").trim();
  if (!t) return t;
  const engine = await getEngine(model, onProgress);
  const out = await runOneShot(engine, buildSummaryPrompt(t));
  return out || t;
}
