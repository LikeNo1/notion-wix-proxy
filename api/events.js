// /api/events.js – holt Summary direkt aus der verknüpften Event-Seite, wenn Formula/ Rollups leer wirken
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
function bad(res, msg, details) { return res.status(400).json({ error: msg, details }); }

const P = (page, key) => page?.properties?.[key] ?? null;
const plain = a => Array.isArray(a) ? a.map(n => n?.plain_text || "").join("").trim() : "";

// --------- Notion value helpers ---------
function textFrom(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":       return plain(prop.title);
    case "rich_text":   return plain(prop.rich_text);
    case "url":         return prop.url || "";
    case "email":       return prop.email || "";
    case "phone_number":return prop.phone_number || "";
    case "number":      return (prop.number ?? "") + "";
    case "status":      return prop.status?.name || "";
    case "select":      return prop.select?.name || "";
    case "multi_select":return (prop.multi_select || []).map(o => o.name).join(", ");
    case "date":        return prop.date?.start || "";
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
      return "";
    }
    default: return "";
  }
}

// liest einen Satz typischer Namen robust (z. B. "Short description" vs "Short Description")
function readAny(ev, names) {
  for (const n of names) {
    const p = ev.properties?.[n];
    const v = textFrom(p);
    if (v) return v;
  }
  return "";
}

// Summary direkt aus Event-Seite aufbauen
async function buildSummaryFromEventPage(eventPage) {
  if (!eventPage) return "";

  const date = readAny(eventPage, [
    process.env.EVENT_PROP_DATE || "Date + Time",
    "Date", "Datetime", "Date/Time"
  ]);
  const country = readAny(eventPage, [ "Country" ]);
  const location = readAny(eventPage, [ "Location", "City" ]);
  const website = readAny(eventPage, [ "Website", "Web", "URL" ]);
  const instagram = readAny(eventPage, [ "Instagram", "IG" ]);
  const facebook = readAny(eventPage, [ "Facebook", "FB" ]);
  const shortDesc = readAny(eventPage, [ "Short description", "Short Description" ]);
  const vibe = readAny(eventPage, [ "Vibe/Notes", "Vibe", "Notes" ]);

  const lines = [];
  lines.push(`📅 Datum/Zeit: ${date || "noch zu terminieren"}`);
  lines.push(`🗺️ Location: ${[country, location].filter(Boolean).join("/") || "/"}`);
  lines.push(`🔗 Link: ${[website, instagram, facebook].filter(Boolean).join(" ") || ""}`.trim());
  lines.push(`📃 Beschreibung und Vibe:${(shortDesc || vibe) ? "" : ""}`);
  if (shortDesc) lines.push(shortDesc);
  if (vibe)      lines.push(vibe);

  return lines.join("\n").trim();
}

// eine Event-Seite aus beliebigen Relations (außer Owner/Artist) holen
function firstEventRelationName(dbProps, ownerName) {
  // bevorzugt Namen mit Event/Gig
  const rels = Object.entries(dbProps || {})
    .filter(([n, d]) => d?.type === "relation" && n !== ownerName)
    .map(([n]) => n);

  let pick = rels.find(n => /event|gig/i.test(n));
  if (!pick) pick = rels[0] || null;
  return pick;
}

async function findArtistByWixId(musicianId) {
  const id = String(musicianId).trim();
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
  // Owner/Artist Relation/Rollup
  let ownerName = null, ownerType = null;
  for (const [name, def] of Object.entries(db.properties || {})) {
    if ((/owner|artist/i.test(name)) && (def.type === "relation" || def.type === "rollup")) {
      ownerName = name; ownerType = def.type; break;
    }
  }
  if (!ownerName) {
    // fallback: erstes relation/rollup nehmen
    for (const [name, def] of Object.entries(db.properties || {})) {
      if (def.type === "relation" || def.type === "rollup") { ownerName = name; ownerType = def.type; break; }
    }
  }
  const eventRelName = firstEventRelationName(db.properties, ownerName);
  const statusProp = db.properties?.["Status"] ? { name: "Status", type: db.properties["Status"].type } : { name: null, type: null };
  const availName = db.properties?.["Artist availability"] ? "Artist availability" :
                    (db.properties?.["Availability artist"] ? "Availability artist" : null);
  const availType = availName ? db.properties[availName].type : null;
  return { db, ownerName, ownerType, eventRelName, statusProp, availName, availType };
}

