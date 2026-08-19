// OpenAI embeddings client — used ONLY for generating vector embeddings
// for semantic similarity matching (backend/matching.js). Text
// extraction/analysis (résumé and job parsing) still goes through
// Claude (backend/ai/client.js) — this is a narrow, second AI vendor
// added specifically because Anthropic doesn't offer a public
// embeddings endpoint.
//
// Requires OPENAI_API_KEY in the environment.
//
// NOTE: like the Claude client, this has not been tested against the
// live OpenAI API from the environment this was written in — no API key
// available there. The request/response shape follows OpenAI's
// documented embeddings API format; treat the first real call as the
// real test.

const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dimensions — matches the schema's vector(1536) columns

/**
 * Generate a vector embedding for a piece of text.
 * @param {string} text
 * @returns {Promise<number[]>} a 1536-dimension embedding vector
 */
async function generateEmbedding(text) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  if (!text || text.trim().length === 0) {
    throw new Error("Cannot generate an embedding for empty text");
  }

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text.slice(0, 30000), // stay comfortably within the model's token limit
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings request failed: ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`);
  }

  const data = await res.json();
  const embedding = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("OpenAI response did not include a valid embedding array");
  }
  return embedding;
}

module.exports = { generateEmbedding, EMBEDDING_MODEL };
