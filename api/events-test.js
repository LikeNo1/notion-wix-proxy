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

/* ---------- DB-Schema lesen (mit ID-Fallback) ---------- */
async function retrieveDbWithFallback(rawId) {
  const dashed = toDashed(rawId);
  const raw32  = toRaw32(rawId);
  if (!raw32) {
    const e = new Error("BOOKING_DB_ID invalid or missing"); e.status = 400; throw e;
  }

  // 1) Try dashed first
  try {
    const db = await notion.databases.retrieve({ database_id: dashed || raw32 });
    return { db, whichId: dashed ? "dashed" : "raw32", idUsed: (dashed || raw32) };
  } catch (e1) {
    // 2) Then try raw32
    try {
      const db = await notion.databases.retrieve({ database_id: raw32 });
      return { db, whichId: "raw32", idUsed: raw32 };
    } catch (e2) {
      const msg = e2?.body?.message || e2?.message || String(e2);
      const err = new Error(`retrieve_failed: ${msg}`);
      err.status = 400;
      throw err;
    }
  }
}

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

/* ---------- Query mit Fallback (dashed → raw32) ---------- */
async function queryWithFallback(dbIdRaw, paramsCore) {
  const dashed = toDashed(dbIdRaw);
  const raw32  = toRaw32(dbIdRaw);

  // 1) Try dashed via SDK
  try {
    const r = await notion.databases.query({ database_id: dashed || raw32, ...paramsCore });
    return { r, whichId: dashed ? "dashed" : "raw32", idUsed: (dashed || raw32) };
  } catch (e1) {
    const details = e1?.body?.message || e1?.message || String(e1);
    if (!/invalid request url/i.test(details)) {
      // anderer Fehler → direkt weiterreichen
      const err = new Error(details); err.step = "databases.query (sdk)"; throw err;
    }
    // 2) If "Invalid request URL.", try raw32 explicitly
    try {
      const r = await notion.databases.query({ database_id: raw32, ...paramsCore });
      return { r, whichId: "raw32", idUsed: raw32 };
    } catch (e2) {
      const err = new Error(e2?.body?.message || e2?.message || String(e2));
      err.step = "databases.query (fallback raw32)";
      throw err;
    }
  }
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.NOTION_TOKEN) return res.status(400).json({ error: "Bad request", details: "NOTION_TOKEN missing" });
  if (!process.env.BOOKING_DB_ID) return res.status(400).json({ error: "Bad request", details: "BOOKING_DB_ID missing" });

  try {
    const { cursor = null, q = "", status = "" } = req.query || {};

    // 1) retrieve (und Status-Property bestimmen)
    const { db, whichId: retrievedAs, idUsed } = await retrieveDbWithFallback(process.env.BOOKING_DB_ID);
    const statusProp = db.properties?.["Status"]
      ? { name: "Status", type: db.properties["Status"].type }
      : null;

    // 2) Filter + Params bauen
    const andFilters = buildBaseFilters(statusProp, q, status);
    const paramsCore = {
      page_size: 50,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      ...(andFilters.length ? { filter: { and: andFilters } } : {})
    };
    if (cursor) paramsCore.start_cursor = String(cursor);

    // 3) query mit Fallback
    const { r, whichId: queriedAs, idUsed: qId } = await queryWithFallback(process.env.BOOKING_DB_ID, paramsCore);

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
      hasMore: !!r.has_more,
      _debug: { retrievedAs, queriedAs, retrieveId: idUsed, queryId: qId, notionVersionUsed: looksLikeDate ? versionEnv : "sdk-default" }
    });
  } catch (e) {
    res.status(400).json({
      error: "Bad request",
      step: e.step || "unknown",
      details: e.message || String(e)
    });
  }
}
