// /api/events-test.js
import { Client } from "@notionhq/client";

/**
 * Notion Client (neue Version wie von Notion gefordert)
 */
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: process.env.NOTION_VERSION || "2025-09-03",
});

const DB_BOOK = process.env.BOOKING_DB_ID;   // Booking / Stages DB
const DB_ART  = process.env.ARTISTS_DB_ID;   // Artists DB (nur noch Fallback)

/**
 * CORS
 */
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

/**
 * Helpers
 */
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

/**
 * (Fallback) Artist anhand WixOwnerID in Artists-DB suchen
 * – bleibt als Rückfallebene erhalten, falls Booking-DB kein WixOwnerID-Feld hätte
 */
async function findArtistByWixId(musicianId) {
  const id = String(musicianId || "").trim();
  if (!id || !DB_ART) return null;
  const props = ["WixOwnerID", "Wix Owner ID", "Wix Member ID"];

  // equals
  for (const p of props) {
    try {
      const r = await notion.databases.query({
        database_id: DB_ART,
        page_size: 1,
        filter: { property: p, rich_text: { equals: id } }
      });
      if (r.results?.length) return r.results[0];
    } catch {}
  }
  // contains
  for (const p of props) {
    try {
      const r = await notion.databases.query({
        database_id: DB_ART,
        page_size: 1,
        filter: { property: p, rich_text: { contains: id } }
      });
      if (r.results?.length) return r.results[0];
    } catch {}
  }
  return null;
}

/**
 * Booking-DB Struktur
 */
async function getBookingInfo() {
  const db = await notion.databases.retrieve({ database_id: DB_BOOK });

  // Status-Property (status/select)
  const statusProp = db.properties?.["Status"] ? { name: "Status", type: db.properties["Status"].type } : null;

  // Owner-Prop (Relation/Rollup) – optional, nur für Fallback
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

  // WICHTIG: direktes Feld "WixOwnerID" in der Booking-DB (Name exakt so)
  const wixOwnerDef = db.properties?.["WixOwnerID"] || null; // kann rich_text / formula / rollup / title sein

  return { db, statusProp, ownerName, ownerType, wixOwnerDef };
}

/**
 * Filter-Bausteine je nach Typ der Booking-DB-Property "WixOwnerID"
 */
function buildDirectIdFilter(wixOwnerDef, id) {
  if (!wixOwnerDef) return null;

  // Wir versuchen möglichst breit gefächert, aber typ-korrekt zu filtern:
  switch (wixOwnerDef.type) {
    case "title":
      return { property: "WixOwnerID", title: { contains: id } };
    case "rich_text":
      return { property: "WixOwnerID", rich_text: { contains: id } };
    case "select":
      return { property: "WixOwnerID", select: { equals: id } };
    case "status":
      return { property: "WixOwnerID", status: { equals: id } };
    case "formula":
      // Notion unterstützt Filter auf formula.string
      return { property: "WixOwnerID", formula: { string: { contains: id } } };
    case "rollup":
      // Rollup kann Array/String sein – wir versuchen es über "any.rich_text.contains"
      return { property: "WixOwnerID", rollup: { any: { rich_text: { contains: id } } } };
    default:
      // fallback (eher generisch, Notion wird ungültige Typen ablehnen – aber harmlose Rückfallebene)
      return { property: "WixOwnerID", rich_text: { contains: id } };
  }
}

/**
 * Handler
 */
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

    // Booking-DB lesen
    const { db, statusProp, ownerName, ownerType, wixOwnerDef } = await getBookingInfo();

    // --- Primär: direkt in Booking-DB auf "WixOwnerID" filtern ---
    let ownerFilter = null;
    const directFilter = buildDirectIdFilter(wixOwnerDef, id);

    // --- Fallback: wenn kein direktes WixOwnerID-Feld vorhanden oder Filter nicht möglich,
    // dann Artist via Artists-DB suchen und per Relation/Rollup filtern (wie früher)
    if (!directFilter && ownerName && ownerType && DB_ART) {
      const artist = await findArtistByWixId(id);
      if (artist) {
        ownerFilter =
          ownerType === "relation"
            ? { property: ownerName, relation: { contains: artist.id } }
            : { property: ownerName, rollup: { any: { relation: { contains: artist.id } } } };
      }
    }

    if (!directFilter && !ownerFilter) {
      return res.status(404).json({
        error: "Neither direct WixOwnerID filter nor owner-relation fallback available.",
        musicianId: id,
        hint: "Ensure Booking DB has a 'WixOwnerID' property (text/rollup/formula/title) OR share Artists DB with integration."
      });
    }

    // --- HIDE: Potential/Archiv/Archive ausblenden ---
    const HIDE = ["Potential", "Archiv", "Archive"];
    const andFilters = [];
    if (statusProp?.type === "status") HIDE.forEach(v => andFilters.push({ property: "Status", status: { does_not_equal: v } }));
    else if (statusProp?.type === "select") HIDE.forEach(v => andFilters.push({ property: "Status", select: { does_not_equal: v } }));

    // optional: Status (sichtbare)
    const statusNorm = String(status).trim();
    if (statusNorm) {
      if (statusProp?.type === "status") andFilters.push({ property: "Status", status: { equals: statusNorm } });
      else if (statusProp?.type === "select") andFilters.push({ property: "Status", select: { equals: statusNorm } });
    }

    // optional: Suche im Titel
    if (q) andFilters.push({ property: "Gig", title: { contains: String(q) } });

    // finaler Filter
    const baseFilter = directFilter ? directFilter : ownerFilter;
    const filter = { and: [baseFilter, ...andFilters] };

    const params = {
      database_id: DB_BOOK,
      page_size: 50,
      filter,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
    };
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // Mapping Notion → Frontend
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
        gig,
        summary,
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
      _via: directFilter ? "booking.wixownerid" : "owner.relation.fallback"
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: e.body || e.message || String(e) });
  }
}
