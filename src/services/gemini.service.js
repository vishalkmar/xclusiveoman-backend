const sharp = require('sharp');

const { env } = require('../config/env.js');

// Shared Google Gemini (free tier) client for the visa checks — photo
// verification (visaPhotoCheck.service.js) and passport reading
// (passportScan.service.js). Returns { ran: true, result } with the parsed
// JSON, or { ran: false, reason } when there's no key or the call fails, so
// callers can fall back to manual review instead of erroring.

function isGeminiConfigured() {
  return !!env.gemini.apiKey;
}

module.exports.isGeminiConfigured = isGeminiConfigured;
function isAiConfigured() {
  return isGeminiConfigured() || !!env.groq.apiKey;
}
module.exports.isAiConfigured = isAiConfigured;

// Upright JPEG, longest side capped — enough detail for faces and for the
// small MRZ/printed text on passport pages, without huge request bodies.
async function toGeminiImagePart(buffer, maxSide = 1600) {
  const jpeg = await sharp(buffer)
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  return { inline_data: { mime_type: 'image/jpeg', data: jpeg.toString('base64') } };
}

module.exports.toGeminiImagePart = toGeminiImagePart;

async function generateJson({ parts, schema, timeoutMs = 30000, logTag = 'gemini' }) {
  if (!isAiConfigured()) return { ran: false, reason: 'AI verification is not configured (GEMINI_API_KEY or GROQ_API_KEY).' };
  let groqFailure = null;

  // Groq is the primary provider.
  if (env.groq.apiKey) {
    try {
      console.log(`[${logTag}] Groq request started`, { model: env.groq.model });
      const groqParts = parts.map((part) => part.inline_data
        ? { type: 'image_url', image_url: { url: `data:${part.inline_data.mime_type};base64,${part.inline_data.data}` } }
        : { type: 'text', text: part.text || '' });
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.groq.apiKey}` },
        body: JSON.stringify({ model: env.groq.model, messages: [{ role: 'user', content: groqParts }], temperature: 0, response_format: { type: 'json_object' } }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 30000)),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        console.error(`[${logTag}] Groq error`, res.status, data?.error?.message);
        groqFailure = 'Groq is temporarily unavailable.';
      } else {
        const result = JSON.parse(data?.choices?.[0]?.message?.content || '');
        console.log(`[${logTag}] Groq verification succeeded`, { model: env.groq.model });
        return { ran: true, result, model: env.groq.model, provider: 'groq' };
      }
    } catch (err) {
      console.error(`[${logTag}] Groq request failed`, err.message);
      groqFailure = 'Groq is temporarily unavailable.';
    }
  } else {
    console.warn(`[${logTag}] Groq primary skipped: GROQ_API_KEY is not configured`);
  }

  // Gemini is the fallback provider.
  if (!env.gemini.apiKey) return { ran: false, reason: `${groqFailure || 'AI verification failed'} No GEMINI_API_KEY is configured.` };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.gemini.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.gemini.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`[${logTag}] Gemini error`, res.status, data?.error?.message);
      console.warn(`[${logTag}] Gemini fallback returned an error`);
    } else {
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      return { ran: true, result: JSON.parse(text), model: env.gemini.model, provider: 'gemini' };
    }
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted/i.test(err?.message || '');
    console.error(`[${logTag}] Gemini request failed`, timedOut ? `timeout after ${timeoutMs}ms` : err.message);
    console.error(`[${logTag}] Gemini fallback failed`, timedOut ? `timeout after ${timeoutMs}ms` : err.message);
  }
  return { ran: false, reason: 'Groq and Gemini AI verification are temporarily unavailable.' };
}

module.exports.generateJson = generateJson;
