// netlify/functions/evaluate-start.js
//
// Entry point for the main VALUEX evaluation. Deliberately does almost no
// work itself so it can never time out:
//   1. Validates and stores the already-built Anthropic request (model,
//      system prompt, messages) as a job record in Netlify Blobs.
//   2. Fires a request at evaluate-run-background.js (a Netlify Background
//      Function) to do the actual, potentially slow Anthropic call.
//   3. Returns { jobId } immediately.
//
// Why this exists: Netlify's standard (synchronous) functions are capped at
// roughly 10-30s depending on plan. Claude generating a full 17-criterion
// scored JSON routinely takes longer than that — trimming the prompt and
// payload (done in earlier iterations of this file) reduced but did not
// reliably eliminate 504s, because the bottleneck is generation time, not
// request size. Background Functions have a 15-minute execution limit,
// which comfortably covers it. The browser polls evaluate-status.js
// (separate file) for the result using the jobId returned here.
//
// FIX (this version): a bad response from the trigger call — anything other
// than 202/2xx, e.g. a 404 because evaluate-run-background isn't deployed
// at the expected path, or a 500 from the platform rejecting the async
// invocation outright — was previously only logged with console.error and
// otherwise ignored: the function still returned { jobId } as if
// everything were fine, and the job record (already written as 'pending')
// was never touched again. That is the exact bug behind jobs staying stuck
// at 'pending' forever with no error ever surfacing anywhere the browser or
// a person could see it. Now any non-2xx/202 trigger response — or a
// network-level failure reaching it at all — flips the job to 'failed'
// immediately, with the actual response detail included, before this
// function returns.
//
// One-time setup: no additional env vars beyond what evaluate.js already
// needs (ANTHROPIC_API_KEY, read by evaluate-run-background.js, not this
// file). Netlify Blobs needs zero provisioning, same as projects.js.

import { getStore } from '@netlify/blobs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JOB_STORE = 'valuex-eval-jobs';

function makeJobId() {
  return 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: cors });
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

  if (!body || !Array.isArray(body.messages) || !body.messages.length) {
    return new Response(JSON.stringify({ error: "Missing or invalid 'messages' in request body" }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const jobId = makeJobId();
  const store = getStore({ name: JOB_STORE, consistency: 'strong' });

  try {
    await store.setJSON(jobId, { status: 'pending', createdAt: new Date().toISOString() });
  } catch (err) {
    console.error('evaluate-start: could not create job record:', err);
    return new Response(JSON.stringify({ error: 'Could not create evaluation job (storage write failed)' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // Trigger the background worker. Hitting a Background Function returns a
  // 202 almost instantly (Netlify answers before the handler body has even
  // run), so awaiting just this dispatch keeps evaluate-start itself fast
  // while still guaranteeing the trigger request was actually sent before
  // this function's own execution context is torn down.
  // FIX (root cause of the 500 "Internal Error" with zero log output on the
  // background function's own side): req.url inside a Netlify Function is
  // not reliably the site's public-facing origin — it can reflect an
  // internal proxy/routing address instead (confirmed by a direct curl to
  // the real production URL returning 202 immediately, while this
  // function's own self-fetch, built from req.url, got a platform-level 500
  // before ever reaching evaluate-run-background's code — hence no log line
  // there at all). Netlify auto-injects the real public origin as
  // process.env.URL (production/custom domain) for every function
  // invocation; DEPLOY_PRIME_URL is the next-best fallback (deploy previews,
  // branch deploys), and req.url's origin is now only a last resort for
  // local `netlify dev`, where those env vars may be absent.
  const siteOrigin = process.env.URL || process.env.DEPLOY_PRIME_URL || new URL(req.url).origin;
  const runUrl = new URL('/.netlify/functions/evaluate-run-background', siteOrigin).toString();
  let triggerOk = false;
  let triggerDetail = '';
  try {
    const triggerResp = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, request: body }),
    });
    // 202 (or any 2xx) means the platform accepted the async invocation —
    // it does NOT mean the worker will succeed, only that it was started.
    // Anything else (404 = wrong path / not deployed as expected, 401/403 =
    // access issue, 500 = platform-level rejection) means the worker was
    // never actually started, and the job must not be left looking healthy.
    if (triggerResp.status === 202 || triggerResp.ok) {
      triggerOk = true;
    } else {
      const t = await triggerResp.text().catch(function () { return ''; });
      triggerDetail = 'Trigger endpoint returned ' + triggerResp.status + (t ? ': ' + t.slice(0, 200) : '');
      console.error('evaluate-start: unexpected trigger response status', triggerResp.status, t.slice(0, 200));
    }
  } catch (err) {
    triggerDetail = 'Could not reach the background trigger endpoint: ' + ((err && err.message) || 'unknown error');
    console.error('evaluate-start: failed to trigger background job:', err);
  }

  if (!triggerOk) {
    // Flip the job to failed immediately so a poller never waits forever on
    // a job that was never actually started.
    try {
      await store.setJSON(jobId, {
        status: 'failed',
        error: 'Could not start the background evaluation job. ' + (triggerDetail || 'Unknown trigger failure.'),
        failedAt: new Date().toISOString(),
      });
    } catch (e2) {
      console.error('evaluate-start: also failed to write the failed status:', e2);
    }
  }

  return new Response(JSON.stringify({ jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
};
