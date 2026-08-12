// Global leaderboard, backed by an Upstash Redis REST API.
// Requires a REST URL + token env var pair — set automatically once a Redis
// database (via the Upstash marketplace integration, or the older Vercel KV
// product) is created and linked to this project in the Vercel dashboard
// (Storage tab). Different integrations name the pair differently, so we
// accept either. Until one is linked this endpoint responds with 503 so the
// client can show a friendly "not ready yet" message instead of crashing.

const KEY = 'sili_fab_leaderboard_v1';
const MAX_ENTRIES = 200;
const TOP_N = 50;
const GRADES = new Set(['A', 'B', 'C', 'D', 'F']);

function getKvCredentials() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return { url, token };
}

async function kv(command) {
  const { url, token } = getKvCredentials();
  if (!url || !token) return null;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV error: ${res.status}`);
  const data = await res.json();
  return data.result;
}

async function loadEntries() {
  const raw = await kv(['GET', KEY]);
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().slice(0, 12);
  if (!trimmed) return null;
  return trimmed;
}

module.exports = async function handler(req, res) {
  const { url: kvUrl, token: kvToken } = getKvCredentials();
  if (!kvUrl || !kvToken) {
    res.status(503).json({ error: 'leaderboard_not_configured' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const entries = await loadEntries();
      const top = entries
        .slice()
        .sort((a, b) => b.yieldPct - a.yieldPct || a.ts - b.ts)
        .slice(0, TOP_N);
      res.status(200).json({ entries: top });
      return;
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const name = sanitizeName(body.name);
      const yieldPct = Number(body.yieldPct);
      const grade = typeof body.grade === 'string' ? body.grade.toUpperCase() : '';

      if (!name || !Number.isFinite(yieldPct) || yieldPct < 0 || yieldPct > 100 || !GRADES.has(grade)) {
        res.status(400).json({ error: 'invalid_submission' });
        return;
      }

      const entries = await loadEntries();
      const entry = { name, yieldPct: Math.round(yieldPct), grade, ts: Date.now() };
      entries.push(entry);
      entries.sort((a, b) => b.yieldPct - a.yieldPct || a.ts - b.ts);
      const trimmed = entries.slice(0, MAX_ENTRIES);
      await kv(['SET', KEY, JSON.stringify(trimmed)]);

      const rank = trimmed.findIndex((e) => e.ts === entry.ts && e.name === entry.name) + 1;
      res.status(200).json({ ok: true, rank: rank || null, total: trimmed.length });
      return;
    }

    if (req.method === 'DELETE') {
      // one-off cleanup helper: DELETE /api/leaderboard?ts=<entry ts> removes a single
      // mis-encoded/junk entry. TEMPORARY — remove this block after use.
      const ts = Number((req.query && req.query.ts) || new URL(req.url, 'http://x').searchParams.get('ts'));
      const entries = await loadEntries();
      const next = entries.filter((e) => e.ts !== ts);
      await kv(['SET', KEY, JSON.stringify(next)]);
      res.status(200).json({ ok: true, removed: entries.length - next.length, total: next.length });
      return;
    }

    res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
};
