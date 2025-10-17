// /api/events-test.js
import { Client } from "@notionhq/client";

// HIER die Version ergänzen:
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: "2025-09-03"
});

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BOOK = process.env.BOOKING_DB_ID;
const DB_ART  = process.env.ARTISTS_DB_ID;

// Helpers
const P = (page, key) => page?.properties?.[key] ?? null;
const plain = a => Array.isArray(a) ? a.map(n => n?.plain_text || "").join("").trim() : "";
function textFrom(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":        return plain(prop.title);
    case "rich_text":    return plain(prop.rich_text);
    case "url":          return prop.url || "";
    case "number":       return (prop.number ?? "") + "";
    case "status":       return prop.status?.name || "";
    case "select":       return prop.select?.name || "";
    case "multi_select": return (prop.multi_select || []).map(o => o.name).join(", ");
    case "date":         return prop.date?.start || "";
    case "formula": {
      const f = prop.formula || {};
      if (f.type === "string") return f.string || "";
      if (f.type === "number") return (f.number ?? "") + "";
      if (f.type === "boolean")return f.boolean ? "true" : "false";
      if (f.type === "date")   return f.date?.start || "";
      return "";
    }
    case "rollup": {
      const r = prop.rollup || {};
      if (r.type === "array")  return (r.array || []).map(v => textFrom(v)).filter(Boolean).join(" ").trim();
      if (r.type === "number") return (r.number ?? "") + "";
      if (r.type === "date")   return r.date?.start || "";
      if (r.type === "string") return r.string || "";
      return "";
    }
    default: return "";
  }
}

async function findArtistByWixId(musicianId) {
  const id = String(musicianId || "").trim();
  const names = ["WixOwnerID","Wix Owner ID","Wix Member ID"];
  for (const p of names) {
    for (const variant of [
      { rich_text: { equals: id } }, { rich_text: { contains: id } },
      { title: { equals: id } },     { title: { contains: id } },
      { formula: { string: { equals: id } } }, { formula: { string: { contains: id } } }
    ]) {
      try {
        const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: { property: p, ...variant } });
        if (r.results?.length) return r.results[0];
      } catch {}
    }
  }
  return null;
}

// CORS
function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "*")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.NOTION_TOKEN || !DB_BOOK || !DB_ART) {
    return res.status(400).json({ error: "Missing envs" });
  }

  try {
    const { musicianId = "", cursor = null, q = "", status = "" } = req.query || {};
    if (!musicianId) return res.status(400).json({ error: "Missing musicianId" });

    const artist = await findArtistByWixId(musicianId);
    if (!artist) return res.status(404).json({ error: "Artist not found by Wix member id", musicianId });

    const db = await notion.databases.retrieve({ database_id: DB_BOOK });

    // Owner (Relation oder Rollup) finden
    let ownerName = null, ownerType = null;
    for (const [name, def] of Object.entries(db.properties || {})) {
      if ((/owner|artist/i.test(name)) && (def.type === "relation" || def.type === "rollup")) { ownerName = name; ownerType = def.type; break; }
    }
    if (!ownerName) {
      for (const [name, def] of Object.entries(db.properties || {})) {
        if (def.type === "relation" || def.type === "rollup") { ownerName = name; ownerType = def.type; break; }
      }
    }

    const statusProp = db.properties?.["Status"];
    const ownerFilter =
      ownerType === "relation"
        ? { property: ownerName, relation: { contains: artist.id } }
        : { property: ownerName, rollup: { any: { relation: { contains: artist.id } } } };

    // Basierend auf Status: Potential/Archiv serverseitig ausschließen
    const andFilters = [];
    const hideVals = ["Potential","Archiv","Archive"];
    if (statusProp?.type === "status") {
      hideVals.forEach(v => andFilters.push({ property: "Status", status: { does_not_equal: v } }));
    } else if (statusProp?.type === "select") {
      hideVals.forEach(v => andFilters.push({ property: "Status", select: { does_not_equal: v } }));
    }

    // Optionaler Status-Filter
    const statusNorm = String(status).trim();
    if (statusNorm) {
      if (statusProp?.type === "status") andFilters.push({ property: "Status", status: { equals: statusNorm } });
      else if (statusProp?.type === "select") andFilters.push({ property: "Status", select: { equals: statusNorm } });
    }

    if (q) andFilters.push({ property: "Gig", title: { contains: String(q) } });

    const params = {
      database_id: DB_BOOK,
      page_size: 50,
      filter: { and: [ownerFilter, ...andFilters] },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
    };
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    const results = [];
    for (const page of (r.results || [])) {
      const gigProp    = P(page, "Gig");
      const statusP    = P(page, "Status");
      const availProp  = P(page, "Artist availability") || P(page, "Availability artist");
      const commProp   = P(page, "Artist comment");
      const joyProp    = P(page, "Joy comment");         // <— NEU
      const summaryRU  = P(page, "WixSummary") || P(page, "Summary");

      const gig = textFrom(gigProp);
      const statusTxt =
        statusP?.type === "status" ? (statusP.status?.name || "") :
        statusP?.type === "select" ? (statusP.select?.name || "") : "";

      const availabilityTxt = textFrom(availProp);
      const comment = textFrom(commProp);
      const joyComment = textFrom(joyProp);
      const summary = textFrom(summaryRU);

      results.push({
        id: page.id,
        gig,
        summary,
        status: statusTxt,
        availability: availabilityTxt,
        comment,
        joyComment,            // <— für #commentjoy
        _summaryVia: "rollup"
      });
    }

    res.json({ results, nextCursor: r.has_more ? r.next_cursor : null, hasMore: !!r.has_more });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: e.body || e.message || String(e) });
  }
}
