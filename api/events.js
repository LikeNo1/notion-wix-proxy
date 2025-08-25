// /api/events.js — Relation bevorzugt, Rollup-Fallback; Summary-Fallback aus Events-Relation
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
const plain = rich => Array.isArray(rich) ? rich.map(n => n?.plain_text || "").join("").trim() : "";

// Rollup → menschenlesbarer String
function fromRollup(r) {
  if (!r || !r.type) return "";
  if (r.type === "array" && Array.isArray(r.array)) {
    const parts = r.array.map(v => {
      switch (v?.type) {
        case "rich_text":    return plain(v.rich_text);
        case "title":        return plain(v.title);
        case "url":          return v.url || "";
        case "date":         return v.date?.start || "";
        case "email":        return v.email || "";
        case "phone_number": return v.phone_number || "";
        case "number":       return (v.number ?? "") + "";
        default:             return "";
      }
    }).filter(Boolean);
    return parts.join("\n").trim();
  }
  if (r.type === "number") return (r.number ?? "") + "";
  if (r.type === "date")   return r.date?.start || "";
  return "";
}

function extractSummaryFromProp(prop) {
  if (!prop) return "";
  if (prop.type === "rollup")  return fromRollup(prop.rollup);
  if (prop.type === "formula") {
    const f = prop.formula;
    if (f?.type === "string")   return f.string || "";
    if (f?.type === "number")   return String(f.number);
    if (f?.type === "boolean")  return f.boolean ? "true" : "false";
    if (f?.type === "date")     return f.date?.start || "";
    return "";
  }
  if (prop.type === "rich_text") return plain(prop.rich_text);
  if (prop.type === "title")     return plain(prop.title);
  return "";
}

function extractAvailability(prop) {
  if (!prop) return "";
  if (prop.type === "select")   return prop.select?.name || "";
  if (prop.type === "rollup")   return fromRollup(prop.rollup);
  if (prop.type === "rich_text")return plain(prop.rich_text);
  if (prop.type === "formula")  {
    const f = prop.formula;
    if (f?.type === "string") return f.string || "";
  }
  return "";
}

// Artist via WixOwnerID/Wix Owner ID/Wix Member ID
async function findArtistByWixId(musicianId) {
  const idStr = String(musicianId).trim();
  const propNames = ["WixOwnerID", "Wix Owner ID", "Wix Member ID"];
  const filters = [];
  for (const p of propNames) {
    filters.push({ property: p, rich_text: { equals: idStr } });
    filters.push({ property: p, rich_text: { contains: idStr } });
    filters.push({ property: p, title:     { equals: idStr } });
    filters.push({ property: p, title:     { contains: idStr } });
    filters.push({ property: p, formula:   { string: { equals: idStr } } });
    filters.push({ property: p, formula:   { string: { contains: idStr } } });
  }
  for (const f of filters) {
    try {
      const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
      if (r.results?.length) return r.results[0];
    } catch (_) {}
  }
  return null;
}

// Booking-DB Schema analysieren
async function getBookingSchemaInfo() {
  const db = await notion.databases.retrieve({ database_id: DB_BOOK });

  // Owner (Artist/Owner) Relation/ Rollup
  const relations = [];
  const rollups   = [];
  for (const [name, def] of Object.entries(db.properties || {})) {
    if (def.type === "relation") relations.push({ name, type: "relation" });
    if (def.type === "rollup")   rollups.push({ name, type: "rollup" });
  }
  const pickBy = (arr, re) => arr.find(p => re.test(p.name)) || null;

  const ownerRel  = pickBy(relations, /(owner|artist)/i) || relations[0] || null;
  const ownerRoll = pickBy(rollups,   /(owner|artist)/i) || rollups[0]   || null;
  const owner     = ownerRel || ownerRoll || { name: null, type: null };

  // Versuch, eine Events-Relation zu finden (Event/Events/Gig)
  const eventRel  = pickBy(relations.filter(r => !/(owner|artist)/i.test(r.name)), /(event|events|gig)/i) || null;

  const typed = (n) => db.properties?.[n] ? { name: n, type: db.properties[n].type } : { name: null, type: null };
  const status       = typed("Status");
  const availability = db.properties?.["Artist availability"]
    ? { name: "Artist availability", type: db.properties["Artist availability"].type }
    : (db.properties?.["Availability artist"]
        ? { name: "Availability artist", type: db.properties["Availability artist"].type }
        : { name: null, type: null });
  const summary      = typed("Summary");

  return { owner, eventRel, status, availability, summary };
}

// Summary direkt aus Events-Seite (Relation) holen – falls nötig
async function fetchEventSummaryFromRelated(page, eventRelName) {
  if (!eventRelName) return "";
  const rel = P(page, eventRelName);
  const firstId = rel?.relation?.[0]?.id;
  if (!firstId) return "";
  try {
    const ev = await notion.pages.retrieve({ page_id: firstId });
    // Bevorzugt „Summary“, sonst heuristisch aus Titel+RichText bauen
    const propSummary = ev.properties?.["Summary"];
    let s = extractSummaryFromProp(propSummary);
    if (!s) {
      const evTitle = ev.properties?.["Name"] || ev.properties?.["Title"] || ev.properties?.["Gig"];
      s = extractSummaryFromProp(evTitle);
    }
    return s || "";
  } catch {
    return "";
  }
}

