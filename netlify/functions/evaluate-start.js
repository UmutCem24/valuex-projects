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
  const runUrl = new URL('/.netlify/functions/evaluate-run-background', req.url).toString();
  try {
    const triggerResp = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, request: body }),
    });
    if (triggerResp.status !== 202 && !triggerResp.ok) {
      console.error('evaluate-start: unexpected trigger response status', triggerResp.status);
    }
  } catch (err) {
    console.error('evaluate-start: failed to trigger background job:', err);
    // Flip the job to failed immediately so a poller never waits forever on
    // a job that was never actually started.
    try {
      await store.setJSON(jobId, {
        status: 'failed',
        error: 'Could not start the background evaluation job: ' + ((err && err.message) || 'unknown error'),
        failedAt: new Date().toISOString(),
      });
    } catch (e2) { /* nothing more we can do */ }
  }

  return new Response(JSON.stringify({ jobId }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
};
