// Hook writer with pluggable providers.
//   free   - no API, always $0 (default fallback)
//   gemini - Google Gemini (free tier key from Google AI Studio)
//   claude - Anthropic Claude (paid)
//   openai - OpenAI (paid)
// Server-wide keys come from env vars. Visitors can also paste their own key per job;
// those keys live only in memory for that one job and are never stored or logged.
const Anthropic = require('@anthropic-ai/sdk').default;
const { betaZodOutputFormat } = require('@anthropic-ai/sdk/helpers/beta/zod');
const { z } = require('zod');

const MODELS = {
  gemini: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  claude: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  openai: process.env.OPENAI_MODEL || 'gpt-6-luna',
};
const LABELS = { free: 'Basic (free)', gemini: 'Gemini', claude: 'Claude', openai: 'OpenAI' };

// which provider the server itself can use without a visitor key
function serverProvider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return 'claude';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'free';
}

const STYLES = {
  hype: 'High energy and hype. Strong verbs, urgency, gamer slang is fine.',
  funny: 'Funny and playful. Lean into the absurd or awkward part of the moment.',
  mystery: 'Curiosity gap. Tease what happens without giving it away.',
  story: 'Story-driven. Set up the situation so viewers want the payoff.',
  informative: 'Clear and informative. Lead with the most useful or surprising fact.',
};

// ---- shared prompt + schema ----
const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clips'],
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'hook', 'caption', 'hashtags', 'virality'],
        properties: {
          n: { type: 'integer' },
          hook: { type: 'string' },
          caption: { type: 'string' },
          hashtags: { type: 'array', items: { type: 'string' } },
          virality: { type: 'integer' },
        },
      },
    },
  },
};
const ZodSchema = z.object({
  clips: z.array(z.object({
    n: z.number().int(), hook: z.string(), caption: z.string(),
    hashtags: z.array(z.string()), virality: z.number().int(),
  })),
});

function buildPrompt({ title, moments, style, instructions }) {
  const system = `You write short-form video packaging for TikTok, Instagram Reels and YouTube Shorts.
For each clip you get its transcript and a replay-based engagement score (0-100).
Return for every clip:
- hook: the on-screen title shown for the whole clip. 3 to 7 words, no emojis, no quotes, never misleading.
- caption: one sentence post caption in a natural creator voice.
- hashtags: 4 to 6 relevant lowercase hashtags including the # sign.
- virality: 0-100 estimate of short-form potential. Weigh the engagement score heavily; adjust for how self-contained and punchy the moment is.
Tone: ${STYLES[style] || STYLES.hype}
If a transcript is empty, infer from the video title. Write in English.
Return only JSON matching the schema, one entry per clip, keeping each clip's n.`;
  const extra = instructions ? `\n\nCreator instructions (follow these unless they conflict with the rules above):\n<instructions>\n${instructions.slice(0, 1000)}\n</instructions>` : '';
  const user = `Video title: ${title}${extra}\n\n` + moments.map(m =>
    `<clip n="${m.n}" engagement="${m.score}">\n${(m.text || '').slice(0, 3000)}\n</clip>`).join('\n');
  return { system, user };
}

// ---- free heuristic ----
function heuristic({ title, moments }) {
  const tags = [...new Set((title || '').toLowerCase().match(/[a-z0-9]{4,}/g) || [])]
    .filter(w => !['official', 'video', 'with', 'from', 'this', 'that', 'full', 'remaster'].includes(w))
    .slice(0, 3).map(w => '#' + w);
  return moments.map(m => {
    const words = (m.text || '').split(/\s+/).filter(Boolean);
    let hook = words.length >= 4 ? words.slice(0, 6).join(' ').replace(/[.,!?]+$/, '') + '...' : 'Wait for the ending';
    hook = hook.charAt(0).toUpperCase() + hook.slice(1);
    return { n: m.n, hook, caption: `${title || 'This moment'} - clip ${m.n}`, hashtags: [...tags, '#shorts', '#viral'], virality: m.score };
  });
}

