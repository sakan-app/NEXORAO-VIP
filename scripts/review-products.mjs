// Product review for the catalogue owner.
//   node scripts/review-products.mjs              writes review/products.html: every active CJ product with photo,
//                                                 price and a checkbox; the page builds the hide command for you.
//   node scripts/review-products.mjs --hide <ids> hides those products (comma separated ids; active = false).
//   node scripts/review-products.mjs --show <ids> shows them again.
// review/ is git-ignored: the page lists supplier prices and is for the owner only.
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const flag = ['--hide', '--show'].find(f => process.argv.includes(f));

if (flag) {
  const ids = String(process.argv[process.argv.indexOf(flag) + 1] || '').split(',').map(x => x.trim()).filter(x => /^[0-9a-f-]{36}$/.test(x));
  if (!ids.length) { console.error(`Usage: node scripts/review-products.mjs ${flag} <id,id,...>`); process.exit(1); }
  const { count } = await prisma.product.updateMany({ where: { id: { in: ids } }, data: { active: flag === '--show' } });
  console.log(`${flag === '--show' ? 'Shown' : 'Hidden'}: ${count} of ${ids.length} products.`);
  await prisma.$disconnect();
  process.exit(0);
}

const products = await prisma.product.findMany({
  where: { active: true, cjPid: { not: null } },
  select: { id: true, name: true, category: true, priceCents: true, supplierPriceUsd: true, shippingUsd: true, imageUrl: true, _count: { select: { variants: { where: { active: true } } } } },
  orderBy: [{ category: 'asc' }, { priceCents: 'desc' }]
});
await prisma.$disconnect();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const euro = c => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const groups = [...new Set(products.map(p => p.category))];
const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXORA Produktprüfung</title><style>
body{margin:0;font:14px/1.5 system-ui,sans-serif;background:#f4f4f2;color:#1b1a1d}
header{position:sticky;top:0;background:#1b1a1d;color:#fff;padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;z-index:1}
header code{background:#000;padding:8px 10px;border-radius:4px;font-size:12px;max-width:60vw;overflow:auto;white-space:nowrap;display:block}
button{font:inherit;padding:8px 14px;border:0;border-radius:4px;background:#c9a55c;color:#111;cursor:pointer}
h2{margin:28px 20px 10px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px;padding:0 20px}
label{display:block;background:#fff;border:2px solid transparent;border-radius:6px;overflow:hidden;cursor:pointer}
label:has(input:checked){border-color:#c0392b;opacity:.55}
img{width:100%;aspect-ratio:4/5;object-fit:cover;display:block;background:#e6e3dd}
.m{padding:8px 10px}.m b{display:block;font-weight:500}.m small{color:#666}
input{margin-right:6px}
</style></head><body>
<header><strong>${products.length} aktive Produkte</strong><span>Markieren, was ausgeblendet werden soll.</span>
<button id="copy" type="button">Befehl kopieren</button><code id="cmd">Noch nichts markiert</code></header>
${groups.map(g => `<h2>${esc(g)} (${products.filter(p => p.category === g).length})</h2><div class="grid">${products.filter(p => p.category === g).map(p => `
<label><img src="${esc(p.imageUrl)}" alt="" loading="lazy"><div class="m"><input type="checkbox" value="${p.id}"><b>${esc(p.name)}</b>
<small>${euro(p.priceCents)} · Einkauf $${Number(p.supplierPriceUsd ?? 0).toFixed(2)} + $${Number(p.shippingUsd ?? 0).toFixed(2)} Versand · ${p._count.variants} Varianten</small></div></label>`).join('')}</div>`).join('')}
<script>
const cmd=document.getElementById('cmd');
const ids=()=>[...document.querySelectorAll('input:checked')].map(i=>i.value);
document.addEventListener('change',()=>{const l=ids();cmd.textContent=l.length?'node scripts/review-products.mjs --hide '+l.join(','):'Noch nichts markiert'});
document.getElementById('copy').onclick=()=>{if(ids().length)navigator.clipboard.writeText(cmd.textContent).then(()=>{document.getElementById('copy').textContent='Kopiert'})};
</script></body></html>`;
mkdirSync('review', { recursive: true });
writeFileSync('review/products.html', html);
console.log(`review/products.html: ${products.length} products in ${groups.length} categories.`);
