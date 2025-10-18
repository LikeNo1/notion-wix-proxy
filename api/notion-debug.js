// /api/notion-debug.js
import { Client } from "@notionhq/client";

function normalizeId(id) {
  const hex = String(id || "").trim().replace(/[^a-f0-9]/gi, "");
  if (hex.length < 32) return null;
  const core = hex.slice(0,32).toLowerCase();
  return `${core.slice(0,8)}-${core.slice(8,12)}-${core.slice(12,16)}-${core.slice(16,20)}-${core.slice(20)}`;
}

export default async function handler(req, res) {
  try {
    const notion = new Client({
      auth: process.env.NOTION_TOKEN,
      notionVersion: process.env.NOTION_VERSION || "2025-09-03",
    });
    const bookRaw = process.env.BOOKING_DB_ID;
    const artRaw  = process.env.ARTISTS_DB_ID || "";
    const bookId  = normalizeId(bookRaw);
    const artId   = artRaw ? normalizeId(artRaw) : null;

    const out = {
      haveToken: !!process.env.NOTION_TOKEN,
      bookRaw, bookId,
      artRaw,  artId,
      originOk: (process.env.ALLOWED_ORIGINS || "*"),
      notionVersion: process.env.NOTION_VERSION || "default",
      bookRetrieveOk: false,
      artRetrieveOk: false
    };

    if (bookId) {
      try { await notion.databases.retrieve({ database_id: bookId }); out.bookRetrieveOk = true; } catch (e) { out.bookError = e.body || e.message; }
    }
    if (artId) {
      try { await notion.databases.retrieve({ database_id: artId }); out.artRetrieveOk = true; } catch (e) { out.artError = e.body || e.message; }
    }
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
}
