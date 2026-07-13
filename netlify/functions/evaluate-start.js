// netlify/functions/evaluate-start.js
//
// Entry point for the main VALUEX evaluation.
//
// ARCHITECTURE (this version): the full Anthropic request (system prompt,
// messages, tools — including any base64-encoded deck-page images) is now
// stored directly in the job's Netlify Blobs record, NOT sent in the POST
// body that triggers the background worker. That trigger POST now carries
// only { jobId } — a few dozen bytes, always.
//
// Why: Netlify Background Functions are invoked through AWS Lambda's
// asynchronous ("Event") invocation type under the hood, which has a hard
// 256 KB request-payload limit — separate from, and far smaller than, the
// ~6 MB limit on ordinary synchronous Lambda/API Gateway requests. A real
// VALUEX evaluation's request (deck-page images, full system prompt,
// tools) routinely runs from several hundred KB into multiple MB, so every
// real trigger attempt was rejected at Netlify's platform routing layer
// BEFORE ever reaching evaluate-run-background's code — which is exactly
// why that function's own logs showed nothing at all, not even a
// Duration/Memory line, while a tiny hand-typed curl body got a normal 202.
// Passing only jobId keeps the trigger payload trivially small regardless
// of how large the actual evaluation request is; evaluate-run-background
// now reads the real request back out of Blobs by jobId instead, where
// there is no such size limit.
//
// One-time setup: no additional env vars beyond what evaluate-run-
// background.js already needs (ANTHROPIC_API_KEY). Netlify Blobs needs zero
// provisioning, same as before.

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

  // Temporary — confirms exactly how large real evaluation requests are
  // (deck-page images included), for context on why the 256 KB background-
  // trigger limit was being hit. Safe to remove once confirmed in logs.
  const serializedRequest = JSON.stringify(body);
  console.log('Evaluation request bytes:', new TextEncoder().encode(serializedRequest).length);

  const jobId = makeJobId();
  const store = getStore({ name: JOB_STORE, consistency: 'strong' });

  try {
    // The full request (including any deck-page images) lives here now —
    // never in the trigger POST below. evaluate-run-background reads it
    // back out by jobId, where Blobs storage has no comparable size limit.
    await store.setJSON(jobId, {
      status: 'pending',
      createdAt: new Date().toISOString(),
      request: body,
    });
  } catch (err) {
    console.error('evaluate-start: could not create job record:', err);
    return new Response(JSON.stringify({ error: 'Could not create evaluation job (storage write failed)' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // Trigger the background worker with ONLY the jobId — see the file header
  // for why the full request must never go in this POST body. The target
  // origin is hardcoded to the confirmed-working Netlify subdomain rather
  // than derived from req.url or process.env.URL: req.url's origin inside a
  // Netlify Function can be an internal routing address, and process.env.URL
  // resolves to this site's custom domain (valuex.at), which is currently
  // pointed at Framer, not this Netlify site — neither reliably reaches
  // evaluate-run-background. NETLIFY_FUNCTION_ORIGIN is an optional
  // override (e.g. if the Netlify subdomain ever changes).
  const functionOrigin = process.env.NETLIFY_FUNCTION_ORIGIN || 'https://valuex-websitecom.netlify.app';
  const runUrl = functionOrigin + '/.netlify/functions/evaluate-run-background';
  console.log('Background trigger URL:', runUrl); // temporary — safe to remove once confirmed working

  let triggerOk = false;
  let triggerDetail = '';
  try {
    const triggerResp = await fetch(runUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    // 202 (or any 2xx) means the platform accepted the async invocation —
    // it does NOT mean the worker will succeed, only that it was started.
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
