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
// Note: 'summary' is included in the source object but its value is always
// REPLACED by buildPublicSummary() below before this ever leaves the
// server — the raw AI-generated summary (which can mention uploaded file
// names, awkward phrasing, etc.) never reaches the public pages.
const PUBLIC_FIELDS = [
  'id', 'name', 'company', 'sector', 'stage', 'token', 'profile',
  'summary', 'total', 'band', 'recommendation',
  'strengths', 'weaknesses', 'dimensions', 'scores', 'founderScores',
  'website', 'founder', 'founderLinkedin', 'logo',
  'lastRunAt', 'publishedToSelection',
];

// Investor-facing display names for the 7 scoring dimensions — a little
// more polished than the internal short codes (e.g. "Tech" -> "Technology").
const DIM_DISPLAY = {
  Market: 'Market',
  Tech: 'Technology',
  Sales: 'Commercial Traction',
  Econ: 'Economics',
  Skill: 'Team & Execution',
  Engagement: 'Community Engagement',
  Security: 'Security',
};

// "Decentralized Finance (DeFi), Blockchain Infrastructure, FinTech" -> "DeFi / Blockchain Infrastructure"
// Prefers the short parenthetical acronym where the project/founder supplied one, and caps it at
// two segments so the opening sentence stays a sentence rather than a category dump.
function shortSectorLabel(sectorStr) {
  const parts = String(sectorStr || '').split(',').map((s) => s.trim()).filter(Boolean);
  const short = parts.map((p) => {
    const m = p.match(/\(([^)]+)\)/);
    return m ? m[1] : p;
  });
  if (!short.length) return 'technology';
  if (short.length === 1) return short[0];
  return short.slice(0, 2).join(' / ');
}

function stageLabel(stage) {
  const s = String(stage || '').trim();
  if (!s) return 'early';
  if (s.length <= 4 && s === s.toUpperCase()) return s; // keep short acronyms as-is, e.g. "MVP"
  return s.toLowerCase();
}

function bandLabel(band) {
  if (band === 'top') return 'top-tier';
  return String(band || '').replace(/-/g, ' ') || 'evaluated';
}

function topBottomDims(dimensions) {
  const arr = (dimensions || [])
    .filter((d) => d && d.name && typeof d.weight === 'number')
    .map((d) => ({ name: d.name, avg: d.weight > 0 ? (d.contrib || 0) / (d.weight * 60) : 0 }));
  arr.sort((a, b) => b.avg - a.avg);
  return { top: arr.slice(0, 2), bottom: arr.slice(-2) };
}

// Builds the 2-sentence, investor-ready summary shown on selection.html cards
// and on project.html — generated fresh from structured fields (sector, stage,
// band, dimension scores) rather than passed through from the AI's raw
// "summary" text, so it never carries file names, internal notes, or
// awkward auto-generated phrasing onto the public site.
function buildPublicSummary(p) {
  const name = p.name || 'This project';
  const sector = shortSectorLabel(p.sector);
  const stage = stageLabel(p.stage);
  const band = bandLabel(p.band);
  const { top, bottom } = topBottomDims(p.dimensions);

  const sentence1 = `${name} is a ${sector} project at the ${stage} stage.`;

  if (top.length === 2 && bottom.length === 2) {
    const t1 = DIM_DISPLAY[top[0].name] || top[0].name;
    const t2 = DIM_DISPLAY[top[1].name] || top[1].name;
    const b1 = DIM_DISPLAY[bottom[0].name] || bottom[0].name;
    const b2 = DIM_DISPLAY[bottom[1].name] || bottom[1].name;
    return `${sentence1} VALUEX's evaluation places it in the ${band} band, with relative strengths in `
      + `${t1} and ${t2}, and further validation needed around ${b1} and ${b2}.`;
  }
  return `${sentence1} VALUEX's evaluation places it in the ${band} band.`;
}

function toPublicShape(p) {
  const out = {};
  PUBLIC_FIELDS.forEach((k) => { if (p[k] !== undefined) out[k] = p[k]; });
  out.summary = buildPublicSummary(p);
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
