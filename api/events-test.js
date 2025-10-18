// /api/events-test.js
import { Client } from "@notionhq/client";

// --- ID normalisieren ---
function normalizeId(id) {
  const hex = String(id || "").trim().replace(/[^a-f0-9]/gi, "");
  if (hex.length < 32) return null;
  const core = hex.slice(0, 32).toLowerCase();
  return `${core.slice(0,8)}-${core.slice(8,12)}-${core.slice(12,16)}-${core.slice(16,20)}-${core.slice(20)}`;
}

// --- CORS ---
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

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: process.env.NOTION_VERSION || "2025-09-03",
});

const DB_BOOK = normalizeId(process.env.BOOKING_DB_ID);

// --- Notion Helfer ---
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

// --- DB-Schema (Status) ---
async function getBookingInfoStrict() {
  if (!process.env.NOTION_TOKEN) { const e = new Error("NOTION_TOKEN missing"); e.status = 400; throw e; }
  if (!DB_BOOK) {
    const e = new Error("BOOKING_DB_ID invalid or missing. Copy only the 32-char ID or UUID.");
    e.status = 400; throw e;
  }
  const db = await notion.databases.retrieve({ database_id: DB_BOOK });
  const statusProp = db.properties?.["Status"]
    ? { name: "Status", type: db.properties["Status"].type }
    : null;
  return { statusProp };
}

// --- Handler ---
export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { cursor = null, q = "", status = "" } = req.query || {};
    const { statusProp } = await getBookingInfoStrict();

    // Basis-Filter: Archive/Potential ausblenden + optionale Suche/Status
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

    const params = {
      database_id: DB_BOOK,
      page_size: 50,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      ...(andFilters.length ? { filter: { and: andFilters } } : {})
    };
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

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
      const wixOwnerId   = textFrom(P(page, "WixOwnerID")); // Rollup/Formula/Text → sauberer String

      return { id: page.id, gig, summary, wixOwnerId, status: statusTxt, availability, comment, joyComment };
    });

    res.status(200).json({
      results,
      nextCursor: r.has_more ? r.next_cursor : null,
      hasMore: !!r.has_more
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? "Bad request" : "Server error", details: e.message });
  }
}
