// /api/update.js – robust: Owner-Check (Relation/Rollup), "Potential" blockieren, klare Fehler
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ART = process.env.ARTISTS_DB_ID; // Artists DB

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

function bad(res, msg, details) {
  return res.status(400).json({ error: msg, details });
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const missing = [];
  if (!process.env.NOTION_TOKEN) missing.push("NOTION_TOKEN");
  if (!DB_ART) missing.push("ARTISTS_DB_ID");
  if (missing.length) return bad(res, "Missing required values", missing);

  try {
    const { musicianId, eventId, availability, comment } = req.body || {};
    if (!musicianId) return bad(res, "Missing musicianId");
    if (!eventId)    return bad(res, "Missing eventId");

    // 1) Artist in Notion über WixOwnerID / Wix Owner ID / Wix Member ID finden
    const artistIdFilters = [
      { property: "WixOwnerID",     rich_text: { equals: String(musicianId) } },
      { property: "Wix Owner ID",   rich_text: { equals: String(musicianId) } },
      { property: "Wix Member ID",  rich_text: { equals: String(musicianId) } }
    ];
    let artistPage = null, artistsQueryError = null;
    for (const f of artistIdFilters) {
      try {
        const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
        if (r.results?.length) { artistPage = r.results[0]; break; }
      } catch (e) {
        artistsQueryError = e?.body || e?.message || String(e);
      }
    }
    if (!artistPage) {
      return res.status(404).json({
        error: "Artist not found by Wix member id",
        hint: "Prüfe ARTISTS_DB_ID und dass 'WixOwnerID' (oder 'Wix Owner ID' / 'Wix Member ID') exakt die Wix-ID enthält.",
        musicianId,
        artistsQueryError
      });
    }

    // 2) Event holen
    let ev;
    try {
      ev = await notion.pages.retrieve({ page_id: eventId });
    } catch (e) {
      return res.status(404).json({ error: "Event not found (page_id invalid)", details: e?.body || e?.message || String(e) });
    }

    // 3) Status prüfen – Potential blockieren
    const statusName = ev?.properties?.["Status"]?.select?.name || "";
    if (statusName === "Potential") {
      return res.status(403).json({ error: "Updates are not allowed for events with status 'Potential'." });
    }

    // 4) Ownership prüfen – Relation ODER Rollup (any.relation.contains)
    const ownerPropCandidates = ["OwnerID", "Owner ID"];
    let isOwner = false;

    for (const propName of ownerPropCandidates) {
      const prop = ev?.properties?.[propName];
      if (!prop) continue;

      if (prop.type === "relation" && Array.isArray(prop.relation)) {
        // Direkt relation prüfen
        if (prop.relation.some(r => r?.id === artistPage.id)) { isOwner = true; break; }
      }

      if (prop.type === "rollup") {
        const rr = prop.rollup || {};
        // rollup array -> Elemente können u.a. 'relation' enthalten
        if (rr.type === "array" && Array.isArray(rr.array)) {
          const hit = rr.array.some(item => {
            // Variante 1: item ist selbst relation-Item mit .relation (Array oder Objekt)
            if (item?.type === "relation") {
              if (Array.isArray(item.relation)) {
                return item.relation.some(x => x?.id === artistPage.id);
              }
              if (item.relation && item.relation.id) {
                return item.relation.id === artistPage.id;
              }
            }
            // Variante 2: manche Rollups geben plain-Objekte mit id zurück
            if (item?.id && item.id === artistPage.id) return true;
            return false;
          });
          if (hit) { isOwner = true; break; }
        }
      }
    }

    if (!isOwner) {
      return res.status(403).json({ error: "Not allowed for this event (ownership check failed)." });
    }

    // 5) Update-Payload bauen – nur erlaubte Felder
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

    if (Object.keys(props).length === 0) {
      return res.json({ ok: true, noChange: true });
    }

    // 6) Schreiben
    try {
      await notion.pages.update({ page_id: eventId, properties: props });
    } catch (e) {
      return res.status(400).json({
        error: "Update failed – check property names/types (Artist availability as Select; Artist comment as Rich Text).",
        details: e?.body || e?.message || String(e)
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("UNCAUGHT /api/update:", e?.body || e?.message || e);
    res.status(500).json({ error: "Server error" });
  }
}
