// /api/events-test.js
import { Client } from "@notionhq/client";

/** Notion Client (mit neuer Version) */
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: process.env.NOTION_VERSION || "2025-09-03",
});

const DB_BOOK = process.env.BOOKING_DB_ID; // Booking / Stages
const DB_ART  = process.env.ARTISTS_DB_ID; // Artists (nur für Relation-Filter, falls genutzt)

/** CORS */
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

/** Helpers */
const P = (page, key) => page?.properties?.[key] ?? null;
const plain = a => Array.isArray(a) ? a.map(n => n?.plain_text || "").join("").trim() : "";

// Einheitskonverter: macht aus (fast) allen Notion-Property-Typen einen String.
// -> Wichtig: Rollups werden zu lesbarem Text zusammengezogen (wie bei Summary).
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
    case "phone_number": return prop.phone_number || "";
    case "people":       return (prop.people || []).map(p => p?.name || p?.id || "").filter(Boolean).join(", ");
    case "formula": {
      const f = prop.formula || {};
      if (f.type === "string")  return f.string || "";
      if (f.type === "number")  return (f.number ?? "") + "";
      if (f.type === "boolean") return f.boolean ? "true" : "false";
      if (f.type === "date")    return f.date?.start || "";
      return "";
    }
    case "rollup": {
      const r = prop.rollup || {};
      if (r.type === "array" && Array.isArray(r.array)) {
        // Elemente können wiederum Properties sein – rekursiv formatieren
        return r.array.map(v => textFrom(v)).filter(Boolean).join(" ").trim();
      }
      if (r.type === "number") return (r.number ?? "") + "";
      if (r.type === "date")   return r.date?.start || "";
      if (r.type === "string") return r.string || "";
      return "";
    }
    default:
      return "";
  }
}

/** (optional) Artist-Lookup – falls du weiterhin per Owner-Relation filtern willst */
async function findArtistByWixIdFlexible(musicianId) {
  const id = String(musicianId || "").trim();
  if (!id || !DB_ART) return null;
  // sehr tolerante Suche über bekannte Feldnamen/Typen
  const names = ["WixOwnerID","Wix Owner ID","Wix Member ID"];
  for (const name of names) {
    // rich_text / title / formula.string / rollup.any.rich_text
    const filters = [
      { property: name, rich_text: { equals: id } },
      { property: name, rich_text: { contains: id } },
      { property: name, title:     { equals: id } },
      { property: name, title:     { contains: id } },
      { property: name, formula:   { string: { equals: id } } },
      { property: name, formula:   { string: { contains: id } } },
      { property: name, rollup:    { any: { rich_text: { contains: id } } } },
    ];
    for (const f of filters) {
      try {
        const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
        if (r.results?.length) return r.results[0];
      } catch { /* next */ }
    }
  }
  return null;
}

/** Booking-DB: Status + Owner (für Relation-Fallback) */
async function getBookingInfo() {
  const db = await notion.databases.retrieve({ database_id: DB_BOOK });

  // Status-Property (status/select)
  const statusProp = db.properties?.["Status"]
    ? { name: "Status", type: db.properties["Status"].type }
    : null;

  // Owner (Relation/Rollup) – nur falls du über Artists-Relation filtern willst
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

  return { db, statusProp, ownerName, ownerType };
}

/** Handler */
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
    // Wir lassen Query-Parameter wie gehabt zu (musicianId, q, status, cursor),
    // aber der Fokus hier: Rollups als Text zurückgeben.
    const { musicianId = "", cursor = null, q = "", status = "" } = req.query || {};
    const id = String(musicianId || "").trim();

    const { statusProp, ownerName, ownerType } = await getBookingInfo();

    // --- Filter aufsetzen ---
    const andFilters = [];

    // Archiv/Potential ausblenden
    const HIDE = ["Potential","Archiv","Archive"];
    if (statusProp?.type === "status") HIDE.forEach(v => andFilters.push({ property: "Status", status: { does_not_equal: v } }));
    else if (statusProp?.type === "select") HIDE.forEach(v => andFilters.push({ property: "Status", select: { does_not_equal: v } }));

    // optional sichtbarer Status
    const statusNorm = String(status).trim();
    if (statusNorm) {
      if (statusProp?.type === "status") andFilters.push({ property: "Status", status: { equals: statusNorm } });
      else if (statusProp?.type === "select") andFilters.push({ property: "Status", select: { equals: statusNorm } });
    }

    // optional Suche im Titel
    if (q) andFilters.push({ property: "Gig", title: { contains: String(q) } });

    // Falls du weiter über Artist-Relation einschränken willst:
    // (Wenn nicht nötig: ownerFilter einfach weglassen, dann bekommst du alle Einträge)
    let ownerFilter = null;
    if (id && DB_ART && ownerName && ownerType) {
      const artist = await findArtistByWixIdFlexible(id);
      if (artist) {
        ownerFilter =
          ownerType === "relation"
            ? { property: ownerName, relation: { contains: artist.id } }
            : { property: ownerName, rollup: { any: { relation: { contains: artist.id } } } };
      }
    }

    const filter = ownerFilter ? { and: [ownerFilter, ...andFilters] } : (andFilters.length ? { and: andFilters } : undefined);

    const params = {
      database_id: DB_BOOK,
      page_size: 50,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
    };
    if (filter) params.filter = filter;
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // Mapping → WICHTIG: Rollups als Text!
    const results = (r.results || []).map(page => {
      const gig         = textFrom(P(page, "Gig"));
      const statusP     = P(page, "Status");
      const statusTxt   =
        statusP?.type === "status" ? (statusP.status?.name || "") :
        statusP?.type === "select" ? (statusP.select?.name || "") : "";

      const availability = textFrom(P(page, "Artist availability")) || textFrom(P(page, "Availability artist"));
      const comment      = textFrom(P(page, "Artist comment"));
      const joyComment   = textFrom(P(page, "Joy comment"));

      // 👉 Rollups als Text (wie bei Summary):
      const summary      = textFrom(P(page, "WixSummary")) || textFrom(P(page, "Summary"));
      const wixOwnerId   = textFrom(P(page, "WixOwnerID")); // <-- DEIN ROLLUP/FORMULA/TEXT → jetzt sauber zu String

      return {
        id: page.id,
        gig,
        summary,
        wixOwnerId,              // <- kann im Frontend angezeigt werden
        status: statusTxt,
        availability,
        comment,
        joyComment,
        _summaryVia: "rollup"
      };
    });

    res.status(200).json({
      results,
      nextCursor: r.has_more ? r.next_cursor : null,
      hasMore: !!r.has_more
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: e.body || e.message || String(e) });
  }
}
