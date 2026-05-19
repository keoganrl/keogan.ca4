import type { APIRoute } from 'astro';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const secret = request.headers.get('x-webhook-secret');
  if (!secret || secret !== import.meta.env.NOTIFY_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body: { record?: { name?: string; message?: string } };
  try {
    body = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  const { name, message } = body?.record ?? {};
  if (!name || !message) {
    return new Response('Bad Request', { status: 400 });
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${import.meta.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Guestbook <onboarding@resend.dev>',
      to: 'keog@nlara.de',
      subject: `New guestbook entry from ${name}`,
      text: `${name} wrote:\n\n${message}`,
    }),
  });

  return new Response(res.ok ? 'OK' : 'Email failed', { status: res.ok ? 200 : 500 });
};
