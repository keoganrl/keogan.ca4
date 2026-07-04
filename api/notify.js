// Supabase database webhook target: fires on new guestbook_entries rows and
// emails a notification via Resend. Native Vercel function (matches
// keep-alive.js) — Astro's static output doesn't deploy src/pages/api routes.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const secret = req.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.NOTIFY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { name, message } = req.body?.record ?? {};
  if (!name || !message) {
    return res.status(400).json({ error: 'bad request' });
  }

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Guestbook <guestbook@keogan.ca>',
      to: 'keog@nlara.de',
      subject: `New guestbook entry from ${name}`,
      text: `${name} wrote:\n\n${message}`,
    }),
  });

  if (!r.ok) {
    const detail = await r.text();
    return res.status(500).json({ ok: false, status: r.status, detail });
  }
  return res.status(200).json({ ok: true });
}
