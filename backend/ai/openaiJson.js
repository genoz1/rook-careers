// Same Responses API, fetch transport and production key as ROOK's existing
// OpenAI features. Kept separate from stable social/ingestion feature clients.
const MODEL = 'gpt-4o-mini';
function validateSchema(value, schema, path = 'result') {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (![schema.type].flat().includes(type)) throw Error(`Invalid structured output at ${path}`);
  if (type === 'object') {
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key)) || schema.required.some(key => !Object.hasOwn(value, key))) throw Error(`Invalid structured fields at ${path}`);
    for (const [key, child] of Object.entries(schema.properties)) validateSchema(value[key], child, `${path}.${key}`);
  }
  if (type === 'array') value.forEach((item, i) => validateSchema(item, schema.items, `${path}[${i}]`));
  if (type === 'number' && (!Number.isFinite(value) || (schema.minimum != null && value < schema.minimum))) throw Error(`Invalid number at ${path}`);
}
async function callOpenAIForJSON(systemPrompt, userPrompt, maxTokens = 6000, { schema, name = 'structured_result', fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  if (!process.env.OPENAI_API_KEY) throw Error('OPENAI_API_KEY is not configured');
  if (!schema) throw Error('Structured output schema required');
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, store: false, temperature: 0, max_output_tokens: maxTokens,
          instructions: systemPrompt, input: userPrompt,
          text: { format: { type: 'json_schema', name, strict: true, schema } } }),
      });
      if (!response.ok) {
        const error = Error(`OpenAI analysis HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const data = await response.json();
      if (data.status !== 'completed') throw Error('OpenAI analysis incomplete');
      const content = (data.output || []).flatMap(item => item.content || []);
      if (content.some(item => item.type === 'refusal')) throw Error('OpenAI could not analyze this résumé');
      const text = content.filter(item => item.type === 'output_text').map(item => item.text).join('');
      let result;
      try { result = JSON.parse(text); } catch (_) { throw Error('Malformed OpenAI structured output'); }
      validateSchema(result, schema);
      return result;
    } catch (error) {
      const retryable = error.retryable || error.name === 'AbortError' || error instanceof TypeError;
      if (attempt || !retryable) throw Error(error.name === 'AbortError' ? 'OpenAI analysis timed out; please retry' : error.message);
    } finally { clearTimeout(timer); }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
module.exports = { callOpenAIForJSON, validateSchema, MODEL };
