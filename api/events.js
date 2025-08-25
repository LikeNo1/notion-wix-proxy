// /api/events.js – robustere Artist-Suche, "Potential" ausgeschlossen, Formel-Summary
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BOOK = process.env.BOOKING_DB_ID; // Booking Process DB (Events)
const DB_ART  = process.env.ARTISTS_DB_ID; // Artists DB

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

// ---- helpers ----
function plain(rich) {
  if (Array.isArray(rich)) return rich.map(n => n?.plain_text || "").join("").trim();
  return "";
}
function getProp(page, key) { return page?.properties?.[key]; }

function mapPage(page) {
  const pGig   = getProp(page, "Gig");
  const pStat  = getProp(page, "Status");
  const pSum   = getProp(page, "Summary");
  const pAvail = getProp(page, "Artist availability");
  const pComm  = getProp(page, "Artist comment");

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
    else if (f?.type === "number" && typeof f.number === "number") summary = String(f.number);
    else if (f?.type === "boolean") summary = f.boolean ? "true" : "false";
    else if (f?.type === "date") summary = f.date?.start || "";
  } else if (pSum?.type === "rich_text") {
    summary = plain(pSum.rich_text);
  } else if (pSum?.type === "title") {
    summary = plain(pSum.title);
  }

  let availability = "";
  if (pAvail?.type === "select") {
    availability = pAvail.select?.name || "";
  } else if (pAvail?.type === "rich_text") {
    availability = plain(pAvail.rich_text);
  } else if (pAvail?.type === "formula") {
    const f = pAvail.formula;
    if (f?.type === "string") availability = f.string || "";
  }

  const comment =
    pComm?.type === "rich_text" ? plain(pComm.rich_text) :
    pComm?.type === "title" ? plain(pComm.title) : "";

  return { id: page.id, gig, summary, status, availability, comment };
}

// ---- robust: Artist via WixOwnerID / Wix Owner ID / Wix Member ID finden ----
async function findArtistByWixId(musicianId) {
  const idStr = String(musicianId).trim();

  // Kandidaten für Property-Namen in Artists-DB
  const propNames = ["WixOwnerID", "Wix Owner ID", "Wix Member ID"];

  // Wir probieren mehrere Filter-Varianten (rich_text equals/contains, title equals/contains, formula.string contains)
  const filters = [];
  for (const p of propNames) {
    filters.push({ property: p, rich_text: { equals: idStr } });
    filters.push({ property: p, rich_text: { contains: idStr } });
    filters.push({ property: p, title:     { equals: idStr } });
    filters.push({ property: p, title:     { contains: idStr } });
    filters.push({ property: p, formula:   { string: { equals: idStr } } });
    filters.push({ property: p, formula:   { string: { contains: idStr } } });
  }

  // Wir versuchen nacheinander; beim ersten Treffer geben wir die Seite zurück
  for (const f of filters) {
    try {
      const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
      if (r.results?.length) return r.results[0];
    } catch (e) {
      // wir ignorieren einzelne Filterfehler (z. B. falscher Property-Typ) und probieren weiter
      continue;
    }
  }
  return null;
}

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
      availability = "all",
      status = "all"
    } = req.query || {};

    if (!musicianId) return bad(res, "Missing musicianId");

    // 1) Artist finden (robust)
    const artistPage = await findArtistByWixId(musicianId);
    if (!artistPage) {
      return res.status(404).json({
        error: "Artist not found by Wix member id",
        hint: "Prüfe in der Artists-DB die Property (z. B. 'WixOwnerID') und dass die Member-ID exakt (ohne Leerzeichen) drinsteht."
      });
    }

    // 2) Query-Filter für Booking DB
    const andFilters = [];

    // Ownership via Relation ODER Rollup
    const ownerRelationFilter = {
      or: [
        { property: "OwnerID", relation: { contains: artistPage.id } },
        { property: "Owner ID", relation: { contains: artistPage.id } }
      ]
    };
    const ownerRollupFilter = {
      or: [
        { property: "OwnerID", rollup: { any: { relation: { contains: artistPage.id } } } },
        { property: "Owner ID", rollup: { any: { relation: { contains: artistPage.id } } } }
      ]
    };
    andFilters.push({ or: [ ownerRelationFilter, ownerRollupFilter ] });

    // Status "Potential" strikt ausschließen
    andFilters.push({
      or: [
        { property: "Status", status: { does_not_equal: "Potential" } },
        { property: "Status", select: { does_not_equal: "Potential" } }
      ]
    });

    // Optional: Status (niemals "all")
    const statusNorm = String(status).trim();
    if (statusNorm && statusNorm.toLowerCase() !== "all") {
      andFilters.push({
        or: [
          { property: "Status", status: { equals: statusNorm } },
          { property: "Status", select: { equals: statusNorm } }
        ]
      });
    }

    // Optional: Availability
    const availNorm = String(availability || "").trim().toLowerCase();
    if (availNorm && availNorm !== "all") {
      const availName = availNorm === "yes" ? "Yes" : availNorm === "no" ? "No" : availNorm === "other" ? "Other" : "";
      if (availName) {
        andFilters.push({
          or: [
            { property: "Artist availability", select: { equals: availName } },
            { property: "Artist availability", rich_text: { equals: availName } },
            { property: "Artist availability", formula: { string: { equals: availName } } }
          ]
        });
      }
    }

    // Optional: Suche (Gig-Titel & Summary-Formel)
    const queryNorm = String(q || "").trim();
    if (queryNorm) {
      andFilters.push({
        or: [
          { property: "Gig", title: { contains: queryNorm } },
          { property: "Summary", formula: { string: { contains: queryNorm } } },
          { property: "Summary", rich_text: { contains: queryNorm } }
        ]
      });
    }

    const filterObj = andFilters.length ? { and: andFilters } : undefined;

    // Sortierung
    const sorts = [];
    if (sort === "gig_asc")      sorts.push({ property: "Gig", direction: "ascending" });
    else if (sort === "gig_desc")sorts.push({ property: "Gig", direction: "descending" });
    else                         sorts.push({ timestamp: "last_edited_time", direction: "descending" });

    // Query ausführen
    const params = {
      database_id: DB_BOOK,
      page_size: 30,
      sorts
    };
    if (filterObj) params.filter = filterObj;
    if (cursor)    params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // Mappen
    const results = (r.results || []).map(mapPage);
    res.json({ results, nextCursor: r.has_more ? r.next_cursor : null, hasMore: !!r.has_more });
  } catch (e) {
    console.error("@events error:", e?.body || e?.message || e);
    res.status(500).json({ error: "Server error" });
  }
}
