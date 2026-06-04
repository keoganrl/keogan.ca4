export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const r = await fetch(
    `${process.env.PUBLIC_SUPABASE_URL}/rest/v1/guestbook_entries?select=id&limit=1`,
    { headers: { apikey: process.env.PUBLIC_SUPABASE_ANON_KEY } }
  );
  if (!r.ok) return res.status(500).json({ ok: false, status: r.status });
  return res.status(200).json({ ok: true, pinged: new Date().toISOString() });
}
