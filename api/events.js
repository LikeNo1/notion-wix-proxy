// /api/events.js – Events für eingeloggte Artists, "Potential" wird serverseitig ausgeschlossen
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

// ---- helpers to read properties safely ----
function plain(rich) {
  if (Array.isArray(rich)) return rich.map(n => n?.plain_text || "").join("").trim();
  return "";
}
function getProp(page, key) { return page?.properties?.[key]; }

function mapPage(page) {
  const pGig   = getProp(page, "Gig");
  const pStat  = getProp(page, "Status");
  const pSum   = getProp(page, "Summary");               // kann Formula ODER rich_text sein
  const pAvail = getProp(page, "Artist availability");   // Select/Text/Formula
  const pComm  = getProp(page, "Artist comment");        // rich_text

  // Gig (Titel)
  const gig =
    pGig?.type === "title" ? plain(pGig.title) :
    pGig?.type === "rich_text" ? plain(pGig.rich_text) :
    "";

  // Status (status/select)
  const status =
    pStat?.type === "status" ? (pStat.status?.name || "") :
    pStat?.type === "select" ? (pStat.select?.name || "") :
    "";

  // Summary (Formula bevorzugen, sonst rich_text/title)
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

  // Availability (Select bevorzugen, sonst Text/Formula)
  let availability = "";
  if (pAvail?.type === "select") {
    availability = pAvail.select?.name || "";
  } else if (pAvail?.type === "rich_text") {
    availability = plain(pAvail.rich_text);
  } else if (pAvail?.type === "formula") {
    const f = pAvail.formula;
    if (f?.type === "string") availability = f.string || "";
  }

  // Comment
  const comment =
    pComm?.type === "rich_text" ? plain(pComm.rich_text) :
    pComm?.type === "title" ? plain(pComm.title) :
    "";

  return {
    id: page.id,
    gig,
    summary,
    status,
    availability,
    comment
  };
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

    // 1) Artist finden (über WixOwnerID / Wix Owner ID / Wix Member ID)
    const idFilters = [
      { property: "WixOwnerID",     rich_text: { equals: String(musicianId) } },
      { property: "Wix Owner ID",   rich_text: { equals: String(musicianId) } },
      { property: "Wix Member ID",  rich_text: { equals: String(musicianId) } }
    ];
    let artistPage = null, artistsQueryError = null;
    for (const f of idFilters) {
      try {
        const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
        if (r.results?.length) { artistPage = r.results[0]; break; }
      } catch (e) {
        artistsQueryError = e?.body || e?.message || String(e);
      }
    }
    if (!artistPage) {
      return res.status(404).json({
        error: "Artist not found by Wix member id",
        hint: "Prüfe ARTISTS_DB_ID und dass 'WixOwnerID' (oder 'Wix Owner ID' / 'Wix Member ID') exakt die Wix-ID enthält.",
        musicianId,
        artistsQueryError
      });
    }

    // 2) Query-Filter für Booking DB bauen
    const andFilters = [];

    // 2a) Ownership via Relation ODER Rollup (any.relation.contains)
    //    - Falls 'OwnerID' Relation ist → relation contains artistPage.id
    //    - Falls 'OwnerID' Rollup ist → any.relation contains artistPage.id
    const ownerRelationFilter = {
      or: [
        { property: "OwnerID", relation: { contains: artistPage.id } },
        { property: "Owner ID", relation: { contains: artistPage.id } }
      ]
    };
    // Für Rollup-Variante (Notion-API: rollup.any.relation.contains)
    const ownerRollupFilter = {
      or: [
        { property: "OwnerID", rollup: { any: { relation: { contains: artistPage.id } } } },
        { property: "Owner ID", rollup: { any: { relation: { contains: artistPage.id } } } }
      ]
    };
    andFilters.push({ or: [ ownerRelationFilter, ownerRollupFilter ] });

    // 2b) Status "Potential" strikt ausschließen
    andFilters.push({
      or: [
        { property: "Status", status: { does_not_equal: "Potential" } },
        { property: "Status", select: { does_not_equal: "Potential" } }
      ]
    });

    // 2c) Optional: status (nur erlaubte, niemals "all")
    const statusNorm = String(status).trim();
    if (statusNorm && statusNorm.toLowerCase() !== "all") {
      andFilters.push({
        or: [
          { property: "Status", status: { equals: statusNorm } },
          { property: "Status", select: { equals: statusNorm } }
        ]
      });
    }

    // 2d) Optional: availability
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

    // 2e) Optional: Suche im Gig-Titel
    const queryNorm = String(q || "").trim();
    if (queryNorm) {
      andFilters.push({ property: "Gig", title: { contains: queryNorm } });
    }

    const filterObj = andFilters.length ? { and: andFilters } : undefined;

    // 3) Sortierung
    const sorts = [];
    if (sort === "gig_asc") {
      sorts.push({ property: "Gig", direction: "ascending" });
    } else if (sort === "gig_desc") {
      sorts.push({ property: "Gig", direction: "descending" });
    } else {
      // Fallback: zuletzt geändert
      sorts.push({ timestamp: "last_edited_time", direction: "descending" });
    }

    // 4) Query ausführen
    const pageSize = 30;
    const params = {
      database_id: DB_BOOK,
      page_size: pageSize,
      sorts
    };
    if (filterObj) params.filter = filterObj;
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // 5) Mappen
    const results = (r.results || []).map(mapPage);
    const nextCursor = r.has_more ? r.next_cursor : null;

    // 6) Antwort
    res.json({
      results,
      nextCursor,
      hasMore: !!r.has_more
    });

  } catch (e) {
    console.error("@events error:", e?.body || e?.message || e);
    res.status(500).json({ error: "Server error" });
  }
}
