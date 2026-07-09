// netlify/functions/evaluate-run-background.js
//
// Does the actual Anthropic call for a VALUEX evaluation job. This file
// MUST keep the '-background' suffix in its filename — that's what tells
// Netlify to run it as a Background Function: the platform answers the
// triggering request with an immediate 202 and keeps this handler running
// for up to 15 minutes of wall-clock time, discarding whatever this
// function returns. That 15-minute ceiling is what actually solves the
// 504s: a synchronous function (10-30s limit) can time out on Claude's
// generation time alone, no matter how small the request is; a background
// function has no such problem.
//
// Started only by evaluate-start.js (never called directly by the browser).
// Writes status/result to the same Netlify Blobs record evaluate-status.js
// reads from, so the two ends never talk to each other directly.
//
// config.background = true is set below as well, for sites on newer
// Netlify tooling that prefers that over the filename convention — both are
// harmless to specify together, and between the two this function is
// guaranteed to run in background mode regardless of which mechanism this
// site's build actually honors.
//
// THINKING: Claude Sonnet 5 defaults to adaptive thinking ON (effort:
// "high") whenever a request omits the 'thinking' field — this is a
// behavior change from earlier Sonnet models, where omitting it meant no
// thinking. Thinking tokens count against max_tokens like any other output
// token. That's exactly what broke the first version of this file: with no
// 'thinking' field set, Claude spent the entire max_tokens budget thinking
// and stop_reason came back "max_tokens" with a thinking block and no text
// block at all — VALUEX had nothing to parse. Fixed below by explicitly
// setting thinking: { type: "disabled" }, which is the documented way to
// turn it off entirely for this model.

import { getStore } from '@netlify/blobs';

export const config = { background: true };

const JOB_STORE = 'valuex-eval-jobs';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
// Now that this runs as a background job (15-minute ceiling, not the old
// 10-30s synchronous one), there's no more reason to keep max_tokens tight
// for latency's sake. Raised back up for safety headroom on the JSON output
// itself now that thinking is disabled and no longer competes for the budget.
const MIN_MAX_TOKENS = 3000;

export default async (req) => {
  const store = getStore({ name: JOB_STORE, consistency: 'strong' });
  let jobId = null;

  try {
    const body = await req.json();
    jobId = body && body.jobId;
    const reqPayload = (body && body.request) || {};

    if (!jobId) {
      console.error('evaluate-run-background: request missing jobId, nothing to write to.');
      return; // return value is discarded either way; nothing more to do
    }

    await store.setJSON(jobId, { status: 'running', startedAt: new Date().toISOString() });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('evaluate-run-background: ANTHROPIC_API_KEY is not set.');
      await store.setJSON(jobId, {
        status: 'failed',
        error: 'Server is not configured with an Anthropic API key. Set ANTHROPIC_API_KEY in Netlify site environment variables and redeploy.',
        failedAt: new Date().toISOString(),
      });
      return;
    }

    const payload = {
      model: reqPayload.model || DEFAULT_MODEL,
      max_tokens: Math.max(reqPayload.max_tokens || 0, MIN_MAX_TOKENS),
      // Explicitly off. VALUEX needs a plain JSON text response, not a
      // reasoning trace, and leaving this field unset lets Sonnet 5's
      // default adaptive thinking silently eat the whole max_tokens budget
      // (see the file header for the exact failure mode this caused).
      thinking: { type: 'disabled' },
      system: reqPayload.system,
      messages: reqPayload.messages,
    };
    // Main evaluation calls don't send tools, but this stays generic so the
    // same worker could serve a tool-using job in the future without changes.
    if (Array.isArray(reqPayload.tools) && reqPayload.tools.length) {
      payload.tools = reqPayload.tools;
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
    } catch (fetchErr) {
      console.error('evaluate-run-background: fetch to Anthropic failed:', fetchErr);
      await store.setJSON(jobId, {
        status: 'failed',
        error: 'Could not reach the Anthropic API: ' + ((fetchErr && fetchErr.message) || 'unknown error'),
        failedAt: new Date().toISOString(),
      });
      return;
    }

    const text = await anthropicResp.text();

    if (!anthropicResp.ok) {
      console.error('evaluate-run-background: Anthropic returned', anthropicResp.status, text.slice(0, 500));
      await store.setJSON(jobId, {
        status: 'failed',
        error: 'API ' + anthropicResp.status + ': ' + text.slice(0, 300),
        failedAt: new Date().toISOString(),
      });
      return;
    }

    // Parse the response here (rather than leaving it to the client) so a
    // "thinking only, no text" reply can be caught and failed at the source
    // — it must never reach 'completed' with nothing usable in it. Only
    // type:"text" blocks are ever treated as the result; thinking/signature
    // blocks are filtered out and never stored.
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      console.error('evaluate-run-background: could not parse Anthropic response as JSON:', parseErr, text.slice(0, 300));
      await store.setJSON(jobId, {
        status: 'failed',
        error: 'Could not parse the Anthropic response as JSON.',
        failedAt: new Date().toISOString(),
      });
      return;
    }

    const textBlocks = (data.content || []).filter(function (b) { return b && b.type === 'text'; });
    const combinedText = textBlocks.map(function (b) { return b.text || ''; }).join('\n').trim();

    if (!combinedText) {
      const stopReason = data.stop_reason || 'unknown';
      const errorMsg = stopReason === 'max_tokens'
        ? 'Claude exhausted max_tokens before producing JSON.'
        : 'Claude returned no text content (stop_reason: ' + stopReason + ').';
      console.error('evaluate-run-background: no text block in response —', errorMsg, 'content types:', (data.content || []).map(function (b) { return b && b.type; }));
      await store.setJSON(jobId, {
        status: 'failed',
        error: errorMsg,
        failedAt: new Date().toISOString(),
      });
      return;
    }

    await store.setJSON(jobId, {
      status: 'completed',
      // Only the extracted text block(s) + stop_reason are stored — never
      // the raw response verbatim, so a thinking or signature block (which
      // can be large) can never end up parsed or displayed as the result.
      result: JSON.stringify({ content: textBlocks, stop_reason: data.stop_reason }),
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('evaluate-run-background: unhandled error:', err);
    if (jobId) {
      try {
        await store.setJSON(jobId, {
          status: 'failed',
          error: (err && err.message) || 'Unknown background evaluation error',
          failedAt: new Date().toISOString(),
        });
      } catch (e2) { /* nothing more we can do */ }
    }
  }
};
