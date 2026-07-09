// netlify/functions/evaluate.js
//
// Proxies a request to the real Anthropic API. Used ONLY by the separate,
// optional "Scan public signals" feature (scanPublicSignals() in
// valuex-workstation.html) now — a small, reviewer-triggered call with its
// own web_search tool.
//
// The MAIN VALUEX evaluation no longer goes through this synchronous
// endpoint; it uses evaluate-start.js + evaluate-run-background.js +
// evaluate-status.js instead, because a full scored-JSON response routinely
// takes longer to generate than Netlify's synchronous function ceiling
// (10-30s) regardless of prompt/payload size. See evaluate-start.js for
// the full explanation of that architecture.
//
// Why this file exists: the workstation never talks to api.anthropic.com
// directly from the browser — that would mean shipping the API key in
// client-side JS, which anyone could read from devtools. Instead the
// browser POSTs the fully-built request body (model, system prompt,
// messages, tools) to THIS function, which holds the real key as a server-
// side secret env var and forwards the call.
//
// If this file is missing, or the ANTHROPIC_API_KEY env var isn't set on the
// Netlify site, calls to /.netlify/functions/evaluate fail with a clear
// error (no more silent demo-mode fallback for this scan either).
//
// One-time setup on Netlify:
//   1. Netlify site -> Site configuration -> Environment variables
//   2. Add ANTHROPIC_API_KEY = sk-ant-... (from console.anthropic.com)
//   3. Redeploy (env var changes need a new deploy to take effect)
//   4. Confirm this file is committed at netlify/functions/evaluate.js and
//      deployed via Netlify's build system (Git-connected deploy or
//      `netlify deploy`) — a bare drag-and-drop of static files skips
//      `npm install` and this function (and projects.js) won't run.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Safety net: the client should send a current model id, but if it ever
// sends a retired/stale one (this happened before — the client was pinned to
// a year-old dated snapshot that had likely aged out), fall back to a known-
// current default rather than hard-failing the whole evaluation.
const DEFAULT_MODEL = 'claude-sonnet-5';

// The JSON schema the workstation asks for (17 scored criteria + notes +
// strengths/weaknesses/contradictions/missing/publicSignalImpact) needs some
// headroom, but the client now sends a deliberately tight max_tokens (2800)
// to keep generation time — the dominant cost once web_search was removed —
// under Netlify's function timeout. This floor is just a safety net against
// a pathologically low value truncating the JSON mid-object; it must stay
// at or below what the client sends, or it would silently undo that fix.
const MIN_MAX_TOKENS = 2000;

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('evaluate: ANTHROPIC_API_KEY is not set in this Netlify site\'s environment variables.');
    return new Response(JSON.stringify({
      error: 'Server is not configured with an Anthropic API key. Set ANTHROPIC_API_KEY in Netlify site environment variables and redeploy.',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const payload = {
    model: body.model || DEFAULT_MODEL,
    max_tokens: Math.max(body.max_tokens || 0, MIN_MAX_TOKENS),
    // Same fix as evaluate-run-background.js: Claude Sonnet 5 defaults to
    // adaptive thinking ON when this field is omitted, and thinking tokens
    // count against max_tokens — with this scan's tight 1200-token budget,
    // an unset 'thinking' field risks the exact same "all budget spent
    // thinking, no text produced" failure the main evaluation hit.
    thinking: { type: 'disabled' },
    system: body.system,
    messages: body.messages,
  };
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools;
  }

  let anthropicResp;
  try {
    anthropicResp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Network-level failure reaching Anthropic (rare, but distinct from a
    // 4xx/5xx response — surface it clearly instead of a generic 500).
    console.error('evaluate: fetch to Anthropic failed:', err);
    return new Response(JSON.stringify({ error: 'Could not reach the Anthropic API: ' + (err && err.message) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const text = await anthropicResp.text();

  if (!anthropicResp.ok) {
    // Pass the real status and body straight through — this is what shows
    // up as "API 400: ..." / "API 401: ..." etc. in the client's catch
    // block and console.warn, which is exactly what's needed to diagnose a
    // bad key, a retired model id, or a malformed request at a glance.
    console.error('evaluate: Anthropic returned', anthropicResp.status, text.slice(0, 500));
  }

  // Relay Anthropic's response (success or error) verbatim, same shape the
  // client already expects from data.content[].text.
  return new Response(text, {
    status: anthropicResp.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
};
