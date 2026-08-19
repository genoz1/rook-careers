// Shared Anthropic API client for résumé and job analysis.
//
// Requires ANTHROPIC_API_KEY in the environment (see ROOK-Setup-Guide.pdf
// Section 3). Both callers in this project ask Claude to return ONLY a
// JSON object (no prose, no markdown fences) — enforced via the system
// prompt, with defensive parsing on the response side in case the model
// still wraps the answer in code fences.

const MODEL = "claude-sonnet-5";
const REQUEST_TIMEOUT_MS = 45_000; // fetch() has no default timeout — an
  // API hang here would otherwise freeze the entire sequential ingest
  // loop forever with no error and no further output. This is what
  // actually caused a "the ingest just stopped" symptom the first time
  // this ran at real volume (65 employers, thousands of postings).

async function callClaudeForJSON(systemPrompt, userPrompt, maxTokens = 2500) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
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
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Claude API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

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
    // If the response was cut off mid-string, it almost always means
    // max_tokens was too low for how verbose this particular answer
    // turned out to be — call this out explicitly rather than just
    // reporting the generic parse error, since it's the most common
    // real cause and the fix (raise maxTokens) is different from a
    // genuine malformed-response bug.
    const looksTruncated = data.stop_reason === "max_tokens";
    const hint = looksTruncated
      ? ` (response was cut off — stop_reason was "max_tokens"; the ${maxTokens}-token limit was too low for this response)`
      : "";
    throw new Error(`Could not parse Claude's response as JSON${hint}: ${err.message}. Raw response: ${rawText.slice(0, 300)}`);
  }
}

module.exports = { callClaudeForJSON, MODEL };
