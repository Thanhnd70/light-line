import { json, bad, withUser } from '../../../_lib.js';

/* Move or rename. Matched on (id, user_id), so another account's item is simply
   not found — nothing here takes a user id from the request. */
export const onRequestPatch = withUser(async ({ request, params, env }, user) => {
  let body;
  try { body = await request.json(); } catch { return bad('Send a JSON body.'); }

  const item = await env.DB.prepare('SELECT id FROM items WHERE id = ? AND user_id = ?')
    .bind(params.id, user.id).first();
  if (!item) return bad('Comparison not found.', 404);

  const sets = [], binds = [];

  if (body.title !== undefined) {
    const title = String(body.title).trim().slice(0, 120);
    if (!title) return bad('Give the comparison a title.');
    sets.push('title = ?'); binds.push(title);
  }

  if (body.folder_id !== undefined) {
    const owned = await env.DB.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
      .bind(String(body.folder_id), user.id).first();
    if (!owned) return bad('Folder not found.', 404);
    sets.push('folder_id = ?'); binds.push(owned.id);
  }

  if (body.pos !== undefined) {
    const pos = Math.min(100, Math.max(0, parseFloat(body.pos) || 0));
    sets.push('pos = ?'); binds.push(pos);
  }

  if (!sets.length) return bad('Nothing to change.');

  binds.push(params.id, user.id);
  await env.DB.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).bind(...binds).run();
  return json({ ok: true });
});

export const onRequestDelete = withUser(async ({ params, env }, user) => {
  const item = await env.DB.prepare('SELECT id, before_key, after_key FROM items WHERE id = ? AND user_id = ?')
    .bind(params.id, user.id).first();
  if (!item) return bad('Comparison not found.', 404);

  await env.DB.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').bind(params.id, user.id).run();
  await env.BUCKET.delete([item.before_key, item.after_key]);

  return json({ ok: true });
});
