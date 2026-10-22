// The only AI provider the app uses is OpenAI (GPT). Set OPENAI_API_KEY on the server; without it every AI
// feature answers 503 and the app hides the buttons. Optional: OPENAI_MODEL (default gpt-4o-mini) and
// OPENAI_TRANSCRIBE_MODEL (default whisper-1).

const configured = () => !!process.env.OPENAI_API_KEY;
const MODEL = () => process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TRANSCRIBE_MODEL = () => process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

function notConfigured() {
  const err = new Error('AI is not switched on yet. Ask the owner to add the OpenAI key on the server.');
  err.status = 503;
  return err;
}

/** One chat completion that must answer with a JSON object. Returns the parsed object. */
async function chatJSON({ system, user, temperature = 0.2, maxTokens = 1500 }) {
  if (!configured()) throw notConfigured();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL(),
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'The AI could not answer');
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || '{}');
  } catch {
    throw new Error('The AI answered in a form the app could not read');
  }
}

/** Speech to text for one audio file (webm, mp4, m4a, wav ... up to 25 MB). Returns the text. */
async function transcribe(buffer, filename = 'audio.webm', mime = 'audio/webm') {
  if (!configured()) throw notConfigured();
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('model', TRANSCRIBE_MODEL());
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'The recording could not be turned into text');
  return String(data.text || '').trim();
}

module.exports = { configured, chatJSON, transcribe };
