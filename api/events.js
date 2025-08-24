// /api/events.js
// Vercel Serverless Function – nutzt WixOwnerID statt "Wix Member ID"

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BP  = process.env.NOTION_DB_ID;     // Booking Process DB
const DB_ART = process.env.ARTISTS_DB_ID;    // Artists DB

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
    const {
      musicianId,   // Wix Member ID der eingeloggten Person (Pflicht)
      cursor,
      q,
      sort,
      availability,
      status
    } = req.query;

    if (!musicianId) {
      return res.status(400).json({ error: "Missing musicianId" });
    }

    // 1) Artist in Notion über WixOwnerID finden
    const artistResult = await notion.databases.query({
      database_id: DB_ART,
      page_size: 1,
      filter: {
        property: "WixOwnerID",   // <<<<< HIER angepasster Property-Name
        rich_text: { equals: String(musicianId) }
      }
    });

    if (!artistResult.results?.length) {
      return res.status(404).json({ error: "Artist not found for given WixOwnerID" });
    }
    const artistPage = artistResult.results[0];

    // 2) Filter für Booking Process
    const filters = [{
      property: "OwnerID",
      relation: { contains: artistPage.id }
    }];

    if (q && String(q).trim()) {
      filters.push({
        or: [
          { property: "Gig", title: { contains: String(q).trim() } },
          { property: "Summary", rich_text: { contains: String(q).trim() } }
        ]
      });
    }

    if (availability && availability !== "all") {
      filters.push({
        property: "Artist availability",
        select: { equals: String(availability) }
      });
    }

    if (status && status !== "all") {
      filters.push({
        property: "Status",
        select: { equals: String(status) }
      });
    }

    const sorts = [];
    if (sort === "gig_asc")  sorts.push({ property: "Gig", direction: "ascending" });
    if (sort === "gig_desc") sorts.push({ property: "Gig", direction: "descending" });

    const response = await notion.databases.query({
      database_id: DB_BP,
      page_size: 30,
      start_cursor: cursor || undefined,
      filter: { and: filters },
      sorts: sorts.length ? sorts : undefined
    });

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
