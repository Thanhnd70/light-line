import { chromium } from 'playwright';

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1180, height: 1000 } });
p.on('pageerror', e => console.log('PAGE ERROR:', e.message));

await p.goto('http://127.0.0.1:8788/', { waitUntil: 'domcontentloaded' });
await p.click('#tabRegister');
await p.fill('#auName', 'Thanh');
await p.fill('#auEmail', 'geom' + Date.now() + '@example.com');
await p.fill('#auPass', 'strong-password-1');
await p.click('#authSubmit');
await p.waitForSelector('#appView:not([hidden])', { timeout: 15000 });

// Build an image with an explicit size and a grid, so misalignment is obvious.
const mk = (w, h, hue, label) => p.evaluate(async ([w, h, hue, label]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsl(${hue},55%,28%)`); g.addColorStop(1, `hsl(${hue + 35},65%,62%)`);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  // quarter gridlines — these must line up across the reveal
  x.strokeStyle = 'rgba(255,255,255,.9)'; x.lineWidth = Math.max(2, w / 400);
  for (let i = 1; i < 4; i++) {
    x.beginPath(); x.moveTo(w * i / 4, 0); x.lineTo(w * i / 4, h); x.stroke();
    x.beginPath(); x.moveTo(0, h * i / 4); x.lineTo(w, h * i / 4); x.stroke();
  }
  x.fillStyle = 'rgba(255,255,255,.95)';
  x.font = `bold ${Math.round(h / 12)}px sans-serif`;
  x.fillText(label, w * 0.04, h * 0.12);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}, [w, h, hue, label]);

async function loadPair(bw, bh, aw, ah) {
  const bb = await mk(bw, bh, 210, `BEFORE ${bw}x${bh}`);
  const ab = await mk(aw, ah, 25, `AFTER ${aw}x${ah}`);
  await p.setInputFiles('#fileBefore', { name: 'before.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(bb) });
  await p.setInputFiles('#fileAfter', { name: 'after.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(ab) });
  await p.waitForSelector('#stageWrap:not([hidden])');
  await p.waitForTimeout(500);
}

// Measures the rectangle each layer actually paints into, the way the browser
// resolves object-fit — this is what must match between the two layers.
const measure = () => p.evaluate(() => {
  const st = document.getElementById('stage');
  const r = st.getBoundingClientRect();
  const rect = img => {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const fit = getComputedStyle(img).objectFit;
    const scale = fit === 'contain' ? Math.min(r.width / iw, r.height / ih)
                : fit === 'cover'   ? Math.max(r.width / iw, r.height / ih)
                : null;
    if (scale === null) return { fit };
    const dw = iw * scale, dh = ih * scale;
    return { fit, x: +((r.width - dw) / 2).toFixed(2), y: +((r.height - dh) / 2).toFixed(2),
             w: +dw.toFixed(2), h: +dh.toFixed(2) };
  };
  return {
    stage: { w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
    before: rect(document.getElementById('imgBefore')),
    after: rect(document.getElementById('imgAfter')),
    noticeShown: !document.getElementById('fitNotice').hidden
  };
});

let fails = 0;
const report = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) fails++;
};
const same = (a, b) => Math.abs(a - b) < 0.75;
const rectsMatch = m => same(m.before.x, m.after.x) && same(m.before.y, m.after.y) &&
                        same(m.before.w, m.after.w) && same(m.before.h, m.after.h);

console.log('\nCase 1 — same shape, after much larger (1200x800 before, 4000x2667 after)');
await loadPair(1200, 800, 4000, 2667);
let m = await measure();
report('both layers paint the identical rectangle', rectsMatch(m), JSON.stringify(m.before) + ' vs ' + JSON.stringify(m.after));
report('both fill the stage exactly', same(m.before.w, m.stage.w) && same(m.before.h, m.stage.h));
report('no shape warning shown', !m.noticeShown);
await p.screenshot({ path: '/tmp/claude-0/g1-same-shape.png' });

console.log('\nCase 2 — same shape, after SMALLER than before (3000x2000 before, 900x600 after)');
await loadPair(3000, 2000, 900, 600);
m = await measure();
report('both layers paint the identical rectangle', rectsMatch(m), JSON.stringify(m.before) + ' vs ' + JSON.stringify(m.after));
report('no shape warning shown', !m.noticeShown);

console.log('\nCase 3 — different shapes (1000x1000 square before, 2000x1000 wide after)');
await loadPair(1000, 1000, 2000, 1000);
m = await measure();
report('warning shown', m.noticeShown);
report('default is Match edges (cover)', m.before.fit === 'cover' && m.after.fit === 'cover', `${m.before.fit}/${m.after.fit}`);
report('both fill the whole frame, edges aligned',
  same(m.before.w, m.stage.w) && same(m.after.w, m.stage.w) &&
  m.before.h >= m.stage.h - 0.75 && m.after.h >= m.stage.h - 0.75,
  JSON.stringify(m));
report('horizontal mapping identical (x and width match)',
  same(m.before.x, m.after.x) && same(m.before.w, m.after.w));
// drag the line to 50% and shoot it
let bx = await p.locator('#stage').boundingBox();
await p.mouse.move(bx.x + 2, bx.y + bx.height / 2);
await p.mouse.down();
await p.mouse.move(bx.x + bx.width * 0.5, bx.y + bx.height / 2, { steps: 15 });
await p.mouse.up();
await p.waitForTimeout(250);
await p.screenshot({ path: '/tmp/claude-0/g2-cover.png' });

console.log('\nCase 4 — same pair, switched to Show all (contain)');
await p.click('#fitContain');
await p.waitForTimeout(350);
m = await measure();
report('both layers use contain', m.before.fit === 'contain' && m.after.fit === 'contain');
report('both fully inside the frame (nothing cropped)',
  m.before.w <= m.stage.w + 0.75 && m.before.h <= m.stage.h + 0.75 &&
  m.after.w <= m.stage.w + 0.75 && m.after.h <= m.stage.h + 0.75, JSON.stringify(m));
report('same scale rule applied to both', m.before.fit === m.after.fit);
await p.screenshot({ path: '/tmp/claude-0/g3-contain.png' });

console.log('\nCase 5 — save and reopen keeps the geometry');
await p.click('#fitCover');
await p.waitForTimeout(200);
await p.fill('#saveTitle', 'Mismatched pair');
await p.click('#saveBtn');
await p.waitForTimeout(3000);
await p.click('#navArchive');
await p.waitForSelector('.card .shot', { timeout: 10000 });
await p.click('.card .shot');
await p.waitForSelector('#mStage', { timeout: 10000 });
await p.waitForTimeout(1200);
const mm = await p.evaluate(() => {
  const st = document.getElementById('mStage');
  const r = st.getBoundingClientRect();
  const imgs = st.querySelectorAll('img');
  const rect = img => {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const fit = getComputedStyle(img).objectFit;
    const scale = fit === 'contain' ? Math.min(r.width / iw, r.height / ih) : Math.max(r.width / iw, r.height / ih);
    const dw = iw * scale, dh = ih * scale;
    return { fit, x: +((r.width - dw) / 2).toFixed(2), w: +dw.toFixed(2) };
  };
  return { stage: +r.width.toFixed(2), after: rect(imgs[0]), before: rect(imgs[1]),
           ar: st.style.aspectRatio };
});
report('reopened viewer keeps cover fit', mm.before.fit === 'cover' && mm.after.fit === 'cover', JSON.stringify(mm));
report('reopened layers share the horizontal mapping', same(mm.before.x, mm.after.x) && same(mm.before.w, mm.after.w), JSON.stringify(mm));
let mb = await p.locator('#mStage').boundingBox();
await p.mouse.move(mb.x + 2, mb.y + mb.height / 2);
await p.mouse.down();
await p.mouse.move(mb.x + mb.width * 0.5, mb.y + mb.height / 2, { steps: 15 });
await p.mouse.up();
await p.waitForTimeout(250);
await p.screenshot({ path: '/tmp/claude-0/g4-reopened.png' });

console.log(`\n${fails} failed`);
await b.close();
process.exit(fails ? 1 : 0);
