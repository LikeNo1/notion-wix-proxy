// /api/events-test.js
import { Client } from "@notionhq/client";

const PROJECT_PROP = "Project";

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
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const origin = req.headers.origin || "";

  if (!allowed.length || allowed.includes("*") || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
}

/* ---------- Notion client ---------- */
const versionEnv = String(process.env.NOTION_VERSION || "").trim();
const looksLikeDate = /^\d{4}-\d{2}-\d{2}$/.test(versionEnv);

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  ...(looksLikeDate ? { notionVersion: versionEnv } : {})
});

/* ---------- Notion helpers ---------- */
const P = (page, key) => page?.properties?.[key] ?? null;

const plain = arr =>
  Array.isArray(arr)
    ? arr.map(n => n?.plain_text || "").join("").trim()
    : "";

function textFrom(prop) {
  if (!prop) return "";

  switch (prop.type) {
    case "title":
      return plain(prop.title);

    case "rich_text":
      return plain(prop.rich_text);

    case "url":
      return prop.url || "";

    case "number":
      return (prop.number ?? "") + "";

    case "status":
      return prop.status?.name || "";

    case "select":
      return prop.select?.name || "";

    case "multi_select":
      return (prop.multi_select || []).map(o => o.name).join(", ");

    case "date":
      return prop.date?.start || "";

    case "email":
      return prop.email || "";

    case "phone_number":
      return prop.phone_number || "";

    case "people":
      return (prop.people || [])
        .map(p => p?.name || p?.id || "")
        .filter(Boolean)
        .join(", ");

    case "formula": {
      const f = prop.formula || {};
      if (f.type === "string") return f.string || "";
      if (f.type === "number") return (f.number ?? "") + "";
      if (f.type === "boolean") return f.boolean ? "true" : "false";
      if (f.type === "date") return f.date?.start || "";
      return "";
    }

    case "rollup": {
      const r = prop.rollup || {};
      if (r.type === "array") {
        return (r.array || []).map(v => textFrom(v)).filter(Boolean).join(" ").trim();
      }
      if (r.type === "number") return (r.number ?? "") + "";
      if (r.type === "date") return r.date?.start || "";
      if (r.type === "string") return r.string || "";
      return "";
    }

    default:
      return "";
  }
}

async function retrieveDbWithFallback(rawId) {
  const dashed = toDashed(rawId);
  const raw32 = toRaw32(rawId);

  if (!raw32) {
    const e = new Error("BOOKING_DB_ID / ARTISTS_DB_ID invalid or missing");
    e.status = 400;
    throw e;
  }

  try {
    const db = await notion.databases.retrieve({ database_id: dashed || raw32 });
    return { db, idUsed: dashed || raw32 };
  } catch {
    const db = await notion.databases.retrieve({ database_id: raw32 });
    return { db, idUsed: raw32 };
  }
}

