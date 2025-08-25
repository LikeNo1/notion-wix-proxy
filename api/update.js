// /api/update.js – robustes Update mit klaren Fehlermeldungen
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

function bad(res, status, msg, details) {
  return res.status(status).json({ error: msg, details });
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

  if (!process.env.NOTION_TOKEN || !DB_BOOK) {
    return bad(res, 400, 'Missing env', { NOTION_TOKEN: !!process.env.NOTION_TOKEN, BOOKING_DB_ID: !!DB_BOOK });
  }

  try {
    const { bookingId, availability, comment } = req.body || {};
    if (!bookingId) return bad(res, 400, 'bookingId missing');

    // Seite lesen, um die tatsächlichen Property-Typen zu kennen
    const page = await notion.pages.retrieve({ page_id: bookingId });

    const props = {};
    const pAvail = page.properties?.['Artist availability'];
    const pComm  = page.properties?.['Artist comment'];
    const pStat  = page.properties?.['Status'];

    // --- Availability schreiben: Select ODER Rich Text ---
    if (typeof availability === 'string') {
      const val = availability.trim();
      if (pAvail?.type === 'select') {
        // Für Select: Notion kann Select-Optionen dynamisch anlegen → klappt i.d.R. mit beliebigen Namen
        props['Artist availability'] = val ? { select: { name: val } } : { select: null };
      } else if (pAvail?.type === 'rich_text') {
        props['Artist availability'] = val ? { rich_text: [{ type:'text', text:{ content: val } }] } : { rich_text: [] };
      } // andere Typen lassen wir aus
    }

    // --- Comment schreiben: Rich Text bevorzugt ---
    if (typeof comment === 'string') {
      const text = String(comment || '').slice(0, 1900);
      if (pComm?.type === 'rich_text') {
        props['Artist comment'] = text ? { rich_text: [{ type: 'text', text: { content: text } }] } : { rich_text: [] };
      } else if (pComm?.type === 'title') {
        // Fallback (falls jemand das fälschlich als title angelegt hat)
        props['Artist comment'] = text ? { title: [{ type: 'text', text: { content: text } }] } : { title: [] };
      }
    }

    // --- Status setzen: "Sent to LikeNo1" ---
    if (pStat) {
      const target = 'Sent to LikeNo1';
      if (pStat.type === 'status') {
        // WICHTIG: Option MUSS in Notion existieren!
        props['Status'] = { status: { name: target } };
      } else if (pStat.type === 'select') {
        props['Status'] = { select: { name: target } };
      }
    }

    if (!Object.keys(props).length) {
      return bad(res, 400, 'No mappable properties on page. Check property names & types.', {
        hasAvailability: !!pAvail, availabilityType: pAvail?.type,
        hasComment: !!pComm, commentType: pComm?.type,
        hasStatus: !!pStat, statusType: pStat?.type
      });
    }

    try {
      await notion.pages.update({ page_id: bookingId, properties: props });
    } catch (err) {
      // Häufiger Fehler: Status-Option existiert nicht (bei Typ "status")
      const body = err?.body || {};
      const msg = body?.message || err?.message || String(err);
      if (msg?.toLowerCase().includes('does not exist') || msg?.toLowerCase().includes('status')) {
        return bad(res, 400, 'Notion lehnt das Status-Update ab. Prüfe, ob in "Status" die Option "Sent to LikeNo1" existiert.', { notionError: body || msg });
      }
      // Availability-Fehler (Select-Optionen): selten, aber melden
      if (msg?.toLowerCase().includes('select')) {
        return bad(res, 400, 'Notion lehnt Artist availability ab. Prüfe, ob die Select-Optionen "Yes", "No", "Other" existieren.', { notionError: body || msg });
      }
      // generisch
      return bad(res, 400, 'Notion update failed', { notionError: body || msg });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('@update error:', e?.body || e?.message || e);
    return bad(res, 500, 'Server error', e?.body || e?.message || String(e));
  }
}
