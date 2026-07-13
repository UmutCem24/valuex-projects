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
//
// FIX (this version): added a stale-job watchdog. Previously, if
// evaluate-run-background.js never got the chance to write anything past
// evaluate-start.js's initial 'pending' record — for any reason, including
// ones neither of those two files' own error handling anticipated — this
// endpoint would just keep faithfully returning 'pending' forever, HTTP 200
// every time, with nothing to indicate anything was wrong. That matches
// exactly what was reported: "all status requests return 200" while the
// job never progresses. Now, if a job has been sitting at 'pending' or
// 'running' longer than STALE_MS, this endpoint synthesizes a 'failed'
// status (and persists it, so subsequent polls see the same terminal
// state) instead of reporting business-as-usual forever. This check only
// depends on the 'pending' record evaluate-start.js already wrote
// successfully, so it works as a backstop even if the background worker
// never ran at all.

import { getStore } from '@netlify/blobs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const JOB_STORE = 'valuex-eval-jobs';
// Slightly under the 15-minute Background Function ceiling, and under the
// browser's own poll timeout, so a genuinely stuck job always resolves to a
// visible, explained failure before the client just gives up on its own
// with a generic "taking too long" message.
const STALE_MS = 10 * 60 * 1000; // 10 minutes

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

  if (job.status === 'pending' || job.status === 'running') {
    const startedRef = job.startedAt || job.createdAt;
    const ageMs = startedRef ? (Date.now() - new Date(startedRef).getTime()) : 0;
    if (ageMs > STALE_MS) {
      job = {
        status: 'failed',
        error: 'The background worker never reported back within ' + Math.round(STALE_MS / 60000) +
          ' minutes (last known state: ' + job.status + '). It may have crashed before writing a status, ' +
          'or the trigger to start it may have failed. Try running the evaluation again; if this repeats, ' +
          'check the evaluate-run-background function logs in the Netlify dashboard.',
        failedAt: new Date().toISOString(),
        staleWatchdog: true,
      };
      try {
        await store.setJSON(jobId, job);
      } catch (writeErr) {
        console.error('evaluate-status: could not persist stale-job failure:', writeErr);
        // Still return the synthesized failure below even if persisting it
        // failed — the client must not be told 'pending' past this point.
      }
    }
  }

  return new Response(JSON.stringify(job), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors },
  });
};
