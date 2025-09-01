// /api/events.js – Events für eingeloggte Artists
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BOOK = process.env.BOOKING_DB_ID; // Booking Process DB (Events)
const DB_ART  = process.env.ARTISTS_DB_ID; // Artists DB

// ---- Helpers ----
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

function plain(rich) {
  if (Array.isArray(rich)) return rich.map(n => n?.plain_text || "").join("").trim();
  return "";
}
function getProp(page, key) { return page?.properties?.[key]; }

function textFrom(p) {
  if (!p) return "";
  if (p.type === "title")     return plain(p.title);
  if (p.type === "rich_text") return plain(p.rich_text);
  if (p.type === "select")    return p.select?.name || "";
  if (p.type === "status")    return p.status?.name || "";
  if (p.type === "formula") {
    const f = p.formula;
    if (!f) return "";
    if (f.type === "string")  return f.string || "";
    if (f.type === "number")  return String(f.number);
    if (f.type === "boolean") return f.boolean ? "true" : "false";
    if (f.type === "date")    return f.date?.start || "";
  }
  if (p.type === "rollup") {
    if (p.rollup?.type === "array") {
      return (p.rollup.array || []).map(x => textFrom(x)).join(" ");
    }
    if (p.rollup?.type === "number") return String(p.rollup.number);
    if (p.rollup?.type === "date") return p.rollup.date?.start || "";
  }
  return "";
}

// --- Mapping Booking Page ---
function mapPage(page) {
  const gig   = textFrom(getProp(page, "Gig"));
  const stat  = textFrom(getProp(page, "Status"));
  const avail = textFrom(getProp(page, "Artist availability"));
  const comm  = textFrom(getProp(page, "Artist comment"));

  // Summary **selbst zusammenbauen** aus Rollups
  const date  = textFrom(getProp(page, "Date + Time"));
  const ctry  = textFrom(getProp(page, "Country"));
  const loc   = textFrom(getProp(page, "Location"));
  const state = textFrom(getProp(page, "Bundesland (nur D)"));
  const web   = textFrom(getProp(page, "Website"));
  const ig    = textFrom(getProp(page, "Instagram"));
  const fb    = textFrom(getProp(page, "Facebook"));
  const desc  = textFrom(getProp(page, "Short description"));
  const vibe  = textFrom(getProp(page, "Vibe/Notes"));

  const summary =
    "📅 Datum/Zeit: " + (date || "noch zu terminieren") + "\n" +
    "🗺️ Location: " + [ctry, state, loc].filter(Boolean).join("/") + "\n" +
    "🔗 Link: " + [web, ig, fb].filter(Boolean).join(" ") + "\n" +
    "📃 Beschreibung und Vibe:\n" + [desc, vibe].filter(Boolean).join("\n");

  return {
    id: page.id,
    gig,
    summary,
    status: stat,
    availability: avail,
    comment: comm
  };
}

// --- API Handler ---
export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const missing = [];
  if (!process.env.NOTION_TOKEN) missing.push("NOTION_TOKEN");
  if (!DB_BOOK) missing.push("BOOKING_DB_ID");
  if (!DB_ART) missing.push("ARTISTS_DB_ID");
  if (missing.length) return bad(res, "Missing required values", missing);

  try {
    const {
      musicianId = "",
      cursor = null,
      q = "",
      sort = "gig_asc",
      status = "all",
      pageSize = 30
    } = req.query || {};

    if (!musicianId) return bad(res, "Missing musicianId");

    // 1) Artist anhand der WixID finden
    const idFilters = [
      { property: "WixOwnerID",    rich_text: { equals: String(musicianId) } },
      { property: "Wix Owner ID",  rich_text: { equals: String(musicianId) } },
      { property: "Wix Member ID", rich_text: { equals: String(musicianId) } }
    ];
    let artistPage = null;
    for (const f of idFilters) {
      const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
      if (r.results?.length) { artistPage = r.results[0]; break; }
    }
    if (!artistPage) {
      return res.status(404).json({ error: "Artist not found", musicianId });
    }

    // 2) Filter für Booking DB
    const andFilters = [];

    // Eigentümer via Relation oder Rollup
    andFilters.push({
      or: [
        { property: "OwnerID", relation: { contains: artistPage.id } },
        { property: "Owner ID", relation: { contains: artistPage.id } },
        { property: "Artist",  relation: { contains: artistPage.id } },
        { property: "OwnerID", rollup: { any: { relation: { contains: artistPage.id } } } },
        { property: "Owner ID", rollup: { any: { relation: { contains: artistPage.id } } } }
      ]
    });

    // Potential ausschließen
    andFilters.push({
      or: [
        { property: "Status", status: { does_not_equal: "Potential" } },
        { property: "Status", select: { does_not_equal: "Potential" } }
      ]
    });

    // optional: Status
    const sNorm = String(status).trim();
    if (sNorm && sNorm.toLowerCase() !== "all") {
      andFilters.push({
        or: [
          { property: "Status", status: { equals: sNorm } },
          { property: "Status", select: { equals: sNorm } }
        ]
      });
    }

    // optional: Suche
    const qNorm = String(q || "").trim();
    if (qNorm) {
      andFilters.push({ property: "Gig", title: { contains: qNorm } });
    }

    const filterObj = { and: andFilters };

    // 3) Sortierung
    const sorts = [];
    if (sort === "gig_asc")  sorts.push({ property: "Gig", direction: "ascending" });
    if (sort === "gig_desc") sorts.push({ property: "Gig", direction: "descending" });
    if (!sorts.length)       sorts.push({ timestamp: "last_edited_time", direction: "descending" });

    // 4) Query
    const r = await notion.databases.query({
      database_id: DB_BOOK,
      page_size: Number(pageSize) || 30,
      sorts,
      filter: filterObj,
      ...(cursor ? { start_cursor: String(cursor) } : {})
    });

    // 5) Mappen
    const results = (r.results || []).map(mapPage);
    const nextCursor = r.has_more ? r.next_cursor : null;

    // 6) Response
    res.json({
      results,
      nextCursor,
      hasMore: !!r.has_more
    });

  } catch (e) {
    console.error("@events error:", e?.body || e?.message || e);
    res.status(500).json({ error: "Server error", details: e?.body || e?.message || String(e) });
  }
}
