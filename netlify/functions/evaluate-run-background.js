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
// ARCHITECTURE (this version): the trigger POST from evaluate-start.js now
// carries only { jobId } — the actual request (system prompt, messages,
// tools, including any base64 deck-page images) lives in the job's Netlify
// Blobs record instead, written there by evaluate-start.js. This function
// reads it back out by jobId. Why: a Background Function's trigger
// invocation goes through AWS Lambda's async ("Event") invocation path,
// which has a hard 256 KB payload limit — far too small for a real
// evaluation request with deck images attached. Loading the request from
// Blobs instead of the trigger body sidesteps that limit entirely, since
// Blobs storage has no comparable constraint. If the job record or its
// stored request is missing when this function looks for it, that is
// itself treated as a failure (see near the top of the try block below) —
// never silently ignored.
//
// config.background = true is set below as well, for sites on newer
// Netlify tooling that prefers that over the filename convention — both are
// harmless to specify together, and between the two this function is
// guaranteed to run in background mode regardless of which mechanism this
// site's build actually honors.
//
// Everything is inside ONE try/catch that starts on the very first line of
// real work. Previously `getStore()` and `let jobId = null` sat OUTSIDE the
// try block — if getStore() threw for any reason, the whole invocation
// crashed with an unhandled exception before any of this file's own
// error-handling ever ran, and (because Netlify retries a failed background
// invocation twice before giving up) the job record could be left
// permanently 'pending' with nothing ever written past that. jobId is read
// as early as possible inside the try block for the same reason, and
// getStore() has an explicit siteID/token fallback in case a background
// invocation's context ever differs from a synchronous one's.
//
// THINKING: Claude Sonnet 5 defaults to adaptive thinking ON (effort:
// "high") whenever a request omits the 'thinking' field — this is a
// behavior change from earlier Sonnet models, where omitting it meant no
// thinking. Thinking tokens count against max_tokens like any other output
// token. That's exactly what broke an earlier version of this file: with no
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

export default async (req, context) => {
  let jobId = null;
  let store = null;

  try {
    // getStore() first, defensively. The auto-configured form (no siteID/
    // token needed) works for both regular and background functions per
    // Netlify's docs — but if it ever throws in this invocation context,
    // fall back to an explicit siteID/token rather than letting the whole
    // function die before it can report anything.
    try {
      store = getStore({ name: JOB_STORE, consistency: 'strong' });
    } catch (storeErr) {
      console.error('evaluate-run-background: default getStore() failed, trying explicit siteID fallback:', storeErr);
      const siteID = (context && context.site && context.site.id) || process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
      const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
      if (siteID && token) {
        store = getStore({ name: JOB_STORE, consistency: 'strong', siteID, token });
      } else {
        throw storeErr; // no fallback credentials available — let the outer catch handle it
      }
    }

    const triggerBody = await req.json();
    jobId = triggerBody && triggerBody.jobId;

    if (!jobId) {
      console.error('evaluate-run-background: trigger request missing jobId, nothing to write to.');
      return; // return value is discarded either way; nothing more to do
    }

    // Load the actual evaluation request from the job record itself — the
    // trigger POST only ever carries jobId now (see file header). A missing
    // record or a record without its stored request is a real failure, not
    // something to silently skip.
    const job = await store.get(jobId, { type: 'json' });
    if (!job || !job.request) {
      console.error('evaluate-run-background: job record or its stored request is missing for', jobId);
      await store.setJSON(jobId, {
        status: 'failed',
        error: 'Job record or its stored evaluation request was missing when the background worker tried to read it.',
        failedAt: new Date().toISOString(),
      });
      return;
    }
    const reqPayload = job.request;

    // Keep `request` in the record through 'running' (a platform-level retry
    // of this same invocation would need to re-read it), but terminal states
    // below deliberately drop it — nothing downstream needs it once the job
    // has finished one way or another, and it keeps the stored record small.
    await store.setJSON(jobId, {
      ...job,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

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
        // Reuse `store` if it was already assigned; otherwise make one last
        // attempt to construct a fresh one, in case the failure happened
        // before `store` was ever set.
        const s = store || getStore({ name: JOB_STORE, consistency: 'strong' });
        await s.setJSON(jobId, {
          status: 'failed',
          error: (err && err.message) || 'Unknown background evaluation error',
          failedAt: new Date().toISOString(),
        });
      } catch (e2) {
        console.error('evaluate-run-background: also failed to write the failed status:', e2);
      }
    }
  }
};