function looksEmptySummary(s) {
  if (!s) return true;
  const template = "📅 Datum/Zeit: noch zu terminieren\n🗺️ Location: /\n🔗 Link:   \n📃 Beschreibung und Vibe:";
  if (s.trim() === template) return true;
  return s.replace(/\s+/g, "").length < 15;
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
      includePotential = "0",
      debug = "0",
    } = req.query || {};
    if (!musicianId) return bad(res, "Missing musicianId");

    const artist = await findArtistByWixId(musicianId);
    if (!artist) return res.status(404).json({ error: "Artist not found by Wix member id", musicianId });

    const info = await getBookingInfo();
    if (!info.ownerName || !info.ownerType) return bad(res, "Owner relation/rollup not found in Booking DB");

    // Owner-Filter
    const ownerFilter =
      info.ownerType === "relation"
        ? { property: info.ownerName, relation: { contains: artist.id } }
        : { property: info.ownerName, rollup: { any: { relation: { contains: artist.id } } } };

    // weitere Filter
    const andFilters = [];
    if (info.statusProp.name && String(includePotential) !== "1") {
      if (info.statusProp.type === "status") andFilters.push({ property: "Status", status: { does_not_equal: "Potential" } });
      else if (info.statusProp.type === "select") andFilters.push({ property: "Status", select: { does_not_equal: "Potential" } });
    }
    const statusNorm = String(status).trim().toLowerCase();
    if (info.statusProp.name && statusNorm && statusNorm !== "all") {
      if (info.statusProp.type === "status") andFilters.push({ property: "Status", status: { equals: status } });
      else if (info.statusProp.type === "select") andFilters.push({ property: "Status", select: { equals: status } });
    }
    const availNorm = String(availability || "").trim().toLowerCase();
    if (info.availName && availNorm && availNorm !== "all") {
      const name = availNorm === "yes" ? "Yes" : availNorm === "no" ? "No" : availNorm === "other" ? "Other" : "";
      if (name) {
        if (info.availType === "select") andFilters.push({ property: info.availName, select: { equals: name } });
        else if (info.availType === "rich_text") andFilters.push({ property: info.availName, rich_text: { equals: name } });
        else if (info.availType === "formula") andFilters.push({ property: info.availName, formula: { string: { equals: name } } });
        else if (info.availType === "rollup") andFilters.push({ property: info.availName, rollup: { any: { rich_text: { equals: name } } } });
      }
    }
    if (q) andFilters.push({ or: [{ property: "Gig", title: { contains: String(q) } }] });

    // Sortierung
    const sorts = sort === "gig_desc" ? [{ property: "Gig", direction: "descending" }]
      : sort === "gig_asc" ? [{ property: "Gig", direction: "ascending" }]
      : [{ timestamp: "last_edited_time", direction: "descending" }];

    // Query Booking DB
    const r = await notion.databases.query({
      database_id: DB_BOOK,
      page_size: 30,
      start_cursor: cursor || undefined,
      filter: { and: [ownerFilter, ...andFilters] },
      sorts
    });

    // Mappen + ggf. Event-Page lesen
    const results = [];
    for (const page of (r.results || [])) {
      const gigProp = P(page, "Gig");
      const statusProp = P(page, "Status");
      const sumProp = P(page, "Summary");
      const availProp = P(page, "Artist availability") || P(page, "Availability artist");
      const commProp = P(page, "Artist comment");

      const gig =
        gigProp?.type === "title" ? plain(gigProp.title) :
        gigProp?.type === "rich_text" ? plain(gigProp.rich_text) : "";

      const statusTxt =
        statusProp?.type === "status" ? (statusProp.status?.name || "") :
        statusProp?.type === "select" ? (statusProp.select?.name || "") : "";

      let summary = textFrom(sumProp);

      // Fallback: Event-Relation auslesen und Summary bauen
      let usedRel = "";
      if (looksEmptySummary(summary) && info.eventRelName) {
        const evRel = P(page, info.eventRelName);
        const evId = evRel?.relation?.[0]?.id;
        if (evId) {
          try {
            const ev = await notion.pages.retrieve({ page_id: evId });
            const built = await buildSummaryFromEventPage(ev);
            if (built) { summary = built; usedRel = info.eventRelName; }
          } catch {}
        }
      }

      const availability = textFrom(availProp);
      const comment =
        commProp?.type === "rich_text" ? plain(commProp.rich_text) :
        commProp?.type === "title" ? plain(commProp.title) : "";

      results.push({
        id: page.id,
        gig,
        summary,
        status: statusTxt,
        availability,
        comment,
        _summaryVia: usedRel
      });
    }

    const payload = {
      results,
      nextCursor: r.has_more ? r.next_cursor : null,
      hasMore: !!r.has_more
    };
    if (String(debug) === "1") {
      payload.debug = {
        ownerName: info.ownerName,
        ownerType: info.ownerType,
        eventRelName: info.eventRelName,
        availName: info.availName,
        availType: info.availType
      };
    }
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "Server error", details: e.body || e.message || String(e) });
  }
}
