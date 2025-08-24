import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ART = process.env.ARTISTS_DB_ID;

function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,x-user-key");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const userKey = req.headers["x-user-key"];
    if (!userKey) return res.status(401).json({ error: "Missing x-user-key" });

    const { musicianId, eventId, availability, comment } = req.body || {};
    if (!eventId) return res.status(400).json({ error: "Missing eventId" });

    // 1) Artist via Key
    const artRes = await notion.databases.query({
      database_id: DB_ART,
      page_size: 1,
      filter: { property: "Musician Key", rich_text: { equals: String(userKey) } }
    });
    if (!artRes.results?.length) return res.status(401).json({ error: "Invalid key" });
    const artistPage = artRes.results[0];

    // 2) Wix-ID prüfen
    const wixId = (artistPage.properties["Wix Member ID"]?.rich_text || []).map(t => t.plain_text).join("");
    if (!musicianId || musicianId !== wixId) return res.status(403).json({ error: "Forbidden" });

    // 3) Ownership prüfen: Darf diese Person diesen Eintrag bearbeiten?
    const ev = await notion.pages.retrieve({ page_id: eventId });
    const rel = ev.properties?.["OwnerID"]?.relation || [];
    const allowed = rel.some(r => r.id === artistPage.id);
    if (!allowed) return res.status(403).json({ error: "Not allowed for this event" });

    // 4) Update
    const props = {};
    if (availability) props["Artist availability"] = { select: { name: String(availability) } };
    if (comment !== undefined) {
      const txt = String(comment || "").slice(0, 2000);
      props["Artist comment"] = { rich_text: txt ? [{ type: "text", text: { content: txt } }] : [] };
    }

    await notion.pages.update({ page_id: eventId, properties: props });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
}
