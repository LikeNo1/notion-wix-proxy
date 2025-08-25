// /api/update.js  – schreibt "Artist availability" & "Artist comment" in die Booking-Page
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// CORS: erlaube Deinen Wix-Domain(s)
function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin || "";
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
}

function bad(res, code, msg, details) {
  return res.status(code).json({ error: msg, details });
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");

  try {
    const { bookingId, availability, comment, musicianId } = req.body || {};

    if (!process.env.NOTION_TOKEN) {
      return bad(res, 500, "Server misconfigured: NOTION_TOKEN missing");
    }
    if (!bookingId) {
      return bad(res, 400, "bookingId missing");
    }

    // Optional: einfache Verifizierung – Seite existiert
    // (Wenn du hier zusätzlich prüfen willst, ob die Page zur/m Artist gehört,
    // kannst du properties.Artist (relation) gegen Deine Artist-ID vergleichen.)
    let page;
    try {
      page = await notion.pages.retrieve({ page_id: bookingId });
    } catch (e) {
      return bad(res, 404, "Booking page not found", e.body || e.message);
    }

    // Update-Objekt bauen
    const props = {};

    // Availability: leer lassen = nichts ändern; String "" = Select leeren
    if (typeof availability !== "undefined") {
      const normalized =
        availability === null || availability === ""
          ? null
          : String(availability).trim();

      if (normalized === null) {
        props["Artist availability"] = { select: null };
      } else {
        // nur erlaubte Werte
        const ALLOWED = new Set(["Yes", "No", "Other"]);
        if (ALLOWED.has(normalized)) {
          props["Artist availability"] = { select: { name: normalized } };
        } else {
          return bad(res, 400, "Invalid availability value", {
            received: availability,
            allowed: Array.from(ALLOWED),
          });
        }
      }
    }

    // Comment: wenn String leer -> Text leeren
    if (typeof comment !== "undefined") {
      const text = String(comment || "");
      // Notion Limit: pro Segment ca. 2000 Zeichen – zur Sicherheit beschneiden
      const safe = text.slice(0, 1900);
      props["Artist comment"] = {
        rich_text: safe ? [{ type: "text", text: { content: safe } }] : [],
      };
    }

    if (!Object.keys(props).length) {
      return bad(res, 400, "No properties to update");
    }

    // Update ausführen
    await notion.pages.update({
      page_id: bookingId,
      properties: props,
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("update error:", e?.body || e?.message || e);
    return bad(res, 500, "Server error", e?.body || e?.message || String(e));
  }
}
