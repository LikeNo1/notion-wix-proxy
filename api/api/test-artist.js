// /api/test-artist.js
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ART = process.env.ARTISTS_DB_ID;

export default async function handler(req, res) {
  try {
    const musicianId = String(req.query.musicianId || "").trim();
    if (!musicianId) return res.status(400).json({ ok: false, error: "missing musicianId" });
    if (!DB_ART) return res.status(500).json({ ok: false, error: "ARTISTS_DB_ID missing" });

    const propNames = ["WixOwnerID", "Wix Owner ID", "Wix Member ID"];
    const tries = [];
    for (const p of propNames) {
      tries.push({ note: `${p} rich_text equals`,  filter: { property: p, rich_text: { equals: musicianId } } });
      tries.push({ note: `${p} rich_text contains`, filter: { property: p, rich_text: { contains: musicianId } } });
      tries.push({ note: `${p} title equals`,      filter: { property: p, title:     { equals: musicianId } } });
      tries.push({ note: `${p} title contains`,    filter: { property: p, title:     { contains: musicianId } } });
      tries.push({ note: `${p} formula equals`,    filter: { property: p, formula:   { string: { equals: musicianId } } } });
      tries.push({ note: `${p} formula contains`,  filter: { property: p, formula:   { string: { contains: musicianId } } } });
    }

    const attempts = [];
    for (const t of tries) {
      try {
        const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: t.filter });
        attempts.push({ try: t.note, ok: true, count: r.results?.length || 0 });
        if (r.results?.length) {
          return res.json({
            ok: true,
            matchedTry: t.note,
            artistId: r.results[0].id,
            rawName: r.results[0].properties?.Name?.title?.[0]?.plain_text || null
          });
        }
      } catch (e) {
        attempts.push({ try: t.note, ok: false, error: e.body || e.message || String(e) });
      }
    }

    return res.status(404).json({ ok: false, error: "artist not found", musicianId, attempts });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.body || e.message || String(e) });
  }
}
