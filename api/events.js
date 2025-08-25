// /api/events.js – unterstützt Relation ODER Rollup (any.relation.contains)
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BP  = process.env.NOTION_DB_ID;   // Booking Process DB
const DB_ART = process.env.ARTISTS_DB_ID;  // Artists DB

function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
}

function bad(res, msg, details) {
  return res.status(400).json({ error: msg, details });
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { musicianId, cursor, q, sort, availability, status } = req.query;

  const missing = [];
  if (!process.env.NOTION_TOKEN) missing.push("NOTION_TOKEN");
  if (!DB_BP) missing.push("NOTION_DB_ID");
  if (!DB_ART) missing.push("ARTISTS_DB_ID");
  if (!musicianId) missing.push("musicianId");
  if (missing.length) return bad(res, "Missing required values", missing);

  try {
    // 1) Artist per WixOwnerID / Wix Owner ID / Wix Member ID finden
    const artistIdFilters = [
      { property: "WixOwnerID",    rich_text: { equals: String(musicianId) } },
      { property: "Wix Owner ID",  rich_text: { equals: String(musicianId) } },
      { property: "Wix Member ID", rich_text: { equals: String(musicianId) } },
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
        hint: "Check Artists DB id and that WixOwnerID (or Wix Owner ID / Wix Member ID) holds the exact Wix ID.",
        musicianId,
        artistsQueryError
      });
    }

    // 2) Weitere Filter (Suche, Availability, Status)
    const extraFilters = [];
    if (q && String(q).trim()) {
      extraFilters.push({
        or: [
          { property: "Gig",     title:     { contains: String(q).trim() } },
          { property: "Summary", rich_text: { contains: String(q).trim() } }
        ]
      });
    }
    if (availability && availability !== "all") {
      extraFilters.push({ property: "Artist availability", select: { equals: String(availability) } });
    }
    if (status && status !== "all") {
      extraFilters.push({ property: "Status", select: { equals: String(status) } });
    }
    const sorts = [];
    if (sort === "gig_asc")  sorts.push({ property: "Gig", direction: "ascending" });
    if (sort === "gig_desc") sorts.push({ property: "Gig", direction: "descending" });

    // 3) Booking-Query: zuerst Relation versuchen, dann Rollup-Fallback
    const relationPropNames = ["OwnerID", "Owner ID"];
    let response = null, lastErr = null;

    // 3a) Relation-Filter versuchen
    for (const prop of relationPropNames) {
      try {
        const compound = { and: [{ property: prop, relation: { contains: artistPage.id } }, ...extraFilters] };
        response = await notion.databases.query({
          database_id: DB_BP, page_size: 30, start_cursor: cursor || undefined,
          filter: compound, sorts: sorts.length ? sorts : undefined
        });
        break; // wenn erfolgreich, raus
      } catch (e) {
        lastErr = e?.body || e?.message || String(e);
        response = null;
      }
    }

    // 3b) Rollup-Fallback (rollup.any.relation.contains)
    if (!response) {
      for (const prop of relationPropNames) {
        try {
          const compound = { and: [{
            property: prop,
            rollup: { any: { relation: { contains: artistPage.id } } }
          }, ...extraFilters] };
          response = await notion.databases.query({
            database_id: DB_BP, page_size: 30, start_cursor: cursor || undefined,
            filter: compound, sorts: sorts.length ? sorts : undefined
          });
          break;
        } catch (e) {
          lastErr = e?.body || e?.message || String(e);
          response = null;
        }
      }
    }

    if (!response) {
      return res.status(400).json({
        error: "Booking Process query failed",
        hint: "Ensure the Artist link in Booking Process is either a Relation named 'OwnerID'/'Owner ID' or a Rollup of that relation.",
        lastErr
      });
    }

    // 4) Projektion
    const results = response.results.map(page => {
      const p = page.properties || {};
      const gig = (p.Gig?.title || []).map(t => t.plain_text).join("");
      const summary = (p.Summary?.rich_text || []).map(t => t.plain_text).join("");
      const statusName = p.Status?.select?.name || "";
      const avail = p["Artist availability"]?.select?.name || "";
      const comment = (p["Artist comment"]?.rich_text || []).map(t => t.plain_text).join("");
      return { id: page.id, gig, summary, status: statusName, availability: avail, comment };
    });

    res.json({ results, nextCursor: response.next_cursor || null, hasMore: Boolean(response.has_more) });
  } catch (e) {
    console.error("UNCAUGHT /api/events:", e?.body || e?.message || e);
    res.status(500).json({ error: "Server error" });
  }
}
