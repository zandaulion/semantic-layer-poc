import { config } from './config.js';

/**
 * One request to the configured OpenAI-compatible server. Shared by both
 * answer modes, so a provider error, a rejected key or a reply cut off at the
 * token limit is reported the same way whichever of them asked.
 *
 * `body` is the request without the configured extras; MODEL_EXTRA_BODY is
 * merged over it here, and a null there removes a field the app sends by
 * default (Claude Sonnet 5 takes no temperature).
 */
export async function chatCompletion(body, { signal } = {}) {
  const merged = { ...body, ...config.modelExtraBody };
  for (const [field, value] of Object.entries(config.modelExtraBody)) if (value === null) delete merged[field];
  const requestBody = JSON.stringify(merged);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${config.modelBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.modelApiKey}`, 'content-type': 'application/json' },
      body: requestBody,
      signal,
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const code = failure.error?.code || failure.error?.type || 'unknown';
      const reason = String(failure.error?.message || failure.message || 'request failed').slice(0, 300);
      if (response.status === 400 && attempt === 0) continue;
      const error = new Error(`Model API returned ${response.status} (${code}): ${reason}`);
      error.publicCode = 'model_provider_error';
      error.publicMessage = response.status === 429
        ? 'The model rate limit was reached. Wait a moment and try again.'
        : response.status === 401 || response.status === 403
          ? 'The hosted model key was rejected. Check the key on the server.'
          : 'The hosted model could not produce a draft for this request. Try a more specific question.';
      throw error;
    }
    const payload = await response.json();
    // A reply that hit the token limit is cut off mid-object and will not
    // parse. Say so, rather than letting it read as a server that ignored
    // the schema: under load, SGLang's default JSON grammar let the model
    // pad a finished answer with whitespace until it ran out of tokens.
    if (payload.choices?.[0]?.finish_reason === 'length') {
      const error = new Error('Model response was cut off at the token limit');
      error.publicCode = 'model_truncated';
      // What filled the budget, for evaluation: reasoning that never ended,
      // an answer padded with whitespace, or an answer that was simply long.
      // Lengths and the last few characters only, never the whole reply.
      const message = payload.choices[0].message ?? {};
      const reasoning = String(message.reasoning_content ?? message.reasoning ?? '');
      const content = String(message.content ?? '');
      error.detail = {
        completion_tokens: payload.usage?.completion_tokens ?? null,
        reasoning_chars: reasoning.length,
        content_chars: content.length,
        content_whitespace_chars: content.length - content.trimEnd().length,
        content_tail: content.trimEnd().slice(-120),
        content_head: content.slice(0, 120),
      };
      error.publicMessage = 'The model ran out of room before finishing the draft. Try again, or ask a narrower question.';
      throw error;
    }
    return payload;
  }
}
