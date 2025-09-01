import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_BOOK = process.env.BOOKING_DB_ID;
const DB_ART  = process.env.ARTISTS_DB_ID;

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

function composeSummaryFromEvent(evtPage) {
  const readAny = (p, names) => {
    for (const n of names) {
      const prop = evtPage?.properties?.[n];
      if (!prop) continue;
      if (prop.type === 'select')       return prop.select?.name || '';
      if (prop.type === 'multi_select') return (prop.multi_select || []).map(o=>o.name).join(', ');
      if (prop.type === 'date')         return prop.date?.start || '';
      const t = extractText(prop);
      if (t) return t;
    }
    return '';
  };

  const date     = readAny(evtPage, ['Date + Time','Date/Time','Date','Datetime']);
  const country  = readAny(evtPage, ['Country']);
  const stateDe  = readAny(evtPage, ['Bundesland (nur D)','Bundesland']);
  const location = readAny(evtPage, ['Location','City']);
  const website  = readAny(evtPage, ['Website','Web','URL']);
  const instagram= readAny(evtPage, ['Instagram','IG']);
  const facebook = readAny(evtPage, ['Facebook','FB']);
  const shortD   = readAny(evtPage, ['Short description','Short Description']);
  const vibe     = readAny(evtPage, ['Vibe/Notes','Vibe','Notes']);

  const lines = [];
  lines.push(`📅 Datum/Zeit: ${date || 'noch zu terminieren'}`);
  const loc = [country, stateDe, location].filter(Boolean).join('/') || '/';
  lines.push(`🗺️ Location: ${loc}`);
  lines.push(`🔗 Link: ${[website, instagram, facebook].filter(Boolean).join('  ')}`);
  lines.push('📃 Beschreibung und Vibe:');
  if (shortD) lines.push(shortD);
  if (vibe)   lines.push(vibe);
  return lines.join('\n').trim();
}

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

  const summary = composeSummaryFromEvent(evtPage || { properties: {} });
  return { id: page.id, gig, summary, status, availability, comment };
}

function getEventPageOfBooking(bookingPage) {
  const relNames = ['Event','Events','Gig/Event','Linked Event'];
  for (const name of relNames) {
    const p = getProp(bookingPage, name);
    if (p && p.type === 'relation' && Array.isArray(p.relation) && p.relation[0]?.id) {
      return p.relation[0].id;
    }
  }
  return null;
}