async function mapPageAsync(page, info) {
  const pGig   = P(page, "Gig");
  const pStat  = P(page, "Status");
  const pSum   = P(page, "Summary");
  const pAvail = P(page, "Artist availability") || P(page, "Availability artist");
  const pComm  = P(page, "Artist comment");

  const gig =
    pGig?.type === "title" ? plain(pGig.title) :
    pGig?.type === "rich_text" ? plain(pGig.rich_text) : "";

  const status =
    pStat?.type === "status" ? (pStat.status?.name || "") :
    pStat?.type === "select" ? (pStat.select?.name || "") : "";

  // 1) Summary aus Booking-Page
  let summary = extractSummaryFromProp(pSum);

  // 2) Fallback: aus Events-Relation holen, wenn Booking-Formula zu „mager“ ist
  const looksEmpty =
    !summary ||
    summary === "📅 Datum/Zeit: noch zu terminieren\n🗺️ Location: /\n🔗 Link:   \n📃 Beschreibung und Vibe:" ||
    summary.replace(/\s+/g, "").length < 10;

  if (looksEmpty) {
    const deep = await fetchEventSummaryFromRelated(page, info.eventRel?.name);
    if (deep) summary = deep;
  }

  const availability = extractAvailability(pAvail);

  const comment =
    pComm?.type === "rich_text" ? plain(pComm.rich_text) :
    pComm?.type === "title" ? plain(pComm.title) : "";

  return { id: page.id, gig, summary, status, availability, comment };
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
      debug = "0"
    } = req.query || {};
    if (!musicianId) return bad(res, "Missing musicianId");

    // 1) Artist
    const artist = await findArtistByWixId(musicianId);
    if (!artist) return res.status(404).json({ error: "Artist not found by Wix member id", musicianId });

    // 2) Booking-DB Schema
    const info = await getBookingSchemaInfo();
    if (!info.owner.name || !info.owner.type) return bad(res, "No owner relation/rollup found in Booking DB", info);

    // 3) Owner-Filter
    const ownerFilter =
      info.owner.type === "relation"
        ? { property: info.owner.name, relation: { contains: artist.id } }
        : { property: info.owner.name, rollup: { any: { relation: { contains: artist.id } } } };

    // 4) weitere Filter
    const andFilters = [];
    const wantPotential = String(includePotential).trim() === "1";
    if (!wantPotential && info.status.name) {
      if (info.status.type === "status") andFilters.push({ property: info.status.name, status: { does_not_equal: "Potential" } });
      else if (info.status.type === "select") andFilters.push({ property: info.status.name, select: { does_not_equal: "Potential" } });
    }

    const statusNorm = String(status).trim();
    if (statusNorm && statusNorm.toLowerCase() !== "all" && info.status.name) {
      if (info.status.type === "status") andFilters.push({ property: info.status.name, status: { equals: statusNorm } });
      else if (info.status.type === "select") andFilters.push({ property: info.status.name, select: { equals: statusNorm } });
    }

    const availNorm = String(availability || "").trim().toLowerCase();
    if (availNorm && availNorm !== "all" && info.availability.name) {
      const availName = availNorm === "yes" ? "Yes" : availNorm === "no" ? "No" : availNorm === "other" ? "Other" : "";
      if (availName) {
        if (info.availability.type === "select")
          andFilters.push({ property: info.availability.name, select: { equals: availName } });
        else if (info.availability.type === "rollup")
          andFilters.push({ property: info.availability.name, rollup: { any: { rich_text: { equals: availName } } } });
        else if (info.availability.type === "rich_text")
          andFilters.push({ property: info.availability.name, rich_text: { equals: availName } });
        else if (info.availability.type === "formula")
          andFilters.push({ property: info.availability.name, formula: { string: { equals: availName } } });
      }
    }

    const qNorm = String(q || "").trim();
    if (qNorm) {
      const or = [{ property: "Gig", title: { contains: qNorm } }];
      if (info.summary.name) {
        if (info.summary.type === "rollup")
          or.push({ property: info.summary.name, rollup: { any: { rich_text: { contains: qNorm } } } });
        else if (info.summary.type === "formula")
          or.push({ property: info.summary.name, formula: { string: { contains: qNorm } } });
        else if (info.summary.type === "rich_text")
          or.push({ property: info.summary.name, rich_text: { contains: qNorm } });
        else if (info.summary.type === "title")
          or.push({ property: info.summary.name, title: { contains: qNorm } });
      }
      andFilters.push({ or });
    }

    const sorts = [];
    if (sort === "gig_asc")      sorts.push({ property: "Gig", direction: "ascending" });
    else if (sort === "gig_desc")sorts.push({ property: "Gig", direction: "descending" });
    else                         sorts.push({ timestamp: "last_edited_time", direction: "descending" });

    // 5) Query
    const r = await notion.databases.query({
      database_id: DB_BOOK,
      page_size: 30,
      start_cursor: cursor || undefined,
      sorts,
      filter: { and: [ownerFilter, ...andFilters] }
    });

    // 6) Mapping (inkl. Deep-Fetch der Summary)
    const results = await Promise.all((r.results || []).map(p => mapPageAsync(p, info)));

    const payload = {
      results,
      nextCursor: r.has_more ? r.next_cursor : null,
      hasMore: !!r.has_more
    };
    if (String(debug).trim() === "1") payload.debug = { artistId: artist.id, ...info, ownerFilter, andFilters };

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "Server error", details: e.body || e.message || String(e) });
  }
}
