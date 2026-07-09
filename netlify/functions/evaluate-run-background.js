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

import { getStore } from '@netlify/blobs';

export const config = { background: true };

const JOB_STORE = 'valuex-eval-jobs';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const MIN_MAX_TOKENS = 2000;

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

    await store.setJSON(jobId, {
      status: 'completed',
      result: text, // raw Anthropic response body — parsed client-side exactly as the old synchronous path did
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
