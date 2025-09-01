// /api/events.js – robuste Owner-Erkennung (relation vs. rollup) + Summary aus Event-Feldern
import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BOOK = process.env.BOOKING_DB_ID;   // Booking Process (Events)
const DB_ART  = process.env.ARTISTS_DB_ID;   // Artists DB

// ---------- helpers ----------
function cors(res, req) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.origin || '';
  if (!allowed.length || allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
}
function bad(res, msg, details) { return res.status(400).json({ error: msg, details }); }
function plain(rich) { return Array.isArray(rich) ? rich.map(n => n?.plain_text || '').join('').trim() : ''; }
const getProp = (page, key) => page?.properties?.[key];

// liest String aus beliebigem Notion-Property (formula/rich_text/title)
function extractText(prop) {
  if (!prop || !prop.type) return '';
  if (prop.type === 'formula') {
    const f = prop.formula;
    if (!f || !f.type) return '';
    if (f.type === 'string')  return f.string || '';
    if (f.type === 'number')  return (typeof f.number === 'number') ? String(f.number) : '';
    if (f.type === 'boolean') return f.boolean ? 'true' : 'false';
    if (f.type === 'date')    return f.date?.start || '';
    return '';
  }
  if (prop.type === 'rich_text') return plain(prop.rich_text);
  if (prop.type === 'title')     return plain(prop.title);
  return '';
}

// Summary direkt aus Event-Feldern zusammenbauen (stabil, unabhängig von Rollups)
function composeSummaryFromEvent(evtPage) {
  const readAny = (p, names) => {
    for (const n of names) {
      const prop = evtPage?.properties?.[n];
      if (!prop) continue;
      // select, rich_text, title, formula, date, etc. → text
      if (prop.type === 'select')  return prop.select?.name || '';
      if (prop.type === 'multi_select') return (prop.multi_select || []).map(o=>o.name).join(', ');
      if (prop.type === 'date')    return prop.date?.start || '';
      const t = extractText(prop);
      if (t) return t;
    }
    return '';
  };

  const date     = readAny(evtPage, ['Date + Time','Date + Time)','Date/Time','Date','Datetime']);
  const country  = readAny(evtPage, ['Country']);
  const stateDe  = readAny(evtPage, ['Bundesland (nur D)','Bundesland']); // NEU
  const location = readAny(evtPage, ['Location','City']);

  const website  = readAny(evtPage, ['Website','Web','URL']);
  const instagram= readAny(evtPage, ['Instagram','IG']);
  const facebook = readAny(evtPage, ['Facebook','FB']);

  const shortD   = readAny(evtPage, ['Short description','Short Description']);
  const vibe     = readAny(evtPage, ['Vibe/Notes','Vibe','Notes']);

  const lines = [];
  lines.push(`📅 Datum/Zeit: ${date || 'noch zu terminieren'}`);
  const locParts = [country, stateDe, location].filter(Boolean).join('/');
  lines.push(`🗺️ Location: ${locParts || '/'}`);
  {
    const links = [website, instagram, facebook].filter(Boolean).join('  ');
    lines.push(`🔗 Link: ${links}`);
  }
  lines.push('📃 Beschreibung und Vibe:');
  if (shortD) lines.push(shortD);
  if (vibe)   lines.push(vibe);

  return lines.join('\n').trim();
}

// Booking-Seite in schlankes Objekt mappen
function mapBookingPage(page, evtPage) {
  const pGig  = getProp(page, 'Gig');
  const pStat = getProp(page, 'Status');
  const pAvail= getProp(page, 'Artist availability');
  const pComm = getProp(page, 'Artist comment');

  const gig =
    pGig?.type === 'title' ? plain(pGig.title) :
    pGig?.type === 'rich_text' ? plain(pGig.rich_text) : '';

  const status =
    pStat?.type === 'status' ? (pStat.status?.name || '') :
    pStat?.type === 'select' ? (pStat.select?.name || '') : '';

  let availability = '';
  if (pAvail?.type === 'select')      availability = pAvail.select?.name || '';
  else if (pAvail?.type === 'rich_text') availability = plain(pAvail.rich_text);
  else if (pAvail?.type === 'formula') {
    const f = pAvail.formula;
    if (f?.type === 'string') availability = f.string || '';
  }

  const comment =
    pComm?.type === 'rich_text' ? plain(pComm.rich_text) :
    pComm?.type === 'title' ? plain(pComm.title) : '';

  // Summary aus Event-Seite zusammensetzen (robust)
  const summary = composeSummaryFromEvent(evtPage || { properties: {} });

  return { id: page.id, gig, summary, status, availability, comment };
}

// Relation-Seite des Events ermitteln (für Summary-Zusammenbau)
function getEventPageOfBooking(bookingPage) {
  // häufige Feldnamen für die Relation zur Event-DB
  const relNames = ['Event','Events','Gig/Event','Linked Event'];
  for (const name of relNames) {
    const p = getProp(bookingPage, name);
    if (p && p.type === 'relation' && Array.isArray(p.relation) && p.relation[0]?.id) {
      return p.relation[0].id;
    }
  }
  return null;
}

