// models.js
// Optional model hooks: LLM or TF.js fallback for intent enhancement

export async function classifyWithLLM(text) {
  // Placeholder: Use OpenAI, local LLM, or TF.js if enabled
  const fakeModelResponse = {
    intent: "OPEN_GRADES",
    confidence: 0.87,
    slots: {}
  };
  return fakeModelResponse;
}

export async function extractEntities(text) {
  const entities = {};
  if (/\b\d{4}\b/.test(text)) {
    entities.course = text.match(/\b\d{4}\b/)[0];
  }
  return entities;
}
