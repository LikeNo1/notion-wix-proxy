// /pages/api/events-test.ts  (oder /app/api/events-test/route.ts)
import { NextRequest, NextResponse } from 'next/server';
import { getNotionEvents } from '@/lib/notion'; // dein Notion-Wrapper

export default async function handler(req, res) {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const statusesCSV = url.searchParams.get('statuses');        // Whitelist
    const excludeCSV  = url.searchParams.get('statusExclude');   // Blacklist

    const statuses = (statusesCSV || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const statusExclude = (excludeCSV || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    // ✳️ Bau hier deinen Notion-Filter:
    // - wenn statuses != leer → nur diese
    // - sonst wenn statusExclude != leer → alle außer diese
    const notionFilter = buildStatusFilter({ statuses, statusExclude });

    // Optional weitere Parameter (musicianId, cursor, sort, …) wie gehabt:
    const musicianId = url.searchParams.get('musicianId') || '';
    const cursor     = url.searchParams.get('cursor') || '';
    const sort       = url.searchParams.get('sort') || 'gig_asc';

    const { results, nextCursor } = await getNotionEvents({
      musicianId,
      cursor,
      sort,
      filter: notionFilter, // 👈 hier greift der Status-Filter!
    });

    return res.status(200).json({ results, nextCursor });
  } catch (e) {
    return res.status(500).send(String(e).slice(0, 1000));
  }
}

// Hilfsfunktion: erzeugt einen Notion-Filter für die Status-Property
function buildStatusFilter({ statuses, statusExclude }) {
  const statusProp = 'Status'; // <- Name deiner Status-Spalte in Notion

  if (Array.isArray(statuses) && statuses.length) {
    // Whitelist
    return {
      or: statuses.map(s => ({
        property: statusProp,
        select: { equals: s }
      }))
    };
  }
  if (Array.isArray(statusExclude) && statusExclude.length) {
    // Blacklist → als AND aus „nicht equals“
    return {
      and: statusExclude.map(s => ({
        property: statusProp,
        select: { does_not_equal: s }
      }))
    };
  }
  return undefined; // kein Status-Filter
}