// ---------- main ----------
export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const miss = [];
  if (!process.env.NOTION_TOKEN) miss.push('NOTION_TOKEN');
  if (!DB_BOOK) miss.push('BOOKING_DB_ID');
  if (!DB_ART)  miss.push('ARTISTS_DB_ID');
  if (miss.length) return bad(res, 'Missing required values', miss);

  try {
    const {
      musicianId = '',
      cursor = null,
      q = '',
      sort = 'gig_asc',
      status = 'all',
      debug = '0'
    } = req.query || {};

    if (!musicianId) return bad(res, 'Missing musicianId');

    // 1) Artist finden
    const idFilters = [
      { property: 'WixOwnerID',    rich_text: { equals: String(musicianId) } },
      { property: 'Wix Owner ID',  rich_text: { equals: String(musicianId) } },
      { property: 'Wix Member ID', rich_text: { equals: String(musicianId) } }
    ];
    let artistPage = null, artistsQueryError = null;
    for (const f of idFilters) {
      try {
        const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
        if (r.results?.length) { artistPage = r.results[0]; break; }
      } catch (e) { artistsQueryError = e?.body || e?.message || String(e); }
    }
    if (!artistPage) {
      return res.status(404).json({
        error: 'Artist not found by Wix member id',
        hint: 'Prüfe ARTISTS_DB_ID und die Wix-ID im Artists-Record.',
        musicianId, artistsQueryError
      });
    }

    // 2) Booking-DB Eigenschaften holen → Owner-Feld & Typ ermitteln
    const bookMeta = await notion.databases.retrieve({ database_id: DB_BOOK });
    const props = bookMeta?.properties || {};
    // Priorität: Artist → OwnerID → Owner ID
    const ownerKeys = ['Artist','OwnerID','Owner ID'];
    let ownerKey = null, ownerType = null;

    for (const k of ownerKeys) {
      if (props[k]) { ownerKey = k; ownerType = props[k].type; break; }
    }
    if (!ownerKey) {
      return bad(res, 'Owner/Artist field not found in Booking DB',
        { tried: ownerKeys, available: Object.keys(props) });
    }

    // 3) Filterobjekt dynamisch bauen
    const andFilters = [];

    // Eigentümer-Filter NUR passend zum Typ setzen
    if (ownerType === 'relation') {
      andFilters.push({ property: ownerKey, relation: { contains: artistPage.id } });
    } else if (ownerType === 'rollup') {
      andFilters.push({ property: ownerKey, rollup: { any: { relation: { contains: artistPage.id } } } });
    } else {
      return bad(res, 'Owner field has unsupported type', { ownerKey, ownerType });
    }

    // "Potential" ausschließen
    andFilters.push({
      or: [
        { property: 'Status', status: { does_not_equal: 'Potential' } },
        { property: 'Status', select: { does_not_equal: 'Potential' } }
      ]
    });

    // Status optional
    const statusNorm = String(status || '').trim();
    if (statusNorm && statusNorm.toLowerCase() !== 'all') {
      andFilters.push({
        or: [
          { property: 'Status', status: { equals: statusNorm } },
          { property: 'Status', select: { equals: statusNorm } }
        ]
      });
    }

    // Suche im Titel
    const qNorm = String(q || '').trim();
    if (qNorm) andFilters.push({ property: 'Gig', title: { contains: qNorm } });

    // Sortierung
    const sorts = [];
    if (sort === 'gig_asc')  sorts.push({ property: 'Gig', direction: 'ascending' });
    else if (sort === 'gig_desc') sorts.push({ property: 'Gig', direction: 'descending' });
    else sorts.push({ timestamp: 'last_edited_time', direction: 'descending' });

    // Query (30/Seite)
    const params = { database_id: DB_BOOK, page_size: 30, sorts, filter: { and: andFilters } };
    if (cursor) params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // Für jedes Booking die verlinkte Event-Seite ziehen (für Summary)
    const results = [];
    for (const p of (r.results || [])) {
      // Event-Relation finden
      const evtId = getEventPageOfBooking(p);
      let evtPage = null;
      if (evtId) {
        try { evtPage = await notion.pages.retrieve({ page_id: evtId }); }
        catch (_) { /* not fatal */ }
      }
      results.push(mapBookingPage(p, evtPage));
    }

    const nextCursor = r.has_more ? r.next_cursor : null;

    const payload = { results, nextCursor, hasMore: !!r.has_more };
    if (debug === '1') {
      payload.debug = {
        ownerKey, ownerType,
        availableOwnerCandidates: ownerKeys,
        statusField: 'Status',
      };
    }

    res.json(payload);

  } catch (e) {
    console.error('@events error:', e?.body || e?.message || e);
    res.status(500).json({ error: 'Server error' });
  }
}