// ---- helpers ----
class ProviderError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function postJSON(url, headers, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.AI_TIMEOUT_MS) || 20_000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    if (!r.ok) {
      const msg = json?.error?.message || text.slice(0, 200);
      if (r.status === 401 || r.status === 403) throw new ProviderError('API key was rejected', r.status);
      if (r.status === 429) throw new ProviderError('Rate limit or free quota reached', 429);
      if (r.status >= 500) throw new ProviderError('Service is busy right now', r.status);
      throw new ProviderError(`HTTP ${r.status}: ${msg}`, r.status);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new ProviderError('Request timed out', 504);
    throw e;
  } finally { clearTimeout(t); }
}

// find the {clips:[...]} object anywhere in a response, whether it is returned
// directly, as an output_text string, or nested in steps/outputs content parts
function findClips(node, depth = 0) {
  if (!node || depth > 8) return null;
  if (typeof node === 'string') {
    const s = node.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (!s.startsWith('{')) return null;
    try { return findClips(JSON.parse(s), depth + 1); } catch { return null; }
  }
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) { const f = findClips(node[i], depth + 1); if (f) return f; }
    return null;
  }
  if (typeof node === 'object') {
    if (Array.isArray(node.clips)) return node;
    for (const k of ['output_text', 'outputs', 'output', 'steps', 'content', 'text', 'candidates', 'parts']) {
      if (k in node) { const f = findClips(node[k], depth + 1); if (f) return f; }
    }
  }
  return null;
}

// ---- providers ----
// Free-tier Gemini models get overloaded (503) or hit per-model quotas (429).
// Try the main model, retry once after a short wait, then fall back to a second model.
const GEMINI_FALLBACK = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-lite';
async function callGemini({ system, user }, key) {
  const attempts = [MODELS.gemini, GEMINI_FALLBACK]; // worst case ~2 x timeout
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const json = await postJSON('https://generativelanguage.googleapis.com/v1beta/interactions',
        { 'x-goog-api-key': key, 'Api-Revision': '2026-05-20' },
        {
          model: attempts[i],
          system_instruction: system,
          input: user,
          response_format: { type: 'text', mime_type: 'application/json', schema: JSON_SCHEMA },
        });
      return findClips(json);
    } catch (e) {
      lastErr = e;
      const retryable = e instanceof ProviderError && (e.status === 429 || e.status >= 500);
      if (!retryable) throw e;
      if (i === 0) await sleep(1000);
    }
  }
  throw lastErr;
}

async function callOpenAI({ system, user }, key) {
  const json = await postJSON('https://api.openai.com/v1/responses',
    { authorization: `Bearer ${key}` },
    {
      model: MODELS.openai,
      instructions: system,
      input: user,
      text: { format: { type: 'json_schema', name: 'clip_hooks', strict: true, schema: JSON_SCHEMA } },
    });
  const refused = (json.output || []).some(o => (o.content || []).some(c => c.type === 'refusal'));
  if (refused) throw new ProviderError('Request was declined');
  return findClips(json);
}

