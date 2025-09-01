// /api/events.js  — robuste Variante: Summary wird serverseitig aus Event-Feldern gebaut
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BOOK = process.env.BOOKING_DB_ID;
const DB_ART  = process.env.ARTISTS_DB_ID;

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
const bad = (res, msg, details) => res.status(400).json({ error: msg, details });

const P = (page, key) => page?.properties?.[key] ?? null;
const plain = a => Array.isArray(a) ? a.map(n => n?.plain_text || "").join("").trim() : "";

function textFrom(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":        return plain(prop.title);
    case "rich_text":    return plain(prop.rich_text);
    case "url":          return prop.url || "";
    case "email":        return prop.email || "";
    case "phone_number": return prop.phone_number || "";
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
      if (r.type === "array" && Array.isArray(r.array)) {
        return r.array.map(v => textFrom(v)).filter(Boolean).join(" ").trim();
      }
      if (r.type === "number") return (r.number ?? "") + "";
      if (r.type === "date")   return r.date?.start || "";
      if (r.type === "string") return r.string || "";
      return "";
    }
    default: return "";
  }
}

function readAny(page, names) {
  for (const n of names) {
    const v = textFrom(P(page, n));
    if (v) return v;
  }
  return "";
}

async function findArtistByWixId(musicianId) {
  const id = String(musicianId || "").trim();
  const names = ["WixOwnerID", "Wix Owner ID", "Wix Member ID"];
  const filters = [];
  for (const p of names) {
    filters.push({ property: p, rich_text: { equals: id } });
    filters.push({ property: p, rich_text: { contains: id } });
    filters.push({ property: p, title:     { equals: id } });
    filters.push({ property: p, title:     { contains: id } });
    filters.push({ property: p, formula:   { string: { equals: id } } });
    filters.push({ property: p, formula:   { string: { contains: id } } });
  }
  for (const f of filters) {
    try {
      const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
      if (r.results?.length) return r.results[0];
    } catch {}
  }
  return null;
}

async function getBookingInfo() {
  const db = await notion.databases.retrieve({ database_id: DB_BOOK });

  let ownerName = null, ownerType = null;
  for (const [name, def] of Object.entries(db.properties || {})) {
    if ((/owner|artist/i.test(name)) && (def.type === "relation" || def.type === "rollup")) {
      ownerName = name; ownerType = def.type; break;
    }
  }
  if (!ownerName) {
    for (const [name, def] of Object.entries(db.properties || {})) {
      if (def.type === "relation" || def.type === "rollup") { ownerName = name; ownerType = def.type; break; }
    }
  }

  const statusProp = db.properties?.["Status"]
    ? { name: "Status", type: db.properties["Status"].type }
    : { name: null, type: null };

  const availName = db.properties?.["Artist availability"]
    ? "Artist availability"
    : (db.properties?.["Availability artist"] ? "Availability artist" : null);
  const availType = availName ? db.properties[availName].type : null;

  // Event-Relation Kandidaten (Name enthält "event" oder "gig")
  const eventRelationCandidates = Object.entries(db.properties || {})
    .filter(([name, def]) => def.type === "relation" && (/event|gig/i.test(name)))
    .map(([name]) => name);

  return { ownerName, ownerType, statusProp, availName, availType, eventRelationCandidates };
}

function pickEventRelationName(page, ownerName, candidates) {
  for (const c of candidates || []) {
    const v = P(page, c);
    if (v?.type === "relation" && Array.isArray(v.relation) && v.relation.length) return c;
  }
  // Heuristik: eine Relation ≠ Owner, die Werte hat
  for (const [name, prop] of Object.entries(page.properties || {})) {
    if (name === ownerName) continue;
    if (prop?.type === "relation" && Array.isArray(prop.relation) && prop.relation.length) return name;
  }
  return null;
}

const pageCache = new Map();
async function getPage(id) {
  if (pageCache.has(id)) return pageCache.get(id);
  const pg = await notion.pages.retrieve({ page_id: id });
  pageCache.set(id, pg);
  return pg;
}

