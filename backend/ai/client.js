// Shared Anthropic API client for résumé and job analysis.
//
// Requires ANTHROPIC_API_KEY in the environment (see ROOK-Setup-Guide.pdf
// Section 3). Both callers in this project ask Claude to return ONLY a
// JSON object (no prose, no markdown fences) — enforced via the system
// prompt, with defensive parsing on the response side in case the model
// still wraps the answer in code fences.
//
// NOTE: this has not been tested against the live Anthropic API from the
// environment this was written in — there's no API key available there.
// The request/response shape follows the standard Messages API format;
// treat the first real call as the real test, same caveat as the
// Workday/TalentBrew adapters when they were first built.

const MODEL = "claude-sonnet-5";

async function callClaudeForJSON(systemPrompt, userPrompt, maxTokens = 1500) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Claude API request failed: ${res.status} ${res.statusText} — ${bodyText.slice(0, 300)}`);
  }

  const data = await res.json();
  const rawText = (data.content || []).map((block) => block.text || "").join("");

  // Defensive parsing: strip markdown code fences if the model added them
  // despite the system prompt instructing it not to.
  const cleaned = rawText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Could not parse Claude's response as JSON: ${err.message}. Raw response: ${rawText.slice(0, 300)}`);
  }
}

module.exports = { callClaudeForJSON, MODEL };
