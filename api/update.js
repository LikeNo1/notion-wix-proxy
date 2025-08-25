// /api/update.js – Availability/Comment speichern + Status "Sent to LikeNo1" setzen
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

    // Seite holen (um Property-Typen zu erkennen)
    const page = await notion.pages.retrieve({ page_id: bookingId });

    const props = {};

    // Availability (Select bevorzugt, sonst RichText – hier Select)
    if (typeof availability === 'string') {
      props['Artist availability'] = availability
        ? { select: { name: availability } }
        : { select: null };
    }

    // Comment (Rich Text)
    if (typeof comment === 'string') {
      const text = String(comment || '').slice(0, 1900);
      props['Artist comment'] = text ? { rich_text: [{ type: 'text', text: { content: text } }] } : { rich_text: [] };
    }

    // Status -> "Sent to LikeNo1" setzen (sofern Status-Property existiert)
    if (page?.properties?.Status) {
      const p = page.properties.Status;
      // Wenn Property vom Typ "status"
      if (p.type === 'status') {
        props['Status'] = { status: { name: 'Sent to LikeNo1' } };
      } else if (p.type === 'select') {
        props['Status'] = { select: { name: 'Sent to LikeNo1' } };
      }
      // Falls Du manche Endstati NIE überschreiben willst, kannst Du hier eine Sperrliste einbauen.
    }

    if (!Object.keys(props).length) {
      return res.status(400).json({ error: 'No properties to update' });
    }

    await notion.pages.update({ page_id: bookingId, properties: props });

    // Optional: Kommentarnotiz anheften
    // await notion.comments.create({
    //   parent: { page_id: bookingId },
    //   rich_text: [{ type: 'text', text: { content: `Updated via Wix by ${musicianId || 'unknown'}` } }]
    // });

    res.json({ ok: true });
  } catch (e) {
    console.error('@update error:', e?.body || e?.message || e);
    return res.status(500).json({ error: 'Server error', details: e?.body || e?.message || String(e) });
  }
}
