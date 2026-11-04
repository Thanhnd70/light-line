/* Integration tests against a running `wrangler pages dev` on :8788.
   Focus: email validation, account separation, and cross-account access. */

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
let pass = 0, fail = 0;
const results = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/* A minimal cookie jar per simulated browser. */
function jar() {
  const store = new Map();
  return {
    headers() {
      return store.size ? { cookie: [...store].map(([k, v]) => `${k}=${v}`).join('; ') } : {};
    },
    absorb(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      for (const c of raw) {
        const [pair, ...attrs] = c.split(';');
        const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
        const maxAge = attrs.find(a => a.trim().toLowerCase().startsWith('max-age='));
        if (maxAge && maxAge.split('=')[1].trim() === '0') store.delete(k);
        else store.set(k, v);
      }
    },
    raw: () => store
  };
}

async function call(j, path, opts = {}) {
  const headers = { ...(opts.headers || {}), ...j.headers() };
  const res = await fetch(BASE + path, { ...opts, headers, redirect: 'manual' });
  j.absorb(res);
  let body = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) { try { body = await res.json(); } catch {} }
  else { body = await res.arrayBuffer(); }
  return { status: res.status, body, headers: res.headers };
}

const jsonPost = (j, path, data) =>
  call(j, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

/* A tiny valid PNG, built by hand so the test needs no fixtures. */
function pngBytes(byte) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = buf => {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const t = [...type].map(ch => ch.charCodeAt(0));
    const body = [...t, ...data];
    const len = data.length;
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body,
      ...[24, 16, 8, 0].map(s => (crc(body) >>> s) & 255)];
  };
  const ihdr = chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = chunk('IDAT', [0x08, 0xD7, 0x63, byte & 0xFF, byte & 0xFF, byte & 0xFF, byte & 0xFF, 0x00, 0x00, 0x05, 0xFE, 0x02, 0xFE]);
  const iend = chunk('IEND', []);
  return new Uint8Array([...sig, ...ihdr, ...idat, ...iend]);
}

function itemForm(title, folder, tint) {
  const fd = new FormData();
  fd.append('before', new File([pngBytes(tint)], 'b.png', { type: 'image/png' }));
  fd.append('after', new File([pngBytes(tint + 50)], 'a.png', { type: 'image/png' }));
  fd.append('title', title);
  if (folder) fd.append('folder', folder);
  fd.append('w', '1'); fd.append('h', '1'); fd.append('pos', '25');
  return fd;
}

const stamp = Date.now().toString(36);
const A = { email: `alice.${stamp}@example.com`, password: 'alice-password-1', name: 'Alice' };
const B = { email: `bob.${stamp}@example.com`, password: 'bob-password-22', name: 'Bob' };