async function callClaude({ system, user }, key) {
  const client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
  try {
    const res = await client.beta.messages.parse({
      model: MODELS.claude,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(ZodSchema) },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (res.stop_reason === 'refusal') throw new ProviderError('Request was declined');
    return res.parsed_output;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ProviderError('API key was rejected');
    if (e instanceof Anthropic.PermissionDeniedError) throw new ProviderError('API key has no access to this model');
    if (e instanceof Anthropic.RateLimitError) throw new ProviderError('Rate limit reached');
    if (e instanceof Anthropic.APIError) throw new ProviderError(`HTTP ${e.status}: ${e.message}`);
    throw e;
  }
}

const CALLERS = { gemini: callGemini, claude: callClaude, openai: callOpenAI };
const ENV_KEYS = {
  gemini: () => process.env.GEMINI_API_KEY,
  claude: () => process.env.ANTHROPIC_API_KEY || '', // '' lets the SDK use ANTHROPIC_AUTH_TOKEN too
  openai: () => process.env.OPENAI_API_KEY,
};

/**
 * @returns {Promise<{hooks: object[], provider: string, note: string}>}
 * opts.provider/opts.apiKey come from the visitor; otherwise the server's own key (if any) is used.
 */
async function generateHooks({ title, moments, style, instructions, provider, apiKey }) {
  let use = 'free', key = null;
  if (apiKey && CALLERS[provider]) { use = provider; key = apiKey; }
  else {
    const sp = serverProvider();
    if (sp !== 'free') { use = sp; key = ENV_KEYS[sp](); }
  }
  const free = heuristic({ title, moments });
  if (use === 'free') return { hooks: free, provider: 'free', note: '' };

  try {
    const out = await CALLERS[use](buildPrompt({ title, moments, style, instructions }), key);
    if (!out || !Array.isArray(out.clips)) throw new ProviderError('Unexpected response format');
    const byN = new Map(out.clips.map(c => [Number(c.n), c]));
    const hooks = moments.map((m, i) => {
      const c = byN.get(m.n) || out.clips[i];
      if (!c || typeof c.hook !== 'string') return free[i];
      return {
        n: m.n,
        hook: String(c.hook).slice(0, 80),
        caption: String(c.caption || '').slice(0, 300),
        hashtags: (Array.isArray(c.hashtags) ? c.hashtags : []).map(String).slice(0, 8)
          .map(h => (h.startsWith('#') ? h : '#' + h).replace(/\s+/g, '').toLowerCase()),
        virality: Math.max(0, Math.min(99, Math.round(Number(c.virality) || m.score))),
      };
    });
    return { hooks, provider: use, note: '' };
  } catch (e) {
    const why = e instanceof ProviderError ? e.message : 'Provider error';
    console.error(`[ai] ${use} failed: ${why}`); // never log keys
    return { hooks: free, provider: 'free', note: `${LABELS[use]} failed (${why}) - used basic hooks instead.` };
  }
}

async function transcribeAudioClip(audioBuffer, mimeType = 'audio/mp3', apiKey = null) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) return [];
  const base64Audio = audioBuffer.toString('base64');
  const prompt = 'Transcribe the spoken words in this audio with accurate word-level timestamps in milliseconds. Return JSON: {"words": [{"t": "word", "start": 500, "end": 750}]} where start and end are milliseconds from the start of this clip. If there is no clear speech, return {"words": []}.';

  const models = [process.env.GEMINI_AUDIO_MODEL || process.env.GEMINI_MODEL || 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const json = await postJSON(url, {}, {
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Audio } },
            { text: prompt },
          ],
        }],
        generationConfig: { response_mime_type: 'application/json' },
      });
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed?.words)) {
        return parsed.words.filter(w => w.t && typeof w.start === 'number' && typeof w.end === 'number');
      }
    } catch (err) {
      console.warn(`[ai] Audio transcription with ${model} failed:`, err.message);
    }
  }
  return [];
}

async function detectFacecamFromImage(imageBuffer, apiKey = null) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) return 'bottom-left';
  const base64 = imageBuffer.toString('base64');
  const prompt = 'Look at this livestream video frame. Where is the streamer webcam or facecam box located? Return ONLY JSON matching this format: {"position": "bottom-left" | "bottom-right" | "top-left" | "top-right" | "center"}. If not sure or no webcam, return {"position": "bottom-left"}.';
  const models = [process.env.GEMINI_MODEL || 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const json = await postJSON(url, {}, {
        contents: [{
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: base64 } },
            { text: prompt },
          ],
        }],
        generationConfig: { response_mime_type: 'application/json' },
      });
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        const parsed = JSON.parse(text);
        if (['bottom-left', 'bottom-right', 'top-left', 'top-right', 'center'].includes(parsed.position)) {
          return parsed.position;
        }
      }
    } catch (err) {
      console.warn(`[ai] Facecam detection with ${model} failed:`, err.message);
    }
  }
  return 'bottom-left';
}

module.exports = { generateHooks, transcribeAudioClip, detectFacecamFromImage, serverProvider, MODELS, LABELS, STYLES, findClips, heuristic };
