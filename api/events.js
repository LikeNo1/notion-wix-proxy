// /api/events.js
import { Client } from '@notionhq/client';

// === ENV ===
const notion   = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BOOK  = process.env.BOOKING_DB_ID;
const DB_ART   = process.env.ARTISTS_DB_ID;

// ---- CORS / Helpers -------------------------------------------------
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
function bad(res, msg, details) {
  return res.status(400).json({ error: msg, details });
}
function plain(rich) {
  if (Array.isArray(rich)) return rich.map(n => n?.plain_text || '').join('').trim();
  return '';
}
function getProp(page, key) { return page?.properties?.[key]; }

function extractTextFromProp(prop) {
  if (!prop || !prop.type) return '';
  switch (prop.type) {
    case 'formula': {
      const f = prop.formula;
      if (!f || !f.type) return '';
      if (f.type === 'string')  return f.string || '';
      if (f.type === 'number')  return (typeof f.number === 'number') ? String(f.number) : '';
      if (f.type === 'boolean') return f.boolean ? 'true' : 'false';
      if (f.type === 'date')    return f.date?.start || '';
      return '';
    }
    case 'rich_text': return plain(prop.rich_text);
    case 'title':     return plain(prop.title);
    case 'rollup': {  // falls Summary ein Rollup ist (z.B. rollup.string)
      const r = prop.rollup;
      if (!r) return '';
      if (r.type === 'array') {
        // Ziehe Plaintext aus Teilobjekten (häufig title/rich_text in array)
        return (r.array || [])
          .map(x => extractTextFromProp(x)) // rekursiv
          .filter(Boolean)
          .join(' ')
          .trim();
      }
      if (r.type === 'number') return (typeof r.number === 'number') ? String(r.number) : '';
      if (r.type === 'date')   return r.date?.start || '';
      if (r.type === 'unsupported') return '';
      return '';
    }
    default: return '';
  }
}

function mapBookingPage(page) {
  const pGig   = getProp(page, 'Gig');
  const pStat  = getProp(page, 'Status');
  const pSum   = getProp(page, 'Summary');              // Summary direkt (Formula / Rollup / Text)
  const pAvail = getProp(page, 'Artist availability');
  const pComm  = getProp(page, 'Artist comment');

  const gig =
    pGig?.type === 'title' ? plain(pGig.title) :
    pGig?.type === 'rich_text' ? plain(pGig.rich_text) : '';

  const status =
    pStat?.type === 'status' ? (pStat.status?.name || '') :
    pStat?.type === 'select' ? (pStat.select?.name || '') : '';

  const summary = extractTextFromProp(pSum);

  let availability = '';
  if (pAvail?.type === 'select')         availability = pAvail.select?.name || '';
  else if (pAvail?.type === 'rich_text') availability = plain(pAvail.rich_text);
  else if (pAvail?.type === 'formula') {
    const f = pAvail.formula;
    if (f?.type === 'string') availability = f.string || '';
  }

  const comment =
    pComm?.type === 'rich_text' ? plain(pComm.rich_text) :
    pComm?.type === 'title' ? plain(pComm.title) : '';

  return {
    id: page.id,
    gig, summary, status, availability, comment
  };
}

function normalizeStatus(s = '') {
  const str = String(s || '').trim();
  if (/^follow-?up\s*(1|2)?/i.test(str)) return 'In application';
  return str;
}

// ---- Handler --------------------------------------------------------
export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const missing = [];
  if (!process.env.NOTION_TOKEN) missing.push('NOTION_TOKEN');
  if (!DB_BOOK) missing.push('BOOKING_DB_ID');
  if (!DB_ART)  missing.push('ARTISTS_DB_ID');
  if (missing.length) return bad(res, 'Missing required values', missing);

  try {
    const {
      musicianId = '',
      cursor = null,
      q = '',
      sort = 'gig_asc',
      status = 'all',
      pageSize // optional: 10 / 20 / 30 …
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
      } catch (e) {
        artistsQueryError = e?.body || e?.message || String(e);
      }
    }
    if (!artistPage) {
      return res.status(404).json({
        error: 'Artist not found by Wix member id',
        hint: 'Prüfe ARTISTS_DB_ID und dass die Wix-ID exakt in einem Textfeld steht.',
        musicianId,
        artistsQueryError
      });
    }

    // 2) Filter Booking-DB
    const andFilters = [];

    // Eigentümer: flache OR-Liste (Relation + Rollup)
    const ownerOr = [
      { property: 'OwnerID', relation: { contains: artistPage.id } },
      { property: 'Owner ID', relation: { contains: artistPage.id } },
      { property: 'Artist',  relation: { contains: artistPage.id } },

      { property: 'OwnerID', rollup: { any: { relation: { contains: artistPage.id } } } },
      { property: 'Owner ID', rollup: { any: { relation: { contains: artistPage.id } } } }
    ];
    andFilters.push({ or: ownerOr });

    // "Potential" strikt ausschließen
    andFilters.push({
      or: [
        { property: 'Status', status: { does_not_equal: 'Potential' } },
        { property: 'Status', select: { does_not_equal: 'Potential' } }
      ]
    });

    // Optional: Status-Filter
    const statusNorm = String(status || '').trim();
    if (statusNorm && statusNorm.toLowerCase() !== 'all') {
      andFilters.push({
        or: [
          { property: 'Status', status: { equals: statusNorm } },
          { property: 'Status', select: { equals: statusNorm } }
        ]
      });
    }

    // Optional: Suche im Titel
    const qNorm = String(q || '').trim();
    if (qNorm) andFilters.push({ property: 'Gig', title: { contains: qNorm } });

    const filterObj = andFilters.length ? { and: andFilters } : undefined;

    // 3) Sortierung
    const sorts = [];
    if (sort === 'gig_asc')  sorts.push({ property: 'Gig', direction: 'ascending' });
    else if (sort === 'gig_desc') sorts.push({ property: 'Gig', direction: 'descending' });
    else sorts.push({ timestamp: 'last_edited_time', direction: 'descending' });

    // 4) Query
    let size = parseInt(pageSize, 10);
    if (!Number.isFinite(size) || size <= 0 || size > 100) size = 30;

    const params = {
      database_id: DB_BOOK,
      page_size: size,
      sorts
    };
    if (filterObj) params.filter = filterObj;
    if (cursor)    params.start_cursor = String(cursor);

    const r = await notion.databases.query(params);

    // 5) Mappen
    const results = (r.results || [])
      .map(mapBookingPage)
      .map(x => ({ ...x, status: normalizeStatus(x.status) }));

    const nextCursor = r.has_more ? r.next_cursor : null;

    // 6) Antwort (+etwas Debug bei Bedarf)
    res.json({
      results,
      nextCursor,
      hasMore: !!r.has_more,
      debug: (req.query.debug ? {
        ownerTried: ['OwnerID','Owner ID','Artist', 'OwnerID(rollup)','Owner ID(rollup)'],
        statusType: getProp(r.results?.[0], 'Status')?.type || null,
        summaryType: getProp(r.results?.[0], 'Summary')?.type || null
      } : undefined)
    });

  } catch (e) {
    // WICHTIG: gib den echten Notion-Body zurück
    const details = e?.body || e?.message || String(e);
    console.error('@events error:', details);
    res.status(500).json({ error: 'Server error', details });
  }
}
