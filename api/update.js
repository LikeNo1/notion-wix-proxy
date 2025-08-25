// /api/update.js – Availability/Comment speichern + Status "Artist replied" setzen
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BOOK = process.env.BOOKING_DB_ID;

function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const missing = [];
  if (!process.env.NOTION_TOKEN) missing.push('NOTION_TOKEN');
  if (!DB_BOOK) missing.push('BOOKING_DB_ID');
  if (missing.length) return res.status(400).json({ error: 'Missing required env', details: missing });

  try {
    const { bookingId, availability, comment, musicianId } = req.body || {};
    if (!bookingId) return res.status(400).json({ error: 'bookingId missing' });

    // 1) Notion page lesen (Status ermitteln)
    const page = await notion.pages.retrieve({ page_id: bookingId }).catch(() => null);

    // 2) Eigenschaften bauen
    const properties = {};

    // Artist availability (Select/Text)
    if (typeof availability === 'string') {
      // wenn Select-Property:
      properties['Artist availability'] = { select: availability ? { name: availability } : null };
      // Fallback (falls in Deiner DB Rich Text sein sollte):
      // properties['Artist availability'] = { rich_text: availability ? [{ type:'text', text:{ content: availability } }] : [] };
    }

    // Artist comment (Rich Text)
    if (typeof comment === 'string') {
      properties['Artist comment'] = {
        rich_text: comment ? [{ type: 'text', text: { content: comment } }] : []
      };
    }

    // 3) Status auf "Artist replied" setzen (wenn Status-Property existiert)
    //    final / rote Stati lassen wir unangetastet.
    const finalStatus = new Set(['Cancelled/Declined', 'Completed', 'Post-show', 'Confirmed/In progress']);
    let shouldTouchStatus = true;

    if (page?.properties?.Status) {
      const p = page.properties.Status;
      const current =
        p.type === 'status' ? (p.status?.name || '') :
        p.type === 'select' ? (p.select?.name || '') : '';

      if (finalStatus.has(current)) {
        shouldTouchStatus = false;
      }
      if (shouldTouchStatus) {
        properties['Status'] = (p.type === 'status')
          ? { status: { name: 'Artist replied' } }
          : { select: { name: 'Artist replied' } };
      }
    }

    // 4) Update ausführen
    await notion.pages.update({
      page_id: bookingId,
      properties
    });

    // Optional: Kommentar an die Notion-Page hängen
    // await notion.comments.create({
    //   parent: { page_id: bookingId },
    //   rich_text: [{ type: 'text', text: { content: `Artist updated via Wix (${musicianId || 'unknown'})` } }]
    // });

    res.json({ ok: true });
  } catch (e) {
    console.error('@update error:', e?.body || e?.message || e);
    return res.status(500).json({ error: 'Server error', details: e?.body || e?.message || String(e) });
  }
}
