// /api/events-test.js
import { Client } from "@notionhq/client";

/* ---------- ID helpers ---------- */
function toDashed(uuidLike) {
  const hex = String(uuidLike || "").trim().replace(/[^a-f0-9]/gi, "");
  if (hex.length < 32) return null;
  const core = hex.slice(0, 32).toLowerCase();
  return `${core.slice(0,8)}-${core.slice(8,12)}-${core.slice(12,16)}-${core.slice(16,20)}-${core.slice(20)}`;
}
function toRaw32(uuidLike) {
  const hex = String(uuidLike || "").trim().replace(/[^a-f0-9]/gi, "");
  return hex.length >= 32 ? hex.slice(0,32).toLowerCase() : null;
}

/* ---------- CORS ---------- */
function cors(res, req) {
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

/* ---------- Notion client (Version nur verwenden, wenn gültiges Datum) ---------- */
const versionEnv = String(process.env.NOTION_VERSION || "").trim();
const looksLikeDate = /^\d{4}-\d{2}-\d{2}$/.test(versionEnv);
const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  ...(looksLikeDate ? { notionVersion: versionEnv } : {})
});

/* ---------- Notion helpers ---------- */
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
      if (r.type === "array")  return (r.array || []).map(v => textFrom(v)).filter(Boolean).join(" ").trim();
      if (r.type === "number") return (r.number ?? "") + "";
      if (r.type === "date")   return r.date?.start || "";
      if (r.type === "string") return r.string || "";
      return "";
    }
    default: return "";
  }
}

/* ---------- DB retrieve (mit ID-Fallback) ---------- */
async function retrieveDbWithFallback(rawId) {
  const dashed = toDashed(rawId);
  const raw32  = toRaw32(rawId);
  if (!raw32) {
    const e = new Error("BOOKING_DB_ID / ARTISTS_DB_ID invalid or missing"); e.status = 400; throw e;
  }
  try {
    const db = await notion.databases.retrieve({ database_id: dashed || raw32 });
    return { db, idUsed: dashed || raw32 };
  } catch {
    const db = await notion.databases.retrieve({ database_id: raw32 });
    return { db, idUsed: raw32 };
  }
}

/* ---------- Artist in ARTISTS_DB by WixOwnerID (robust, sequenziell) ---------- */
async function findArtistByWixOwnerId(artistsDbId, musicianId) {
  const id = String(musicianId || "").trim();
  if (!id) return null;

  // Wir probieren mehrere konkrete Filter nacheinander (je 1 Anfrage) – stabiler als Mega-OR:
  const propsToTry = ["WixOwnerID", "Wix Owner ID", "Wix Member ID"];
  const patterns = [
    // rich_text
    (name) => ({ property: name, rich_text: { equals: id } }),
    (name) => ({ property: name, rich_text: { contains: id } }),
    // title
    (name) => ({ property: name, title: { equals: id } }),
    (name) => ({ property: name, title: { contains: id } }),
    // formula.string
    (name) => ({ property: name, formula: { string: { equals: id } } }),
    (name) => ({ property: name, formula: { string: { contains: id } } }),
    // rollup.any.rich_text / title / formula.string  → einzelne Versuche
    (name) => ({ property: name, rollup: { any: { rich_text: { equals: id } } } }),
    (name) => ({ property: name, rollup: { any: { rich_text: { contains: id } } } }),
    (name) => ({ property: name, rollup: { any: { title:     { equals: id } } } }),
    (name) => ({ property: name, rollup: { any: { title:     { contains: id } } } }),
    (name) => ({ property: name, rollup: { any: { formula:   { string: { equals: id } } } } }),
    (name) => ({ property: name, rollup: { any: { formula:   { string: { contains: id } } } } }),
  ];

  for (const propName of propsToTry) {
    for (const build of patterns) {
      const filter = build(propName);
      try {
        const r = await notion.databases.query({ database_id: artistsDbId, page_size: 1, filter });
        if (r.results?.length) return r.results[0];
      } catch {
        // Ignorieren – manche Pattern passen nicht zum Property-Typ; wir probieren die nächste Variante
      }
    }
  }

  // letzter Fallback: sample + clientseitiger Vergleich
  try {
    const r = await notion.databases.query({ database_id: artistsDbId, page_size: 50 });
    const want = id.toLowerCase();
    for (const pg of (r.results || [])) {
      for (const name of propsToTry) {
        const val = (textFrom(P(pg, name)) || "").toLowerCase();
        if (val && (val === want || val.includes(want))) return pg;
      }
    }
  } catch {}

  return null;
}

