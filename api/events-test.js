import { Client } from "@notionhq/client";

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
  notionVersion: process.env.NOTION_VERSION || "2025-09-03",
});

const DB_BOOK = process.env.BOOKING_DB_ID;
const DB_ART  = process.env.ARTISTS_DB_ID;

function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes("*") || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
}

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
      if (r.type === "array")  return (r.array || []).map(v => textFrom(v)).filter(Boolean).join(" ").trim();
      if (r.type === "number") return (r.number ?? "") + "";
      if (r.type === "date")   return r.date?.start || "";
      if (r.type === "string") return r.string || "";
      return "";
    }
    default: return "";
  }
}

// — A) Artist via WixOwnerID suchen (wie früher)
async function findArtistByWixId(musicianId) {
  const id = String(musicianId || "").trim();
  if (!id) return null;
  const props = ["WixOwnerID", "Wix Owner ID", "Wix Member ID"];

  for (const p of props) {
    try {
      const eq = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: { property: p, rich_text: { equals: id } } });
      if (eq.results?.length) return eq.results[0];
    } catch {}
  }
  for (const p of props) {
    try {
      const ct = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: { property: p, rich_text: { contains: id } } });
      if (ct.results?.length) return ct.results[0];
    } catch {}
  }
  return null;
}

// Booking-DB Struktur ermitteln
async function readBookingDb() {
  const db = await notion.databases.retrieve({ database_id: DB_BOOK });
  let ownerName = null, ownerType = null;
  for (const [name, def] of Object.entries(db.properties || {})) {
    if ((/owner|artist/i).test(name) && (def.type === "relation" || def.type === "rollup")) { ownerName = name; ownerType = def.type; break; }
  }
  if (!ownerName) {
    for (const [name, def] of Object.entries(db.properties || {})) {
      if (def.type === "relation" || def.type === "rollup") { ownerName = name; ownerType = def.type; break; }
    }
  }
  return { db, ownerName, ownerType };
}

// — B) Fallback: in Booking-DB direkt per Rollup/Text auf WixOwnerID filtern
function guessWixOwnerIdLikeProps(db) {
  const out = [];
  for (const [name, def] of Object.entries(db.properties || {})) {
    const t = def.type;
    const n = name.toLowerCase();
    const nameLooksLike = /wix.*owner.*id|owner.*wix.*id|wix.*member.*id/.test(n) || /owner.*id.*(string|text)/.test(n);
    if (nameLooksLike && (t === "rich_text" || t === "formula" || t === "rollup" || t === "title")) {
      out.push({ name, type: t });
    }
  }
  return out;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!process.env.NOTION_TOKEN || !DB_BOOK || !DB_ART) {
    return res.status(400).json({ error: "Missing envs", haveToken: !!process.env.NOTION_TOKEN, haveBook: !!DB_BOOK, haveArt: !!DB_ART });
  }

  try {
    const { musicianId = "", cursor = null, q = "", status = "" } = req.query || {};
    if (!musicianId) return res.status(400).json({ error: "Missing musicianId" });
    const id = String(musicianId).trim();

    const { db, ownerName, ownerType } = await readBookingDb();
    const statusProp = db.properties?.["Status"];

    // 1) Primärweg: Artist suchen und per Owner-Relation filtern
    let ownerFilter = null;
    const artist = await findArtistByWixId(id);
    if (artist && ownerName && ownerType) {
      ownerFilter =
        ownerType === "relation"
          ? { property: ownerName, relation: { contains: artist.id } }
          : { property: ownerName, rollup: { any: { relation: { contains: artist.id } } } };
    }

    // 2) Fallback: Owner-WixOwnerID-Text/Rollup in Booking-DB finden und direkt filtern
    let directIdFilter = null;
    if (!ownerFilter) {
      const candidates = guessWixOwnerIdLikeProps(db);
      if (candidates.length) {
        // nimm die erste, die existiert; Notion erlaubt contains auf rich_text/select/status/…; auf formula/rollup je nach Untertyp
        // Wir versuchen es tolerant mit rich_text.contains – Notion mappt das intern passend (bei rollup string/array)
        directIdFilter = { or: candidates.map(c => ({ property: c.name, rich_text: { contains: id } })) };
      }
    }

    if (!ownerFilter && !directIdFilter) {
      return res.status(404).json({
        error: "Artist not found and no Booking-DB fallback field for WixOwnerID",
        musicianId: id,
        hint: "Share Artists DB with integration OR add a rollup/text field in Booking DB that contains WixOwnerID."
      });
    }

    const andFilters = [];
    const HIDE = ["Potential","Archiv","Archive"];
    if (statusProp?.type === "status") HIDE.forEach(v => andFilters.push({ property: "Status", status: { does_not_equal: v } }));
    else if (statusProp?.type === "select") HIDE.forEach(v => andFilters.push({ property: "Status", select: { does_not_equal: v } }));

    if (String(status).trim()) {
      if (statusProp?.type === "status") andFilters.push({ property: "Status", status: { equals: String(status).trim() } });
      else if (statusProp?.type === "select") andFilters.push({ property: "Status", select: { equals: String(status).trim() } });
    }
    if (q) andFilters.push({ property: "Gig", title: { contains: String(q) } });

    const filter = ownerFilter
      ? { and: [ownerFilter, ...andFilters] }
      : { and: [directIdFilter, ...andFilters] };

    const params = {
      database_id: DB_BOOK,
      page_size: 50,
      filter,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }]
    };
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    const results = [];
    for (const page of (r.results || [])) {
      const gig         = textFrom(P(page, "Gig"));
      const statusP     = P(page, "Status");
      const statusTxt   =
        statusP?.type === "status" ? (statusP.status?.name || "") :
        statusP?.type === "select" ? (statusP.select?.name || "") : "";

      const availability = textFrom(P(page, "Artist availability")) || textFrom(P(page, "Availability artist"));
      const comment      = textFrom(P(page, "Artist comment"));
      const joyComment   = textFrom(P(page, "Joy comment"));
      const summary      = textFrom(P(page, "WixSummary")) || textFrom(P(page, "Summary"));

      results.push({ id: page.id, gig, summary, status: statusTxt, availability, comment, joyComment, _summaryVia: "rollup" });
    }

    res.status(200).json({
      results,
      nextCursor: r.has_more ? r.next_cursor : null,
      hasMore: !!r.has_more,
      _via: ownerFilter ? "owner-relation" : "direct-wixownerid-fallback"
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: e.body || e.message || String(e) });
  }
}