(async () => {
  /* ---------- 1. email format ---------- */
  const bad = ['plainaddress', 'no-at-sign.com', '@nodomain.com', 'spaced out@example.com',
               'two@@example.com', 'trailing@example', 'dot..dots@example.com',
               'ends.with.dot.@example.com', 'a@b..com', '', '   ', 'user@-bad.com',
               'user@example.c', 'a'.repeat(70) + '@example.com'];
  for (const email of bad) {
    const r = await jsonPost(jar(), '/api/auth/register', { email, password: 'longenough123' });
    check(`rejects email ${JSON.stringify(email).slice(0, 40)}`, r.status === 400, `got ${r.status}`);
  }
  for (const email of [`ok.${stamp}+tag@example.co.uk`, `first.last.${stamp}@sub.example.com`]) {
    const r = await jsonPost(jar(), '/api/auth/register', { email, password: 'longenough123' });
    check(`accepts email ${email}`, r.status === 201, `got ${r.status} ${JSON.stringify(r.body)}`);
  }

  /* ---------- 2. password rules ---------- */
  check('rejects short password',
    (await jsonPost(jar(), '/api/auth/register', { email: `s.${stamp}@example.com`, password: 'short1' })).status === 400);

  /* ---------- 3. registration + duplicates ---------- */
  const ja = jar(), jb = jar();
  const regA = await jsonPost(ja, '/api/auth/register', A);
  check('registers account A', regA.status === 201, `got ${regA.status} ${JSON.stringify(regA.body)}`);
  check('A receives a session cookie', ja.raw().has('ll_session'));

  const dup = await jsonPost(jar(), '/api/auth/register', { ...A, name: 'Impostor' });
  check('rejects duplicate email', dup.status === 409, `got ${dup.status}`);

  const dupCase = await jsonPost(jar(), '/api/auth/register', { email: A.email.toUpperCase(), password: 'other-password-9' });
  check('rejects duplicate email in different case', dupCase.status === 409, `got ${dupCase.status}`);

  const regB = await jsonPost(jb, '/api/auth/register', B);
  check('registers account B', regB.status === 201, `got ${regB.status}`);

  /* ---------- 4. login ---------- */
  check('rejects wrong password',
    (await jsonPost(jar(), '/api/auth/login', { email: A.email, password: 'wrong-password-x' })).status === 401);
  check('rejects unknown account',
    (await jsonPost(jar(), '/api/auth/login', { email: `ghost.${stamp}@example.com`, password: 'whatever12' })).status === 401);

  const jaLogin = jar();
  const okLogin = await jsonPost(jaLogin, '/api/auth/login', { email: A.email.toUpperCase(), password: A.password });
  check('logs in, email case-insensitive', okLogin.status === 200, `got ${okLogin.status}`);

  const meA = await call(ja, '/api/auth/me');
  check('me returns A', meA.body && meA.body.user && meA.body.user.email === A.email, JSON.stringify(meA.body));
  const meB = await call(jb, '/api/auth/me');
  check('me returns B', meB.body && meB.body.user && meB.body.user.email === B.email);
  const meAnon = await call(jar(), '/api/auth/me');
  check('me returns null when signed out', meAnon.body && meAnon.body.user === null);

  /* ---------- 5. unauthenticated access ---------- */
  const anon = jar();
  for (const [path, opts] of [['/api/folders', {}], ['/api/items', {}],
                              ['/api/folders', { method: 'POST', headers: {'content-type':'application/json'}, body: '{"name":"x"}' }]]) {
    const r = await call(anon, path, opts);
    check(`401 for signed-out ${opts.method || 'GET'} ${path}`, r.status === 401, `got ${r.status}`);
  }

  /* ---------- 6. each account gets its own data ---------- */
  const fA = await call(ja, '/api/folders');
  const fB = await call(jb, '/api/folders');
  check('A starts with one folder', fA.body.folders.length === 1, JSON.stringify(fA.body));
  check('B starts with one folder', fB.body.folders.length === 1);
  check('A and B folder ids differ', fA.body.folders[0].id !== fB.body.folders[0].id);

  const aFolder = (await jsonPost(ja, '/api/folders', { name: 'Alice Retouch' })).body.folder;
  const bFolder = (await jsonPost(jb, '/api/folders', { name: 'Bob Retouch' })).body.folder;
  check('A created a folder', !!aFolder && !!aFolder.id);
  check('B created a folder', !!bFolder && !!bFolder.id);

  const sameNameOk = await jsonPost(jb, '/api/folders', { name: 'Alice Retouch' });
  check('B may reuse a folder name A used', sameNameOk.status === 201, `got ${sameNameOk.status}`);

  const aFolders = (await call(ja, '/api/folders')).body.folders.map(f => f.name);
  check('A does not see B folders', !aFolders.includes('Bob Retouch'), aFolders.join(','));

  /* ---------- 7. items and cross-account access ---------- */
  const aItem = (await call(ja, '/api/items', { method: 'POST', body: itemForm('Alice secret', aFolder.id, 10) })).body.item;
  const bItem = (await call(jb, '/api/items', { method: 'POST', body: itemForm('Bob secret', bFolder.id, 200) })).body.item;
  check('A saved an item', !!aItem && !!aItem.id);
  check('B saved an item', !!bItem && !!bItem.id);

  const aItems = (await call(ja, '/api/items')).body.items;
  const bItems = (await call(jb, '/api/items')).body.items;
  check('A sees only its own item', aItems.length === 1 && aItems[0].title === 'Alice secret', JSON.stringify(aItems.map(i => i.title)));
  check('B sees only its own item', bItems.length === 1 && bItems[0].title === 'Bob secret');

  const steal = await call(jb, `/api/items/${aItem.id}/image/before`);
  check("B cannot fetch A's image", steal.status === 404, `got ${steal.status}`);
  const stealAnon = await call(jar(), `/api/items/${aItem.id}/image/before`);
  check("signed-out cannot fetch A's image", stealAnon.status === 401, `got ${stealAnon.status}`);
  const own = await call(ja, `/api/items/${aItem.id}/image/before`);
  check('A can fetch its own image', own.status === 200 && own.body.byteLength > 0, `got ${own.status}`);

  const patchSteal = await call(jb, `/api/items/${aItem.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'hacked' })
  });
  check("B cannot rename A's item", patchSteal.status === 404, `got ${patchSteal.status}`);

  const moveSteal = await call(jb, `/api/items/${bItem.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder_id: aFolder.id })
  });
  check("B cannot move its item into A's folder", moveSteal.status === 404, `got ${moveSteal.status}`);

  const delSteal = await call(jb, `/api/items/${aItem.id}`, { method: 'DELETE' });
  check("B cannot delete A's item", delSteal.status === 404, `got ${delSteal.status}`);

  const folderSteal = await call(jb, `/api/folders/${aFolder.id}`, { method: 'DELETE' });
  check("B cannot delete A's folder", folderSteal.status === 404, `got ${folderSteal.status}`);

  const uploadSteal = await call(jb, '/api/items', { method: 'POST', body: itemForm('Into Alice folder', aFolder.id, 90) });
  check("B cannot upload into A's folder", uploadSteal.status === 404, `got ${uploadSteal.status}`);
  const aAfter = (await call(ja, '/api/items')).body.items;
  check("A's archive unchanged by B's upload attempt", aAfter.length === 1, JSON.stringify(aAfter.map(i => i.title)));

  const noFolder = new FormData();
  noFolder.append('before', new File([pngBytes(7)], 'b.png', { type: 'image/png' }));
  noFolder.append('after', new File([pngBytes(9)], 'a.png', { type: 'image/png' }));
  noFolder.append('title', 'No folder given');
  const defaulted = await call(jb, '/api/items', { method: 'POST', body: noFolder });
  check('upload with no folder lands in own default folder',
    defaulted.status === 201 && defaulted.body.item.folder_id &&
    (await call(jb, '/api/folders')).body.folders.some(f => f.id === defaulted.body.item.folder_id),
    `got ${defaulted.status}`);

  const listFilterSteal = (await call(jb, `/api/items?folder=${aFolder.id}`)).body.items;
  check("filtering by A's folder id returns nothing for B", listFilterSteal.length === 0, JSON.stringify(listFilterSteal));

  /* ---------- 8. upload validation ---------- */
  const notImage = new FormData();
  notImage.append('before', new File([new Uint8Array([1,2,3])], 'x.txt', { type: 'text/plain' }));
  notImage.append('after', new File([pngBytes(5)], 'a.png', { type: 'image/png' }));
  check('rejects a non-image upload',
    (await call(ja, '/api/items', { method: 'POST', body: notImage })).status === 400);

  const onlyOne = new FormData();
  onlyOne.append('before', new File([pngBytes(5)], 'b.png', { type: 'image/png' }));
  check('rejects an upload missing the after image',
    (await call(ja, '/api/items', { method: 'POST', body: onlyOne })).status === 400);

  /* ---------- 9. session lifecycle ---------- */
  const out = await call(ja, '/api/auth/logout', { method: 'POST' });
  check('logout succeeds', out.status === 200);
  check('cookie cleared after logout', !ja.raw().has('ll_session'));
  check('folders refused after logout', (await call(ja, '/api/folders')).status === 401);

  const forged = jar();
  forged.raw().set('ll_session', 'f'.repeat(64));
  check('forged session token refused', (await call(forged, '/api/folders')).status === 401);

  const stillB = await call(jb, '/api/auth/me');
  check("A's logout did not end B's session", stillB.body.user && stillB.body.user.email === B.email);

  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('Test run crashed:', e); process.exit(2); });
