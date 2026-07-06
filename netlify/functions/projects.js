// netlify/functions/projects.js
//
// Shared project-library store for the VALUEX Evaluation Workstation.
//
// Why this exists: the workstation used to keep every evaluated project only
// in the browser's localStorage. localStorage is per-browser-profile, so an
// incognito window, a different browser, or a teammate on another computer
// always saw an empty "All projects" list — the data was never lost, it was
// just never shared anywhere. This function gives the workstation a single
// shared JSON store (Netlify Blobs) that any visitor to the published site
// reads from and writes to, so the library is the same everywhere.
//
// GET  /.netlify/functions/projects           -> full list, every field (workstation-internal use, unchanged).
// GET  /.netlify/functions/projects?public=1  -> only projects with publishedToSelection===true, and only
//                                                 the fields selection.html needs — internal pipeline fields
//                                                 (status, ratingHistory, next_step, contradictions, missing
//                                                 evidence, reviewer notes) are left out on purpose since this
//                                                 path is read by the public, unauthenticated Selection page.
// POST /.netlify/functions/projects           -> replaces the full project list (unchanged).
//
// Netlify Blobs needs zero setup on Netlify's side — no database to
// provision, no connection string. It just needs this function (and the
// @netlify/blobs package, see package.json) to be deployed through Netlify's
// build system (Git-connected deploy or `netlify deploy`), not a bare
// drag-and-drop of static files, since that skips `npm install`.

import { getStore } from '@netlify/blobs';

const STORE_NAME = 'valuex-projects';
const KEY = 'list';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Fields exposed to the public Selection page. Deliberately excludes
// internal-only pipeline data: status (pending/approved/declined/revisit),
// ratingHistory, next_step, contradictions, missing, and anything else not
// listed here. Add a field here only if it's meant to be public.
const PUBLIC_FIELDS = [
  'id', 'name', 'company', 'sector', 'stage', 'token', 'profile',
  'summary', 'total', 'band', 'recommendation',
  'strengths', 'weaknesses', 'dimensions', 'scores', 'founderScores',
  'website', 'founder', 'founderLinkedin', 'logo',
  'lastRunAt', 'publishedToSelection',
];

function toPublicShape(p) {
  const out = {};
  PUBLIC_FIELDS.forEach((k) => { if (p[k] !== undefined) out[k] = p[k]; });
  return out;
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const url = new URL(req.url);
  const isPublic = url.searchParams.get('public') === '1';

  if (req.method === 'GET') {
    let list = [];
    try {
      list = (await store.get(KEY, { type: 'json' })) || [];
    } catch (err) {
      console.error('projects GET failed:', err);
    }
    if (isPublic) {
      list = list.filter((p) => p && p.publishedToSelection === true).map(toPublicShape);
    }
    return new Response(JSON.stringify(list), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Public reads can be cached briefly at the edge; internal reads stay uncached
        // (the workstation UI wants to see its own writes immediately).
        'Cache-Control': isPublic ? 'public, max-age=30' : 'no-store',
        ...cors,
      },
    });
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    if (!Array.isArray(body)) {
      return new Response(JSON.stringify({ error: 'Expected a JSON array of projects' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    try {
      await store.setJSON(KEY, body);
    } catch (err) {
      console.error('projects POST failed:', err);
      return new Response(JSON.stringify({ error: 'Storage write failed' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
    return new Response(JSON.stringify({ ok: true, count: body.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
};
