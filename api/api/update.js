// /api/update.js
// Vercel Serverless Function – Updates "Artist availability" & "Artist comment"
// Authentifizierung über WixOwnerID (Wix Member ID) aus dem Request-Body.

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ART = process.env.ARTISTS_DB_ID; // Artists DB (enthält Property "WixOwnerID")

function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
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
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { musicianId, eventId, availability, comment } = req.body || {};

    if (!musicianId) return res.status(400).json({ error: "Missing musicianId" });
    if (!eventId)   return res.status(400).json({ error: "Missing eventId" });

    // 1) Artist in Notion über WixOwnerID (Wix Member ID) finden
    const artRes = await notion.databases.query({
      database_id: DB_ART,
      page_size: 1,
      filter: {
        property: "WixOwnerID",         // <<-- dein Feldname in der Artists-DB
        rich_text: { equals: String(musicianId) }
      }
    });

    if (!artRes.results?.length) {
      return res.status(404).json({ error: "Artist not found for given WixOwnerID" });
    }
    const artistPage = artRes.results[0];

    // 2) Ownership prüfen: Darf diese:r Artist diesen Booking-Process-Eintrag bearbeiten?
    const ev = await notion.pages.retrieve({ page_id: eventId });
    const rel = ev.properties?.["OwnerID"]?.relation || [];
    const allowed = rel.some(r => r.id === artistPage.id);
    if (!allowed) return res.status(403).json({ error: "Not allowed for this event" });

    // 3) Update vorbereiten (nur die freigegebenen Felder)
    const props = {};
    if (availability !== undefined && availability !== null && availability !== "") {
      props["Artist availability"] = { select: { name: String(availability) } };
    }
    if (comment !== undefined) {
      const txt = String(comment || "").slice(0, 2000);
      props["Artist comment"] = {
        rich_text: txt ? [{ type: "text", text: { content: txt } }] : []
      };
    }

    // Wenn nichts zu ändern ist, spar den Call
    if (Object.keys(props).length === 0) {
      return res.json({ ok: true, noChange: true });
    }

    // 4) Update schreiben
    await notion.pages.update({ page_id: eventId, properties: props });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
}