export default async function handler(req, res) {
  cors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const miss = [];
  if (!process.env.NOTION_TOKEN) miss.push('NOTION_TOKEN');
  if (!DB_BOOK) miss.push('BOOKING_DB_ID');
  if (!DB_ART)  miss.push('ARTISTS_DB_ID');
  if (miss.length) return bad(res, 'Missing required values', miss);

  const {
    musicianId = '',
    cursor = null,
    q = '',
    sort = 'gig_asc',
    status = 'all',
    debug = '0',
    noEvent = '0' // ← 1 = Events-DB abrufen überspringen
  } = req.query || {};
  if (!musicianId) return bad(res, 'Missing musicianId');

  const diag = { stage: 'init' };

  try {
    // 1) Artist finden
    diag.stage = 'artistLookup';
    const idFilters = [
      { property: 'WixOwnerID',    rich_text: { equals: String(musicianId) } },
      { property: 'Wix Owner ID',  rich_text: { equals: String(musicianId) } },
      { property: 'Wix Member ID', rich_text: { equals: String(musicianId) } }
    ];
    let artistPage = null;
    let artistsQueryError = null;
    for (const f of idFilters) {
      try {
        const r = await notion.databases.query({ database_id: DB_ART, page_size: 1, filter: f });
        if (r.results?.length) { artistPage = r.results[0]; break; }
      } catch (e) { artistsQueryError = e?.body || e?.message || String(e); }
    }
    if (!artistPage) {
      return bad(res, 'Artist not found by Wix member id', { musicianId, artistsQueryError });
    }

    // 2) Booking-DB Properties holen → Owner-Feld identifizieren
    diag.stage = 'bookingMeta';
    let bookMeta;
    try {
      bookMeta = await notion.databases.retrieve({ database_id: DB_BOOK });
    } catch (e) {
      return res.status(500).json({ error: 'Server error', stage: diag.stage, details: e?.body || e?.message || String(e) });
    }
    const props = bookMeta?.properties || {};
    const ownerCandidates = ['Artist','OwnerID','Owner ID'];
    let ownerKey = null, ownerType = null;
    for (const k of ownerCandidates) {
      if (props[k]) { ownerKey = k; ownerType = props[k].type; break; }
    }
    if (!ownerKey) {
      return bad(res, 'Owner/Artist field not found in Booking DB', { tried: ownerCandidates, available: Object.keys(props) });
    }

    // 3) Filter bauen (nur passenden Operator verwenden)
    diag.stage = 'queryBookings';
    const andFilters = [];
    if (ownerType === 'relation') {
      andFilters.push({ property: ownerKey, relation: { contains: artistPage.id } });
    } else if (ownerType === 'rollup') {
      andFilters.push({ property: ownerKey, rollup: { any: { relation: { contains: artistPage.id } } } });
    } else {
      return bad(res, 'Owner field has unsupported type', { ownerKey, ownerType });
    }

    andFilters.push({
      or: [
        { property: 'Status', status: { does_not_equal: 'Potential' } },
        { property: 'Status', select: { does_not_equal: 'Potential' } }
      ]
    });

    const statusNorm = String(status || '').trim();
    if (statusNorm && statusNorm.toLowerCase() !== 'all') {
      andFilters.push({
        or: [
          { property: 'Status', status: { equals: statusNorm } },
          { property: 'Status', select: { equals: statusNorm } }
        ]
      });
    }

    const qNorm = String(q || '').trim();
    if (qNorm) andFilters.push({ property: 'Gig', title: { contains: qNorm } });

    const sorts = [];
    if (sort === 'gig_asc')      sorts.push({ property: 'Gig', direction: 'ascending' });
    else if (sort === 'gig_desc') sorts.push({ property: 'Gig', direction: 'descending' });
    else                         sorts.push({ timestamp: 'last_edited_time', direction: 'descending' });

    const params = { database_id: DB_BOOK, page_size: 30, sorts, filter: { and: andFilters } };
    if (cursor) params.start_cursor = String(cursor);

    let queryRes;
    try {
      queryRes = await notion.databases.query(params);
    } catch (e) {
      return res.status(500).json({
        error: 'Server error',
        stage: diag.stage,
        ownerKey, ownerType,
        filterSent: params.filter,
        details: e?.body || e?.message || String(e)
      });
    }

    // 4) Optional: Event-Seiten laden (für Summary). Mit ?noEvent=1 überspringen.
    diag.stage = 'mapResults';
    const out = [];
    for (const p of (queryRes.results || [])) {
      let evtPage = null;
      if (noEvent !== '1') {
        const evtId = getEventPageOfBooking(p);
        if (evtId) {
          try {
            evtPage = await notion.pages.retrieve({ page_id: evtId });
          } catch (e) {
            // nicht fatal – wir liefern trotzdem; aber im Debug zeigen
            if (debug === '1') {
              out.push({
                ...mapBookingPage(p, null),
                _eventError: e?.body || e?.message || String(e)
              });
              continue;
            }
          }
        }
      }
      out.push(mapBookingPage(p, evtPage));
    }

    const payload = {
      results: out,
      nextCursor: queryRes.has_more ? queryRes.next_cursor : null,
      hasMore: !!queryRes.has_more
    };
    if (debug === '1') {
      payload.debug = { ownerKey, ownerType, stage: 'ok' };
    }
    res.json(payload);

  } catch (e) {
    res.status(500).json({ error: 'Server error', stage: 'topCatch', details: e?.body || e?.message || String(e) });
  }
}
