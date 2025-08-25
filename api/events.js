// /api/events.js — bevorzugt RELATION (Artist/Owner), fallback ROLLUP; typgenaue Filter
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

function mapPage(page) {
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

  let summary = "";
  if (pSum?.type === "formula") {
    const f = pSum.formula;
    if (f?.type === "string") summary = f.string || "";
    else if (f?.type === "number")  summary = String(f.number);
    else if (f?.type === "boolean") summary = f.boolean ? "true" : "false";
    else if (f?.type === "date")    summary = f.date?.start || "";
  } else if (pSum?.type === "rich_text") summary = plain(pSum.rich_text);
  else if (pSum?.type === "title")        summary = plain(pSum.title);

  let availability = "";
  if (pAvail?.type === "select") availability = pAvail.select?.name || "";
  else if (pAvail?.type === "rich_text") availability = plain(pAvail.rich_text);
  else if (pAvail?.type === "formula") {
    const f = pAvail.formula;
    if (f?.type === "string") availability = f.string || "";
  }

  const comment =
    pComm?.type === "rich_text" ? plain(pComm.rich_text) :
    pComm?.type === "title" ? plain(pComm.title) : "";

  return { id: page.id, gig, summary, status, availability, comment };
}

// Artist via WixOwnerID / Wix Owner ID / Wix Member ID
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

// Booking-DB-Schema analysieren → bevorzugt eine RELATION mit "owner"/"artist" im Namen, sonst ROLLUP
async function getBookingSchemaInfo() {
  const db = await notion.databases.retrieve({ database_id: DB_BOOK });

  // alle Relations und Rollups einsammeln
  const relations = [];
  const rollups   = [];
  for (const [name, def] of Object.entries(db.properties || {})) {
    if (def.type === "relation") relations.push({ name, type: "relation" });
    if (def.type === "rollup")   rollups.push({ name, type: "rollup" });
  }
  // heuristik: bevorzugt "owner"/"artist" im Namen
  const pickByName = (arr) =>
    arr.find(p => /owner|artist/i.test(p.name)) || arr[0] || null;

  const ownerRel = pickByName(relations);
  const ownerRoll= pickByName(rollups);

  // Status / Availability / Summary wie gehabt
  const prop = n => db.properties?.[n] ? { name: n, type: db.properties[n].type } : { name: null, type: null };
  const status       = prop("Status");
  const availability = db.properties?.["Artist availability"]
    ? { name: "Artist availability", type: db.properties["Artist availability"].type }
    : (db.properties?.["Availability artist"]
        ? { name: "Availability artist", type: db.properties["Availability artist"].type }
        : { name: null, type: null });
  const summary      = prop("Summary");

  // Owner: Relation bevorzugen, sonst Rollup
  const owner = ownerRel || ownerRoll || { name: null, type: null };
  return { owner, status, availability, summary };
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

    const artist = await findArtistByWixId(musicianId);
    if (!artist) return res.status(404).json({ error: "Artist not found by Wix member id", musicianId });

    const info = await getBookingSchemaInfo();
    if (!info.owner.name || !info.owner.type) return bad(res, "No owner relation/rollup found in Booking DB", info);

    // Owner-Filter (Relation bevorzugt)
    let ownerFilter;
    if (info.owner.type === "relation") {
      ownerFilter = { property: info.owner.name, relation: { contains: artist.id } };
    } else {
      ownerFilter = { property: info.owner.name, rollup: { any: { relation: { contains: artist.id } } } };
    }

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
        if (info.availability.type === "select") andFilters.push({ property: info.availability.name, select: { equals: availName } });
        else if (info.availability.type === "rich_text") andFilters.push({ property: info.availability.name, rich_text: { equals: availName } });
        else if (info.availability.type === "formula") andFilters.push({ property: info.availability.name, formula: { string: { equals: availName } } });
      }
    }

    const qNorm = String(q || "").trim();
    if (qNorm) {
      const or = [{ property: "Gig", title: { contains: qNorm } }];
      if (info.summary.name) {
        if (info.summary.type === "formula") or.push({ property: info.summary.name, formula: { string: { contains: qNorm } } });
        else if (info.summary.type === "rich_text") or.push({ property: info.summary.name, rich_text: { contains: qNorm } });
        else if (info.summary.type === "title") or.push({ property: info.summary.name, title: { contains: qNorm } });
      }
      andFilters.push({ or });
    }

    const sorts = [];
    if (sort === "gig_asc")      sorts.push({ property: "Gig", direction: "ascending" });
    else if (sort === "gig_desc")sorts.push({ property: "Gig", direction: "descending" });
    else                         sorts.push({ timestamp: "last_edited_time", direction: "descending" });

    const r = await notion.databases.query({
      database_id: DB_BOOK,
      page_size: 30,
      start_cursor: cursor || undefined,
      sorts,
      filter: { and: [ownerFilter, ...andFilters] }
    });

    const results = (r.results || []).map(mapPage);
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
