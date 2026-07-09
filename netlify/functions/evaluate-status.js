// netlify/functions/evaluate-status.js
//
// Polled by the browser every ~2.5s while a VALUEX evaluation job (created
// by evaluate-start.js, executed by evaluate-run-background.js) is in
// flight. Always fast — a single Netlify Blobs read, nothing else.
//
// GET /.netlify/functions/evaluate-status?jobId=job_xxx
// -> { status: 'pending' | 'running' | 'completed' | 'failed', ... }
// -> 404 { status: 'not_found' } if the jobId is unknown (client treats
//    this the same as 'pending' for the first few polls, in case of a rare
//    read-after-write race, and only surfaces it as an error once the
//    overall client-side poll timeout is reached).

import { getStore } from '@netlify/blobs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JOB_STORE = 'valuex-eval-jobs';

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: cors });
  }

  const url = new URL(req.url);
  const jobId = (url.searchParams.get('jobId') || '').trim();
  if (!jobId) {
    return new Response(JSON.stringify({ error: "Missing 'jobId' query parameter" }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  const store = getStore({ name: JOB_STORE, consistency: 'strong' });
  let job = null;
  try {
    job = await store.get(jobId, { type: 'json' });
  } catch (err) {
    console.error('evaluate-status: read failed:', err);
  }

  if (!job) {
    return new Response(JSON.stringify({ status: 'not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
    });
  }

  return new Response(JSON.stringify(job), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
};