async function findArtistByWixOwnerId(artistsDbId, musicianId) {
  const id = String(musicianId || "").trim();
  if (!id) return null;

  const propsToTry = ["WixOwnerID", "Wix Owner ID", "Wix Member ID"];
  const patterns = [
    name => ({ property: name, rich_text: { equals: id } }),
    name => ({ property: name, rich_text: { contains: id } }),
    name => ({ property: name, title: { equals: id } }),
    name => ({ property: name, title: { contains: id } }),
    name => ({ property: name, formula: { string: { equals: id } } }),
    name => ({ property: name, formula: { string: { contains: id } } }),
    name => ({ property: name, rollup: { any: { rich_text: { equals: id } } } }),
    name => ({ property: name, rollup: { any: { rich_text: { contains: id } } } }),
    name => ({ property: name, rollup: { any: { title: { equals: id } } } }),
    name => ({ property: name, rollup: { any: { title: { contains: id } } } }),
    name => ({ property: name, rollup: { any: { formula: { string: { equals: id } } } } }),
    name => ({ property: name, rollup: { any: { formula: { string: { contains: id } } } } })
  ];

  for (const propName of propsToTry) {
    for (const build of patterns) {
      const filter = build(propName);
      try {
        const r = await notion.databases.query({
          database_id: artistsDbId,
          page_size: 1,
          filter
        });
        if (r.results?.length) return r.results[0];
      } catch {}
    }
  }

  try {
    const r = await notion.databases.query({
      database_id: artistsDbId,
      page_size: 50
    });

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

function findOwnerPropInBooking(db) {
  if (!db?.properties) return null;

  for (const [name, def] of Object.entries(db.properties)) {
    if ((/owner|artist/i).test(name) && (def.type === "relation" || def.type === "rollup")) {
      return { name, type: def.type };
    }
  }

  for (const [name, def] of Object.entries(db.properties)) {
    if (def.type === "relation" || def.type === "rollup") {
      return { name, type: def.type };
    }
  }

  return null;
}

function getRelationLikeProp(db, propName) {
  const def = db?.properties?.[propName];
  if (!def) return null;
  if (def.type === "relation" || def.type === "rollup") {
    return { name: propName, type: def.type };
  }
  return null;
}

function getRelationIdsFromRollupProp(prop) {
  if (!prop || prop.type !== "rollup" || prop.rollup?.type !== "array") return [];

  const ids = new Set();

  for (const item of (prop.rollup.array || [])) {
    if (!item) continue;

    if (item.type === "relation") {
      if (Array.isArray(item.relation)) {
        item.relation.forEach(r => r?.id && ids.add(r.id));
      } else if (item.relation?.id) {
        ids.add(item.relation.id);
      }
    }

    if (item.type === "page" && item.page?.id) {
      ids.add(item.page.id);
    }

    if (item?.relation?.id) {
      ids.add(item.relation.id);
    }
  }

  return [...ids];
}

async function getAllRelationIdsFromPage(page, propName) {
  const prop = P(page, propName);
  if (!prop || prop.type !== "relation") return [];

  const ids = new Set((prop.relation || []).map(r => r?.id).filter(Boolean));

  if (!prop.has_more) {
    return [...ids];
  }

  if (!prop.id) {
    return [...ids];
  }

  let cursor = undefined;

  while (true) {
    const resp = await notion.pages.properties.retrieve({
      page_id: page.id,
      property_id: prop.id,
      ...(cursor ? { start_cursor: cursor } : {})
    });

    if (resp?.object === "list") {
      for (const item of (resp.results || [])) {
        if (item?.type === "relation" && item.relation?.id) {
          ids.add(item.relation.id);
        }
      }

      if (!resp.has_more || !resp.next_cursor) break;
      cursor = resp.next_cursor;
      continue;
    }

    if (resp?.type === "relation" && resp.relation?.id) {
      ids.add(resp.relation.id);
    }
    break;
  }

  return [...ids];
}

async function getRelationIdsByProp(page, propName) {
  const prop = P(page, propName);
  if (!prop) return [];

  if (prop.type === "relation") {
    return await getAllRelationIdsFromPage(page, propName);
  }

  if (prop.type === "rollup") {
    return getRelationIdsFromRollupProp(prop);
  }

  return [];
}

function findTitlePropName(page) {
  for (const [name, def] of Object.entries(page?.properties || {})) {
    if (def?.type === "title") return name;
  }
  return null;
}

async function getPageTitleCached(pageId, cache) {
  if (!pageId) return "";
  if (cache.has(pageId)) return cache.get(pageId);

  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const titleProp = findTitlePropName(page);
    const title = titleProp ? textFrom(P(page, titleProp)) : "";
    cache.set(pageId, title || "");
    return title || "";
  } catch {
    cache.set(pageId, "");
    return "";
  }
}

function buildBaseFilters(statusProp, q, status) {
  const wantedHidden = ["Potential", "Archive"];
  const andFilters = [];

  let existingOptions = [];

  if (statusProp?.type === "status") {
    existingOptions = (statusProp.def?.status?.options || []).map(o => o.name);
  } else if (statusProp?.type === "select") {
    existingOptions = (statusProp.def?.select?.options || []).map(o => o.name);
  }

  const existingSet = new Set(existingOptions);
  const hide = wantedHidden.filter(v => existingSet.has(v));

  if (statusProp?.type === "status") {
    hide.forEach(v => {
      andFilters.push({
        property: "Status",
        status: { does_not_equal: v }
      });
    });
  } else if (statusProp?.type === "select") {
    hide.forEach(v => {
      andFilters.push({
        property: "Status",
        select: { does_not_equal: v }
      });
    });
  }

  const sNorm = String(status || "").trim();
  if (sNorm) {
    if (statusProp?.type === "status" && existingSet.has(sNorm)) {
      andFilters.push({
        property: "Status",
        status: { equals: sNorm }
      });
    } else if (statusProp?.type === "select" && existingSet.has(sNorm)) {
      andFilters.push({
        property: "Status",
        select: { equals: sNorm }
      });
    }
  }

  if (q) {
    andFilters.push({
      property: "Gig",
      title: { contains: String(q) }
    });
  }

  return andFilters;
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  cors(res, req);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.NOTION_TOKEN) {
    return res.status(400).json({ error: "Bad request", details: "NOTION_TOKEN missing" });
  }

  if (!process.env.BOOKING_DB_ID) {
    return res.status(400).json({ error: "Bad request", details: "BOOKING_DB_ID missing" });
  }

  try {
    const { cursor = null, q = "", status = "", musicianId = "" } = req.query || {};

    // Booking DB
    const { db: bookingDb } = await retrieveDbWithFallback(process.env.BOOKING_DB_ID);
    const statusProp = bookingDb.properties?.["Status"]
      ? {
          name: "Status",
          type: bookingDb.properties["Status"].type,
          def: bookingDb.properties["Status"]
        }
      : null;

    const ownerProp = findOwnerPropInBooking(bookingDb);
    const bookingProjectProp = getRelationLikeProp(bookingDb, PROJECT_PROP);

    // Filters
    const andFilters = buildBaseFilters(statusProp, q, status);

    // Artist + allowed projects
    let allowedProjectIds = [];

    if (musicianId && process.env.ARTISTS_DB_ID) {
      try {
        const { db: artistsDb, idUsed: artistsDbId } = await retrieveDbWithFallback(process.env.ARTISTS_DB_ID);
        const artist = await findArtistByWixOwnerId(artistsDbId, musicianId);

        if (artist) {
          if (ownerProp) {
            const relFilter =
              ownerProp.type === "relation"
                ? { property: ownerProp.name, relation: { contains: artist.id } }
                : { property: ownerProp.name, rollup: { any: { relation: { contains: artist.id } } } };

            andFilters.unshift(relFilter);
          }

          const artistProjectProp = getRelationLikeProp(artistsDb, PROJECT_PROP);
          if (artistProjectProp) {
            allowedProjectIds = await getRelationIdsByProp(artist, artistProjectProp.name);
          }
        }
      } catch {
        // kein harter Abbruch
      }
    }

    // Query bookings
    const params = {
      database_id: toDashed(process.env.BOOKING_DB_ID) || toRaw32(process.env.BOOKING_DB_ID),
      page_size: 50,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      ...(andFilters.length ? { filter: { and: andFilters } } : {})
    };

    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // Map booking rows
    const rawResults = await Promise.all(
      (r.results || []).map(async page => {
        const gig = textFrom(P(page, "Gig"));

        const statusP = P(page, "Status");
        const statusTxt =
          statusP?.type === "status"
            ? (statusP.status?.name || "")
            : statusP?.type === "select"
              ? (statusP.select?.name || "")
              : "";

        const availability =
          textFrom(P(page, "Artist availability")) ||
          textFrom(P(page, "Availability artist"));

        const comment = textFrom(P(page, "Artist comment"));
        const joyComment = textFrom(P(page, "Joy comment"));
        const summary = textFrom(P(page, "WixSummary")) || textFrom(P(page, "Summary"));
        const wixOwnerId = textFrom(P(page, "WixOwnerID"));

        const projectIds = bookingProjectProp
          ? await getRelationIdsByProp(page, bookingProjectProp.name)
          : [];

        return {
          id: page.id,
          gig,
          summary,
          wixOwnerId,
          status: statusTxt,
          availability,
          comment,
          joyComment,
          projectIds
        };
      })
    );

    // Available projects for filter
    let availableProjectIds = [...new Set(allowedProjectIds.filter(Boolean))];

    // Fallback: if no artist projects found, derive from loaded booking rows
    if (!availableProjectIds.length) {
      availableProjectIds = [...new Set(rawResults.flatMap(x => x.projectIds || []).filter(Boolean))];
    }

    const titleCache = new Map();

    let availableProjects = await Promise.all(
      availableProjectIds.map(async id => {
        const title = await getPageTitleCached(id, titleCache);
        return {
          id,
          name: title || `Project ${String(id).slice(0, 8)}`
        };
      })
    );

    availableProjects = availableProjects
      .filter(p => p.id)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), "de", { sensitivity: "base" }));

    const allowedSet = new Set(availableProjects.map(p => p.id));
    const nameById = new Map(availableProjects.map(p => [p.id, p.name]));

    const results = rawResults.map(row => ({
      id: row.id,
      gig: row.gig,
      summary: row.summary,
      wixOwnerId: row.wixOwnerId,
      status: row.status,
      availability: row.availability,
      comment: row.comment,
      joyComment: row.joyComment,
      projects: (row.projectIds || [])
        .filter(id => allowedSet.has(id))
        .map(id => ({
          id,
          name: nameById.get(id) || `Project ${String(id).slice(0, 8)}`
        }))
    }));

    res.status(200).json({
      results,
      availableProjects,
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
