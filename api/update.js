// /api/update.js
import { Client } from '@notionhq/client';

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: process.env.NOTION_VERSION || "2025-09-03"
});
const DB_BOOK = process.env.BOOKING_DB_ID;

function setCors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "*")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes("*") || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
}
function bad(res, status, msg, details) {
  return res.status(status).json({ error: msg, details });
}

export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

  if (!process.env.NOTION_TOKEN || !DB_BOOK) {
    return bad(res, 400, 'Missing env', { NOTION_TOKEN: !!process.env.NOTION_TOKEN, BOOKING_DB_ID: !!DB_BOOK });
  }

  try {
    const { bookingId, availability, comment } = req.body || {};
    if (!bookingId) return bad(res, 400, 'bookingId missing');

    const page = await notion.pages.retrieve({ page_id: bookingId });

    const props = {};
    const pAvail = page.properties?.['Artist availability'] || page.properties?.['Availability artist'];
    const pComm  = page.properties?.['Artist comment'];
    const pStat  = page.properties?.['Status'];

    if (typeof availability === 'string') {
      const val = availability.trim();
      if (pAvail?.type === 'select') {
        props[pAvail.name || 'Artist availability'] = val ? { select: { name: val } } : { select: null };
      } else if (pAvail?.type === 'rich_text') {
        props[pAvail.name || 'Artist availability'] = val ? { rich_text: [{ type:'text', text:{ content: val } }] } : { rich_text: [] };
      }
    }

    if (typeof comment === 'string') {
      const text = String(comment || '').slice(0, 1900);
      if (pComm?.type === 'rich_text') {
        props['Artist comment'] = text ? { rich_text: [{ type: 'text', text: { content: text } }] } : { rich_text: [] };
      } else if (pComm?.type === 'title') {
        props['Artist comment'] = text ? { title: [{ type: 'text', text: { content: text } }] } : { title: [] };
      }
    }

    if (pStat) {
      const target = 'Sent to LikeNo1';
      if (pStat.type === 'status') props['Status'] = { status: { name: target } };
      else if (pStat.type === 'select') props['Status'] = { select: { name: target } };
    }

    if (!Object.keys(props).length) {
      return bad(res, 400, 'No mappable properties on page. Check property names & types.', {
        hasAvailability: !!pAvail, availabilityType: pAvail?.type,
        hasComment: !!pComm, commentType: pComm?.type,
        hasStatus: !!pStat, statusType: pStat?.type
      });
    }

    await notion.pages.update({ page_id: bookingId, properties: props });
    res.json({ ok: true });
  } catch (e) {
    const body = e?.body || {};
    const msg = body?.message || e?.message || String(e);
    if (msg?.toLowerCase().includes('does not exist') || msg?.toLowerCase().includes('status')) {
      return bad(res, 400, 'Notion lehnt das Status-Update ab. Prüfe, ob in "Status" die Option "Sent to LikeNo1" existiert.', { notionError: body || msg });
    }
    if (msg?.toLowerCase().includes('select')) {
      return bad(res, 400, 'Notion lehnt Artist availability ab. Prüfe, ob die Select-Optionen "Yes", "No", "Other" existieren.', { notionError: body || msg });
    }
    return bad(res, 400, 'Notion update failed', { notionError: body || msg });
  }
}