/* ---------- Booking-Owner Property bestimmen (Relation / Rollup) ---------- */
function findOwnerPropInBooking(db) {
  if (!db?.properties) return null;
  for (const [name, def] of Object.entries(db.properties)) {
    if ((/owner|artist/i).test(name) && (def.type === "relation" || def.type === "rollup")) {
      return { name, type: def.type };
    }
  }
  // Fallback: die erste Relation/Rollup überhaupt
  for (const [name, def] of Object.entries(db.properties)) {
    if (def.type === "relation" || def.type === "rollup") return { name, type: def.type };
  }
  return null;
}

/* ---------- Basis-Filter (Archiv/Potential weg + optional Status/Suche) ---------- */
function buildBaseFilters(statusProp, q, status) {
  const HIDE = ["Potential","Archiv","Archive"];
  const andFilters = [];
  if (statusProp?.type === "status") HIDE.forEach(v => andFilters.push({ property: "Status", status: { does_not_equal: v } }));
  else if (statusProp?.type === "select") HIDE.forEach(v => andFilters.push({ property: "Status", select: { does_not_equal: v } }));

  const sNorm = String(status || "").trim();
  if (sNorm) {
    if (statusProp?.type === "status") andFilters.push({ property: "Status", status: { equals: sNorm } });
    else if (statusProp?.type === "select") andFilters.push({ property: "Status", select: { equals: sNorm } });
  }
  if (q) andFilters.push({ property: "Gig", title: { contains: String(q) } });
  return andFilters;
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.NOTION_TOKEN) return res.status(400).json({ error: "Bad request", details: "NOTION_TOKEN missing" });
  if (!process.env.BOOKING_DB_ID) return res.status(400).json({ error: "Bad request", details: "BOOKING_DB_ID missing" });

  try {
    const { cursor = null, q = "", status = "", musicianId = "" } = req.query || {};

    // 1) Booking-DB + Schema
    const { db: bookingDb } = await retrieveDbWithFallback(process.env.BOOKING_DB_ID);
    const statusProp = bookingDb.properties?.["Status"]
      ? { name: "Status", type: bookingDb.properties["Status"].type }
      : null;
    const ownerProp = findOwnerPropInBooking(bookingDb); // { name, type } oder null

    // 2) Basis-Filter
    const andFilters = buildBaseFilters(statusProp, q, status);

    // 3) Falls musicianId vorhanden → Artist in ARTISTS_DB suchen und Owner-Relation filtern
    if (musicianId && process.env.ARTISTS_DB_ID && ownerProp) {
      try {
        const { db: artistsDb } = await retrieveDbWithFallback(process.env.ARTISTS_DB_ID);
        const artist = await findArtistByWixOwnerId(artistsDb.id, musicianId);
        if (artist) {
          const relFilter =
            ownerProp.type === "relation"
              ? { property: ownerProp.name, relation: { contains: artist.id } }
              : { property: ownerProp.name, rollup: { any: { relation: { contains: artist.id } } } };
          andFilters.unshift(relFilter);
        }
      } catch {
        // Wenn Artists-Filter nicht klappt, zeigen wir lieber alle (nicht-archivierten) Gigs,
        // statt mit 4xx/5xx abzubrechen – genau wie besprochen.
      }
    }

    const params = {
      database_id: toDashed(process.env.BOOKING_DB_ID) || toRaw32(process.env.BOOKING_DB_ID),
      page_size: 50,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      ...(andFilters.length ? { filter: { and: andFilters } } : {})
    };
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // 4) Mapping
    const results = (r.results || []).map(page => {
      const gig         = textFrom(P(page, "Gig"));
      const statusP     = P(page, "Status");
      const statusTxt   =
        statusP?.type === "status" ? (statusP.status?.name || "") :
        statusP?.type === "select" ? (statusP.select?.name || "") : "";
      const availability = textFrom(P(page, "Artist availability")) || textFrom(P(page, "Availability artist"));
      const comment      = textFrom(P(page, "Artist comment"));
      const joyComment   = textFrom(P(page, "Joy comment"));
      const summary      = textFrom(P(page, "WixSummary")) || textFrom(P(page, "Summary"));
      const wixOwnerId   = textFrom(P(page, "WixOwnerID"));

      return { id: page.id, gig, summary, wixOwnerId, status: statusTxt, availability, comment, joyComment };
    });

    res.status(200).json({
      results,
      nextCursor: r.has_more ? r.next_cursor : null,
      hasMore: !!r.has_more
    });
  } catch (e) {
    res.status(400).json({
      error: "Bad request",
      details: e?.message || String(e)
    });
  }
}
