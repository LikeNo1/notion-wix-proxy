// /api/events-test.js
import { Client } from "@notionhq/client";

// ---------- Notion Client ----------
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: process.env.NOTION_VERSION || "2025-09-03",
});

const DB_BOOK = process.env.BOOKING_DB_ID;
const DB_ART  = process.env.ARTISTS_DB_ID; // optional (nur Fallback)

// ---------- CORS ----------
function setCors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "*")
    .split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes("*") || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
}

// ---------- Helpers ----------
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
    case "email":        return prop.email || "";
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

// (Optionale) Artists-Fallbacksuche – nur falls wir in der Booking-DB gar nicht auf WixOwnerID filtern können
async function findArtistByWixId(musicianId) {
  const id = String(musicianId || "").trim();
  if (!id || !DB_ART) return null;
  const props = ["WixOwnerID"];

  for (const p of props) {
    try {
      const eq = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: { property: p, rich_text: { equals: id } }});
      if (eq.results?.length) return eq.results[0];
    } catch {}
  }
  for (const p of props) {
    try {
      const ct = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: { property: p, rich_text: { contains: id } }});
      if (ct.results?.length) return ct.results[0];
    } catch {}
  }
  return null;
}

// Booking-DB lesen
async function getBookingInfo() {
  const db = await notion.databases.retrieve({ database_id: DB_BOOK });
  const statusProp = db.properties?.["Status"] ? { name: "Status", type: db.properties["Status"].type } : null;

  // Owner-Kandidaten (Relation/Rollup) – nur für Fallback
  let ownerName = null, ownerType = null;
  for (const [name, def] of Object.entries(db.properties || {})) {
    if ((/owner|artist/i).test(name) && (def.type === "relation" || def.type === "rollup")) {
      ownerName = name; ownerType = def.type; break;
    }
  }
  if (!ownerName) {
    for (const [name, def] of Object.entries(db.properties || {})) {
      if (def.type === "relation" || def.type === "rollup") { ownerName = name; ownerType = def.type; break; }
    }
  }

  // Wichtig: das Feld "WixOwnerID" (egal welcher Typ)
  const wixOwnerDef = db.properties?.["WixOwnerID"] || null;

  return { db, statusProp, ownerName, ownerType, wixOwnerDef };
}

// —— Kern: Filter-Detektion ——
// Wir probieren mehrere gültige Filtervarianten auf "WixOwnerID" aus,
// die erste erfolgreiche (keine 400/validation error) wird benutzt.
async function detectIdFilter(id) {
  const candidates = [
    { property: "WixOwnerID", title:      { contains: id } },
    { property: "WixOwnerID", rich_text:  { contains: id } },
    { property: "WixOwnerID", select:     { equals:   id } },
    { property: "WixOwnerID", status:     { equals:   id } },
    { property: "WixOwnerID", formula:    { string: { contains: id } } },
    { property: "WixOwnerID", rollup:     { any: { rich_text: { contains: id } } } },
    // zusätzliche Versuche für exotische Rollups (string)
    { property: "WixOwnerID", rollup:     { any: { title:     { contains: id } } } },
    { property: "WixOwnerID", rollup:     { any: { formula:   { string: { contains: id } } } } }
  ];

  for (const cand of candidates) {
    try {
      const r = await notion.databases.query({
        database_id: DB_BOOK,
        page_size: 1,
        filter: cand
      });
      // Wenn Notion keinen Typfehler wirft, akzeptieren wir diese Filterform
      return cand;
    } catch (e) {
      // invalid filter → weiterprobieren
      continue;
    }
  }
  return null;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.NOTION_TOKEN || !DB_BOOK) {
    return res.status(400).json({
      error: "Missing envs",
      haveToken: !!process.env.NOTION_TOKEN,
      haveBook: !!DB_BOOK,
      haveArt: !!DB_ART
    });
  }

  try {
    const { musicianId = "", cursor = null, q = "", status = "" } = req.query || {};
    const id = String(musicianId || "").trim();
    if (!id) return res.status(400).json({ error: "Missing musicianId" });

    const { statusProp, ownerName, ownerType, wixOwnerDef } = await getBookingInfo();

    // 1) Primär: Versuche, in Booking-DB direkt auf "WixOwnerID" zu filtern (egal welcher Typ)
    let idFilter = null;
    if (wixOwnerDef) {
      idFilter = await detectIdFilter(id);
    }

    // 2) Fallback: Artist in Artists-DB suchen und über Owner-Relation filtern
    let ownerFilter = null;
    if (!idFilter && ownerName && ownerType && DB_ART) {
      const artist = await findArtistByWixId(id);
      if (artist) {
        ownerFilter =
          ownerType === "relation"
            ? { property: ownerName, relation: { contains: artist.id } }
            : { property: ownerName, rollup: { any: { relation: { contains: artist.id } } } };
      }
    }

    if (!idFilter && !ownerFilter) {
      return res.status(404).json({
        error: "Neither direct WixOwnerID filter nor owner-relation fallback available.",
        musicianId: id,
        hint: "Check: Booking DB has 'WixOwnerID' and integration permissions; or share Artists DB with the integration."
      });
    }

    // Status-Hiding & optionale Filter
    const andFilters = [];
    const HIDE = ["Potential","Archiv","Archive"];
    if (statusProp?.type === "status") HIDE.forEach(v => andFilters.push({ property: "Status", status: { does_not_equal: v } }));
    else if (statusProp?.type === "select") HIDE.forEach(v => andFilters.push({ property: "Status", select: { does_not_equal: v } }));

    const statusNorm = String(status).trim();
    if (statusNorm) {
      if (statusProp?.type === "status") andFilters.push({ property: "Status", status: { equals: statusNorm } });
      else if (statusProp?.type === "select") andFilters.push({ property: "Status", select: { equals: statusNorm } });
    }
    if (q) andFilters.push({ property: "Gig", title: { contains: String(q) } });

    const baseFilter = idFilter ? idFilter : ownerFilter;
    const filter = { and: [baseFilter, ...andFilters] };

    const params = {
      database_id: DB_BOOK,
      page_size: 50,
      filter,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
    };
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // Mapping
    const results = [];
    for (const page of (r.results || [])) {
      const gig         = textFrom(P(page, "Gig"));
      const statusP     = P(page, "Status");
      const statusTxt   =
        statusP?.type === "status" ? (statusP.status?.name || "") :
        statusP?.type === "select" ? (statusP.select?.name || "") : "";

      const availability = textFrom(P(page, "Artist availability")) || textFrom(P(page, "Availability artist"));
      const comment      = textFrom(P(page, "Artist comment"));
      const joyComment   = textFrom(P(page, "Joy comment"));
      const summary      = textFrom(P(page, "WixSummary")) || textFrom(P(page, "Summary"));

      results.push({
        id: page.id,
        gig, summary,
        status: statusTxt,
        availability,
        comment,
        joyComment,
        _summaryVia: "rollup"
      });
    }

    res.status(200).json({
      results,
      nextCursor: r.has_more ? r.next_cursor : null,
      hasMore: !!r.has_more,
      _via: idFilter ? "booking.wixownerid.detected" : "owner.relation.fallback"
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: e.body || e.message || String(e) });
  }
}
