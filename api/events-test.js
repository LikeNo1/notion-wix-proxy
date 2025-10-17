// ... Imports, CORS usw. wie gehabt ...

async function findArtistByWixId(musicianId) {
  const id = String(musicianId || "").trim();
  const names = ["WixOwnerID","Wix Owner ID","Wix Member ID"];
  let lastErr = null;

  for (const p of names) {
    // equals
    try {
      const r1 = await notion.databases.query({ database_id: DB_ART, page_size: 1,
        filter: { property: p, rich_text: { equals: id } } });
      if (r1.results?.length) return r1.results[0];
    } catch(e) { lastErr = e?.body || e?.message || String(e); }

    // contains (tolerant)
    try {
      const r2 = await notion.databases.query({ database_id: DB_ART, page_size: 1,
        filter: { property: p, rich_text: { contains: id } } });
      if (r2.results?.length) return r2.results[0];
    } catch(e) { lastErr = e?.body || e?.message || String(e); }
  }
  return null;
}

export default async function handler(req, res) {
  // ... CORS, method checks ...
  const { musicianId = "", cursor = null, q = "", status = "" } = req.query || {};
  if (!musicianId) return res.status(400).json({ error: "Missing musicianId" });

  const artist = await findArtistByWixId(musicianId);
  if (!artist) return res.status(404).json({ error: "Artist not found by Wix member id", musicianId });

  // Booking-DB lesen und über Owner-Relation/Rollup genau auf diesen Artist filtern:
  // ownerName/ownerType wird zuvor aus der DB-Struktur ermittelt
  const ownerFilter =
    ownerType === "relation"
      ? { property: ownerName, relation: { contains: artist.id } }
      : { property: ownerName, rollup: { any: { relation: { contains: artist.id } } } };

  // ... Rest (Statusfilter, Suche, Mapping) ...
}