function composeSummaryFromEvent(evtPage) {
  // liest direkt die Event-Felder (egal ob select/rich_text/rollup/whatever)
  const date      = readAny(evtPage, ["Date + Time", "Date", "Datetime", "Date/Time"]);
  const country   = readAny(evtPage, ["Country"]);
  const statede   = readAny(evtPage, ["Bundesland (nur DE)"]);
  const location  = readAny(evtPage, ["Location", "City"]);
  const website   = readAny(evtPage, ["Website", "Web", "URL"]);
  const instagram = readAny(evtPage, ["Instagram", "IG"]);
  const facebook  = readAny(evtPage, ["Facebook", "FB"]);
  const shortD    = readAny(evtPage, ["Short description", "Short Description"]);
  const vibe      = readAny(evtPage, ["Vibe/Notes", "Vibe", "Notes"]);

  const lines = [];
  lines.push(`📅 Datum/Zeit: ${date || "noch zu terminieren"}`);
  lines.push(`🗺️ Location: ${[country, statede, location].filter(Boolean).join("/") || "/"}`);
  {
    const links = [website, instagram, facebook].filter(Boolean).join(" ").trim();
    lines.push(`🔗 Link: ${links}`);
  }
  lines.push(`📃 Beschreibung und Vibe:`);
  if (shortD) lines.push(shortD);
  if (vibe)   lines.push(vibe);

  return lines.join("\n").trim();
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const missing = [];
  if (!process.env.NOTION_TOKEN) missing.push("NOTION_TOKEN");
  if (!DB_BOOK) missing.push("BOOKING_DB_ID");
  if (!DB_ART)  missing.push("ARTISTS_DB_ID");
  if (missing.length) return bad(res, "Missing required values", missing);

  try {
    const {
      musicianId = "",
      cursor = null,
      q = "",
      sort = "gig_asc",
      availability = "all",
      status = "all",
      debug = "0"
    } = req.query || {};
    if (!musicianId) return bad(res, "Missing musicianId");

    // 1) Artist
    const artist = await findArtistByWixId(musicianId);
    if (!artist) return res.status(404).json({ error: "Artist not found by Wix member id", musicianId });

    // 2) Booking-DB Struktur
    const info = await getBookingInfo();
    if (!info.ownerName || !info.ownerType)
      return bad(res, "Owner relation/rollup not found in Booking DB", info);

    // 3) Filter bauen
    const ownerFilter =
      info.ownerType === "relation"
        ? { property: info.ownerName, relation: { contains: artist.id } }
        : { property: info.ownerName, rollup: { any: { relation: { contains: artist.id } } } };

    const andFilters = [];

    // Status ≠ Potential (wenn vorhanden)
    if (info.statusProp.name) {
      if (info.statusProp.type === "status")
        andFilters.push({ property: "Status", status: { does_not_equal: "Potential" } });
      else if (info.statusProp.type === "select")
        andFilters.push({ property: "Status", select: { does_not_equal: "Potential" } });
    }

    // optional Status-Filter
    const statusNorm = String(status).trim();
    if (info.statusProp.name && statusNorm && statusNorm.toLowerCase() !== "all") {
      if (info.statusProp.type === "status")
        andFilters.push({ property: "Status", status: { equals: statusNorm } });
      else if (info.statusProp.type === "select")
        andFilters.push({ property: "Status", select: { equals: statusNorm } });
    }

    // optional Availability
    const availNorm = String(availability || "").trim().toLowerCase();
    if (info.availName && availNorm && availNorm !== "all") {
      const name = availNorm === "yes" ? "Yes" : availNorm === "no" ? "No" : availNorm === "other" ? "Other" : "";
      if (name) {
        if (info.availType === "select")        andFilters.push({ property: info.availName, select: { equals: name } });
        else if (info.availType === "rich_text") andFilters.push({ property: info.availName, rich_text: { equals: name } });
        else if (info.availType === "formula")   andFilters.push({ property: info.availName, formula: { string: { equals: name } } });
        else if (info.availType === "rollup")    andFilters.push({ property: info.availName, rollup: { any: { rich_text: { equals: name } } } });
      }
    }

    if (q) andFilters.push({ property: "Gig", title: { contains: String(q) } });

    const sorts =
      sort === "gig_desc" ? [{ property: "Gig", direction: "descending" }] :
      sort === "gig_asc"  ? [{ property: "Gig", direction: "ascending"  }] :
                            [{ timestamp: "last_edited_time", direction: "descending" }];

    // 4) Query Booking
    const r = await notion.databases.query({
      database_id: DB_BOOK,
      page_size: 30,
      start_cursor: cursor || undefined,
      filter: { and: [ownerFilter, ...andFilters] },
      sorts
    });

    // 5) Mapping – Summary immer aus Event-Feldern zusammensetzen
    const results = [];
    for (const page of (r.results || [])) {
      const gigProp    = P(page, "Gig");
      const statusProp = P(page, "Status");
      const availProp  = P(page, "Artist availability") || P(page, "Availability artist");
      const commProp   = P(page, "Artist comment");

      const gig =
        gigProp?.type === "title" ? plain(gigProp.title) :
        gigProp?.type === "rich_text" ? plain(gigProp.rich_text) : "";

      const statusTxt =
        statusProp?.type === "status" ? (statusProp.status?.name || "") :
        statusProp?.type === "select" ? (statusProp.select?.name || "") : "";

      const availabilityTxt = textFrom(availProp);
      const comment =
        commProp?.type === "rich_text" ? plain(commProp.rich_text) :
        commProp?.type === "title" ? plain(commProp.title) : "";

      // Event-Relation finden
      const eventRelName = pickEventRelationName(page, info.ownerName, info.eventRelationCandidates);

      let summary = "";
      let summaryVia = "";

      if (eventRelName) {
        const rel = P(page, eventRelName);
        if (rel?.type === "relation" && Array.isArray(rel.relation) && rel.relation.length) {
          const evtId = rel.relation[0]?.id;
          if (evtId) {
            try {
              const evtPage = await getPage(evtId);
              summary = composeSummaryFromEvent(evtPage); // **hier wird gebaut**
              if (summary) summaryVia = `event:${eventRelName}`;
            } catch (e) {
              // ignorieren – fällt auf Fallbacks zurück
            }
          }
        }
      }

      if (!summary) {
        // extrem defensiver Fallback (immer etwas anzeigen)
        summary = "📅 Datum/Zeit: noch zu terminieren\n🗺️ Location: /\n🔗 Link:  \n📃 Beschreibung und Vibe:";
        summaryVia = "fallback";
      }

      results.push({
        id: page.id,
        gig,
        summary,
        status: statusTxt,
        availability: availabilityTxt,
        comment,
        _summaryVia: summaryVia
      });
    }

    res.json({
      results,
      nextCursor: r.has_more ? r.next_cursor : null,
      hasMore: !!r.has_more
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: e.body || e.message || String(e) });
  }
}
