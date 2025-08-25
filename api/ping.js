// /api/ping.js
import { Client } from "@notionhq/client";

export default async function handler(req, res) {
  try {
    const notion = new Client({ auth: process.env.NOTION_TOKEN });
    const me = await notion.users.me();
    res.json({ ok: true, me });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.body || e.message || String(e) });
  }
}
