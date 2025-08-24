import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BP = process.env.NOTION_DB_ID;      // Booking Process
const DB_ART = process.env.ARTISTS_DB_ID;    // Artists

function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-user-key");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
}

const rich = r => (r || []).map(p => p.plain_text || "").join("");

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const userKey = req.headers["x-user-key"];
    if (!userKey) return res.status(401).json({ error: "Missing x-user-key" });

    const { musicianId, cursor, q, sort } = req.query;

    // 1) Artist via Musician Key ermitteln
    const artRes = await notion.databases.query({
      database_id: DB_ART,
      page_size: 1,
      filter: { property: "Musician Key", rich_text: { equals: String(userKey) } }
    });
    if (!artRes.results?.length) return res.status(401).json({ error: "Invalid key" });
    const artistPage = artRes.results[0];

    // 2) Sicherheitsabgleich mit Wix Member ID
    const wixId = rich(artistPage.properties["Wix Member ID"]?.rich_text);
    if (!musicianId || musicianId !== wixId) return res.status(403).json({ error: "Forbidden" });

    // 3) Filter: OwnerID Relation enthält diesen Artist
    const baseFilter = { property: "OwnerID", relation: { contains: artistPage.id } };

    const searchFilter = q ? {
      or: [
        { property: "Gig", title: { contains: String(q) } },
        { property: "Summary", rich_text: { contains: String(q) } }
      ]
    } : null;

    const compound = searchFilter ? { and: [baseFilter, searchFilter] } : baseFilter;

    const sorts = [];
    if (sort === "gig_asc") sorts.push({ property: "Gig", direction: "ascending" });
    if (sort === "gig_desc") sorts.push({ property: "Gig", direction: "descending" });

    const resp = await notion.databases.query({
      database_id: DB_BP,
      page_size: 30,
      start_cursor: cursor || undefined,
      filter: compound,
      sorts: sorts.length ? sorts : undefined
    });

    const results = resp.results.map(page => {
      const p = page.properties || {};
      return {
        id: page.id,
        gig: (p.Gig?.title || []).map(t => t.plain_text).join(""),
        summary: (p.Summary?.rich_text || []).map(t => t.plain_text).join(""),
        status: p.Status?.select?.name || "",
        availability: p["Artist availability"]?.select?.name || "",
        comment: (p["Artist comment"]?.rich_text || []).map(t => t.plain_text).join("")
      };
    });

    res.json({ results, nextCursor: resp.next_cursor, hasMore: resp.has_more });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
}
