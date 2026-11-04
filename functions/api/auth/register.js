import {
  json, bad, newId, newSalt, hashPassword, validateEmail, validatePassword,
  newSessionToken, hashToken, sessionCookie, PBKDF2_ITERATIONS, SESSION_DAYS
} from '../../_lib.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch { return bad('Send a JSON body.'); }

  const email = validateEmail(body.email);
  if (!email.ok) return bad(email.error);
  const pw = validatePassword(body.password);
  if (!pw.ok) return bad(pw.error);

  const name = String(body.name || '').trim().slice(0, 60) || email.email.split('@')[0];

  // The UNIQUE index on users.email is the real guard; this check is for the message.
  const taken = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.email).first();
  if (taken) return bad('An account with that email already exists. Sign in instead.', 409);

  const id = newId();
  const salt = newSalt();
  const hash = await hashPassword(pw.password, salt);
  const now = Date.now();

  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, pw_salt, pw_hash, pw_iter, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, email.email, name, salt, hash, PBKDF2_ITERATIONS, now).run();
  } catch (e) {
    // Lost a race against another signup with the same address.
    if (String(e).includes('UNIQUE')) return bad('An account with that email already exists. Sign in instead.', 409);
    throw e;
  }

  // Every account starts with its own Unsorted folder.
  await env.DB.prepare(
    'INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, ?)'
  ).bind(newId(), id, 'Unsorted', now).run();

  const token = newSessionToken();
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(await hashToken(token), id, now, now + SESSION_DAYS * 86400000).run();

  return json({ user: { email: email.email, name } }, 201, { 'set-cookie': sessionCookie(token, request) });
}
