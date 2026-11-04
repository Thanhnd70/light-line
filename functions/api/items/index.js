import { json, bad, newId, withUser, MAX_IMAGE_BYTES, ALLOWED_TYPES } from '../../_lib.js';

export const onRequestGet = withUser(async ({ request, env }, user) => {
  const url = new URL(request.url);
  const folder = url.searchParams.get('folder');

  // The user_id predicate is on every branch; folder is only ever a narrowing.
  const stmt = folder && folder !== 'all'
    ? env.DB.prepare(
        `SELECT id, folder_id, title, w, h, bw, bh, fit, pos, created_at, before_name, after_name
           FROM items WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC LIMIT 500`
      ).bind(user.id, folder)
    : env.DB.prepare(
        `SELECT id, folder_id, title, w, h, bw, bh, fit, pos, created_at, before_name, after_name
           FROM items WHERE user_id = ? ORDER BY created_at DESC LIMIT 500`
      ).bind(user.id);

  const { results } = await stmt.all();
  return json({ items: results || [] });
});

export const onRequestPost = withUser(async ({ request, env }, user) => {
  let form;
  try { form = await request.formData(); } catch { return bad('Send the images as multipart form data.'); }

  const before = form.get('before');
  const after = form.get('after');
  if (!(before instanceof File) || !(after instanceof File)) return bad('Attach both the before and after images.');

  for (const [label, file] of [['before', before], ['after', after]]) {
    if (!file.size) return bad(`The ${label} image is empty.`);
    if (file.size > MAX_IMAGE_BYTES) return bad(`The ${label} image is larger than 10 MB.`);
    if (!ALLOWED_TYPES.includes(file.type)) return bad(`The ${label} image must be a JPEG, PNG, WebP, GIF or AVIF.`);
  }

  const title = String(form.get('title') || '').trim().slice(0, 120) || 'Untitled comparison';
  const w  = Math.max(0, parseInt(form.get('w'),  10) || 0);
  const h  = Math.max(0, parseInt(form.get('h'),  10) || 0);
  const bw = Math.max(0, parseInt(form.get('bw'), 10) || 0);
  const bh = Math.max(0, parseInt(form.get('bh'), 10) || 0);
  const fit = form.get('fit') === 'contain' ? 'contain' : 'cover';
  const pos = Math.min(100, Math.max(0, parseFloat(form.get('pos')) || 0));

  // A folder id from the client is only honoured if this account owns it.
  // An id belonging to someone else is simply not found, never silently used.
  let folderId = String(form.get('folder') || '');
  if (folderId) {
    const owned = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
      .bind(folderId, user.id).first();
    if (!owned) return bad('Folder not found.', 404);
    folderId = owned.id;
  } else {
    const fallback = await env.DB.prepare(
      'SELECT id FROM folders WHERE user_id = ? ORDER BY created_at ASC LIMIT 1'
    ).bind(user.id).first();
    if (fallback) {
      folderId = fallback.id;
    } else {
      folderId = newId();
      await env.DB.prepare('INSERT INTO folders (id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
        .bind(folderId, user.id, 'Unsorted', Date.now()).run();
    }
  }

  const id = newId();
  // Keys are namespaced by account, so no object can collide across users.
  const beforeKey = `u/${user.id}/${id}/before`;
  const afterKey = `u/${user.id}/${id}/after`;

  await env.BUCKET.put(beforeKey, before.stream(), { httpMetadata: { contentType: before.type } });
  try {
    await env.BUCKET.put(afterKey, after.stream(), { httpMetadata: { contentType: after.type } });
  } catch (e) {
    await env.BUCKET.delete(beforeKey);
    throw e;
  }

  const created = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO items (id, user_id, folder_id, title, before_key, after_key,
                          before_type, after_type, before_name, after_name,
                          w, h, bw, bh, fit, pos, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, user.id, folderId, title, beforeKey, afterKey,
      before.type, after.type,
      String(before.name || 'before').slice(0, 120),
      String(after.name || 'after').slice(0, 120),
      w, h, bw, bh, fit, pos, created
    ).run();
  } catch (e) {
    // Don't leave orphaned objects paying for storage.
    await env.BUCKET.delete(beforeKey);
    await env.BUCKET.delete(afterKey);
    throw e;
  }

  return json({
    item: { id, folder_id: folderId, title, w, h, bw, bh, fit, pos, created_at: created,
            before_name: before.name, after_name: after.name }
  }, 201);
});
