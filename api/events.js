// /api/events.js
// Vercel Serverless Function (Node, ESM). Nutzt NUR die Wix Member ID (kein Musician Key).
// Environment Variables (in Vercel > Project > Settings > Environment Variables):
// - NOTION_TOKEN       -> Dein Notion API Token (ntn_...)
// - NOTION_DB_ID       -> DB-ID "Booking Process"
// - ARTISTS_DB_ID      -> DB-ID "Artists"
// - ALLOWED_ORIGINS    -> Deine Wix-Domain(s), z.B. "https://www.deinedomain.de,https://deinname.wixsite.com"

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BP  = process.env.NOTION_DB_ID;     // Booking Process
const DB_ART = process.env.ARTISTS_DB_ID;    // Artists

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
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
}

const richToText = r => (r || []).map(p => p.plain_text || "").join("");

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Query-Parameter vom Frontend
    const {
      musicianId,   // Wix Member ID der eingeloggten Person (Pflicht)
      cursor,       // Notion start_cursor für Pagination
      q,            // Suchbegriff (optional)
      sort,         // "gig_asc" | "gig_desc" (optional)
      availability, // "Yes" | "No" | "Other" | "all" (optional)
      status        // einer Deiner Status-Werte | "all" (optional)
    } = req.query;

    if (!musicianId) {
      return res.status(400).json({ error: "Missing musicianId" });
    }

    // 1) Artist in Notion über die Wix Member ID finden
    const artistResult = await notion.databases.query({
      database_id: DB_ART,
      page_size: 1,
      filter: {
        property: "Wix Member ID",
        rich_text: { equals: String(musicianId) }
      }
    });

    if (!artistResult.results?.length) {
      return res.status(404).json({ error: "Artist not found for given Wix Member ID" });
    }
    const artistPage = artistResult.results[0];

    // 2) Basis-Filter: OwnerID (Relation) enthält diesen Artist
    const filters = [{
      property: "OwnerID",
      relation: { contains: artistPage.id }
    }];

    // 3) Suche (Gig Title + Summary)
    if (q && String(q).trim()) {
      filters.push({
        or: [
          { property: "Gig",     title:     { contains: String(q).trim() } },
          { property: "Summary", rich_text: { contains: String(q).trim() } }
        ]
      });
    }

    // 4) Filter Availability (Artist availability)
    if (availability && availability !== "all") {
      filters.push({
        property: "Artist availability",
        select: { equals: String(availability) }
      });
    }

    // 5) Filter Status
    if (status && status !== "all") {
      filters.push({
        property: "Status",
        select: { equals: String(status) }
      });
    }

    // 6) Sortierung
    const sorts = [];
    if (sort === "gig_asc")  sorts.push({ property: "Gig", direction: "ascending"  });
    if (sort === "gig_desc") sorts.push({ property: "Gig", direction: "descending" });

    // 7) Notion-Abfrage (30er Pagination)
    const response = await notion.databases.query({
      database_id: DB_BP,
      page_size: 30,
      start_cursor: cursor || undefined,
      filter: { and: filters },
      sorts: sorts.length ? sorts : undefined
    });

    // 8) Felder fürs Frontend mappen
    const results = response.results.map(page => {
      const p = page.properties || {};
      return {
        id: page.id,
        gig: (p.Gig?.title || []).map(t => t.plain_text).join(""),
        summary: (p.Summary?.rich_text || []).map(t => t.plain_text).join(""),
        status: p.Status?.select?.name || "",
        availability: p["Artist availability"]?.select?.name || "",
        comment: (p["Artist comment"]?.rich_text || []).map(t => t.plain_text).join("")
      };
    });

    // 9) Antwort an Frontend
    res.json({
      results,
      nextCursor: response.next_cursor || null,
      hasMore: Boolean(response.has_more)
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
}
