// Fills the Product / ProductVariant tables with CJ Dropshipping products for each storefront category.
// Safe to re-run: products are keyed by cjPid, variants by cjVid, and updated in place.
// Usage: node scripts/import-cj-products.mjs [perCategory] [--only=<category>] [--dry-run]
//   Reads DATABASE_URL and CJ_API_KEY from .env. --dry-run lists what would be imported, without saving.
//
// NEXORA sells elegant, unbranded pieces: only products at or above MIN_SUPPLIER_PRICE (USD), never
// listings that name a designer brand (on CJ those are counterfeits, which EU customs seize and which
// infringe trademarks), and only names that match the category.
//
// Pricing (same rule as SakanVIP): supplier price (USD -> EUR, ECB rate) x 2.5 (MARKUP_PERCENT 150),
// plus CJ's cheapest shipping to Germany within MAX_SHIPPING_DAYS (incl. customs) and the EU import VAT
// CJ collects (IOSS), rounded to the nearest price ending in 9.99, at least MIN_PRICE.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const DRY_RUN = process.argv.includes('--dry-run');
const PER_CATEGORY = Number(process.argv.find(a => /^\d+$/.test(a)) || 12);
const ONLY = process.argv.find(a => a.startsWith('--only='))?.slice(7);
// Minimum supplier price (USD) per category: below these, CJ items rarely look premium.
const MIN_SUPPLIER = { women: 25, men: 25, evening: 35, watches: 45, gifts: 20, jewelry: 18, accessories: 30 };
const MIN_SUPPLIER_PRICE = Number(process.env.MIN_SUPPLIER_PRICE ?? 0); // optional floor for all categories
const minPrice = category => Math.max(MIN_SUPPLIER[category] ?? 25, MIN_SUPPLIER_PRICE);
const MARKUP_PERCENT = Number(process.env.MARKUP_PERCENT ?? 150);
const MIN_PRICE = Number(process.env.MIN_PRICE ?? 39.99);
const IOSS_RATE = Number(process.env.IOSS_RATE ?? 0.21);
const IOSS_FEE_USD = 0.05;
const MAX_SHIPPING_DAYS = Number(process.env.MAX_SHIPPING_DAYS ?? 20);
const SHIP_TO = process.env.SHIP_TO || 'DE';
const MAX_PAGES = 3;
const CJ = 'https://developers.cjdropshipping.com/api2.0/v1';

// Category ids match categoryConfig in index.html. Several searches per category; the first ones win.
const SEARCHES = [
  { category: 'women', keyword: 'silk dress women' },
  { category: 'women', keyword: 'satin blouse women' },
  { category: 'women', keyword: 'cashmere coat women' },
  { category: 'women', keyword: 'wool coat women' },
  { category: 'women', keyword: 'cashmere sweater women' },
  { category: 'men', keyword: 'wool blazer men' },
  { category: 'men', keyword: 'cashmere sweater men' },
  { category: 'men', keyword: 'wool coat men' },
  { category: 'men', keyword: 'silk shirt men' },
  { category: 'evening', keyword: 'satin evening gown' },
  { category: 'evening', keyword: 'sequin evening gown' },
  { category: 'evening', keyword: 'velvet evening dress' },
  { category: 'evening', keyword: 'lace evening gown' },
  // No perfume: in the EU it needs a responsible person and a CPNP notification (Regulation 1223/2009),
  // which CJ listings do not have, and CJ rarely ships liquids to Germany.
  { category: 'watches', keyword: 'automatic mechanical watch sapphire' },
  { category: 'watches', keyword: 'mechanical watch stainless steel' },
  { category: 'watches', keyword: 'women automatic watch' },
  { category: 'gifts', keyword: '925 sterling silver necklace' },
  { category: 'gifts', keyword: 'pearl necklace' },
  { category: 'gifts', keyword: 'moissanite ring' },
  { category: 'gifts', keyword: '18k gold plated earrings' },
  { category: 'jewelry', keyword: '925 sterling silver bracelet' },
  { category: 'jewelry', keyword: '925 sterling silver earrings' },
  { category: 'jewelry', keyword: 'freshwater pearl earrings' },
  { category: 'jewelry', keyword: 'moissanite necklace' },
  { category: 'jewelry', keyword: '18k gold plated ring' },
  { category: 'accessories', keyword: 'genuine leather handbag' },
  { category: 'accessories', keyword: 'silk scarf' },
  { category: 'accessories', keyword: 'genuine leather belt' },
  { category: 'accessories', keyword: 'genuine leather wallet' },
  { category: 'accessories', keyword: 'cashmere scarf' }
];

// Designer names and replica wording: never imported.
const BRANDS = /\b(gucci|louis ?vuitton|lv|chanel|dior|prada|herm[eè]s|rolex|cartier|omega|versace|armani|burberry|fendi|balenciaga|ysl|saint ?laurent|givenchy|valentino|bvlgari|bulgari|tiffany|patek|audemars|piguet|michael ?kors|coach|celine|c[eé]line|loewe|bottega|moncler|tom ?ford|calvin ?klein|hublot|tag ?heuer|breitling|longines|tissot|seiko|casio|swarovski|pandora|montblanc|mont ?blanc|ralph ?lauren|lacoste|boss|hugo|dolce|gabbana|d&g|miu ?miu|jimmy ?choo|creed|byredo|replica|copy|dupe|inspired|1:1|aaa)\b/i;
// Words that do not fit a luxury store: cheap materials, casual or novelty wording, odd machine translations.
const EXCLUDED = /\b(baby|infant|toddler|kids?|child(ren)?'?s?|girls'?|boys'?|pet|puppy|dog|cat|costume|halloween|cosplay|cos|cheap|wholesale|sexy|lingerie|pajamas?|sleepwear|plus size|pregnan\w*|maternity|usb|led|tool|kitchen|car|fishing|garden|sports?|gym|workout|yoga|running|digital|smart ?watch|cartoon|anime|funny|novelty|casual|simple|basic|printed|print|letters?|slogan|hot sale|trendy|trend|cute|korean|loose|oversized|beer|pu|faux|imitation|plastic|acrylic|polyester|quartz|student|couple|neon|rainbow|fluorescent|multicolor|20\d\d|new style|fashion)\b/i;
// Each category needs a premium material or build in the product name.
const MATERIALS = {
  women: /\b(silk|satin|cashmere|wool|merino|velvet|linen|lace|tweed|mulberry)\b/i,
  men: /\b(silk|cashmere|wool|merino|velvet|linen|tweed|mulberry)\b/i,
  evening: /\b(satin|silk|velvet|lace|sequin(ed)?|beaded|crystal|chiffon)\b/i,
  watches: /\b(automatic|mechanical|sapphire|tourbillon|stainless steel)\b/i,
  gifts: /\b(925|sterling|18k|14k|gold|pearl|moissanite|zircon|cubic zirconia)\b/i,
  jewelry: /\b(925|sterling|18k|14k|gold|pearl|moissanite)\b/i,
  accessories: /\b(genuine leather|cowhide|calfskin|real leather|suede|silk|cashmere|mulberry)\b/i
};
const CATEGORY_WORDS = {
  women: /dress|blouse|shirt|coat|blazer|skirt|cardigan|sweater|suit|trench|jumpsuit/i,
  men: /blazer|suit|sweater|coat|shirt|jacket|cardigan|trousers|pants|overcoat/i,
  evening: /dress|gown/i,
  watches: /watch/i,
  gifts: /necklace|bracelet|earrings?|ring|pendant|brooch|cufflinks?/i,
  jewelry: /necklace|bracelet|bangle|earrings?|\bring\b|pendant|brooch|anklet/i,
  accessories: /bag|handbag|scarf|shawl|belt|wallet|card holder|clutch|purse|tote/i
};
const fitsStore = (name, category) => !BRANDS.test(name) && !EXCLUDED.test(name) &&
  (!CATEGORY_WORDS[category] || CATEGORY_WORDS[category].test(name)) && (!MATERIALS[category] || MATERIALS[category].test(name));
// Variant colours that do not fit the palette are not offered.
const LOUD_COLOR = /\b(neon|fluorescent|rainbow|multi-?colou?r|colorful|hot pink|rose red|fuchsia|lime|orange|yellow|purple|light green|candy)\b/i;

// CJ titles are keyword lists ("Niche Original Genuine Genuine Leather Handbag"): drop filler words and
// repeats, and use title case, so names read like a boutique's.
const FILLER = /\b(niche|original|new|female|male|ladies'?|women'?s|men'?s|for (women|men|ladies)|high-end|high end|luxury|exquisite|fully|style)\b/gi;
function cleanName(name) {
  const words = name.replace(FILLER, ' ').replace(/[,;|]+/g, ' ').split(/\s+/).filter(Boolean)
    .filter((w, i, all) => i === 0 || w.toLowerCase() !== all[i - 1].toLowerCase());
  const small = new Set(['and', 'with', 'of', 'in', 'for', 'the', 'a']);
  return words.map((w, i) => /^\d|[A-Z]{2,}/.test(w) || (i && small.has(w.toLowerCase())) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ').slice(0, 120) || name;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstNumber = value => {
  const n = Number(String(value ?? '').trim().split('-')[0].trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

let token, USD_PER_EUR = Number(process.env.USD_PER_EUR) || null;
async function cj(path, init = {}) {
  await sleep(1200); // CJ allows about one request per second
  let response;
  // Short network drops should not end a long import: retry up to three times.
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch(CJ + path, { ...init, headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json', ...init.headers } });
      break;
    } catch (err) {
      if (attempt >= 4) throw err;
      await sleep(5000 * attempt);
    }
  }
  const body = await response.json();
  if (!response.ok || body.result === false) throw new Error(`CJ ${path}: ${body.message || response.status}`);
  return body.data;
}

const retailCents = (supplierUsd, shippingUsd) => {
  const eurCents = Math.round(supplierUsd * 100 / USD_PER_EUR);
  const costsUsd = shippingUsd + supplierUsd * IOSS_RATE + IOSS_FEE_USD;
  let cents = Math.round(eurCents * (100 + MARKUP_PERCENT) / 100) + Math.round(costsUsd * 100 / USD_PER_EUR);
  const below = Math.floor((cents + 1) / 1000) * 1000 - 1; // highest x9.99 at or below
  cents = cents - below <= below + 1000 - cents ? below : below + 1000;
  return Math.max(cents, Math.round(MIN_PRICE * 100));
};

// Cheapest real shipping (USD) to SHIP_TO for one unit of the first variant, within MAX_SHIPPING_DAYS;
// null when CJ cannot ship it there (then the product is skipped).
async function shippingUsd(detail) {
  const vid = detail?.variants?.[0]?.vid;
  if (!vid) return null;
  const quotes = await cj('/logistic/freightCalculate', {
    method: 'POST', body: JSON.stringify({ startCountryCode: 'CN', endCountryCode: SHIP_TO, products: [{ quantity: 1, vid }] })
  });
  const days = q => Math.max(...String(q.logisticAging || '').split('-').map(Number).filter(n => n > 0), 0) || 99;
  const prices = (quotes || []).filter(q => days(q) <= MAX_SHIPPING_DAYS)
    .map(q => Number(q.totalPostageFee) || Number(q.logisticPrice)).filter(p => p > 0);
  return prices.length ? Math.min(...prices) : null;
}

// CJ names dimensions in productKeyEn ("Color-Size") and values in variantKey ("Sky blue-M"); values can
// contain "-" ("Off-white-M"), so extra parts belong to the first dimension.
function variantOptions(dims, key) {
  const parts = String(key || '').split('-');
  if (dims.length <= 1 || parts.length < dims.length) return { [dims[0] || 'Style']: String(key || '').trim() };
  const tail = parts.splice(parts.length - (dims.length - 1));
  return Object.fromEntries(dims.map((d, i) => [d, (i === 0 ? parts.join('-') : tail[i - 1]).trim()]));
}

const images = detail => {
  let list = detail?.productImageSet ?? detail?.productImage ?? [];
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = [list]; } }
  return [...new Set([detail?.bigImage, ...list].filter(u => /^https:\/\//.test(u || '')))].slice(0, 8);
};
const cleanDescription = html => String(html || '').replace(/<img[^>]*>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

async function save(prisma, category, item, detail, shipping) {
  const dims = String(detail?.productKeyEn || '').split('-').map(d => d.trim()).filter(Boolean);
  const pics = images(detail);
  const data = {
    name: cleanName(item.name), category, description: cleanDescription(detail?.description) || null,
    imageUrl: pics[0] || item.image, images: pics, supplierPriceUsd: item.price, shippingUsd: shipping,
    priceCents: retailCents(item.price, shipping), currency: 'EUR', stock: 100, active: true, variantDims: dims
  };
  const product = await prisma.product.upsert({ where: { cjPid: item.id }, create: { cjPid: item.id, ...data }, update: data });
  const seen = [];
  for (const v of detail?.variants || []) {
    const supplier = firstNumber(v.variantSellPrice);
    if (!v.vid || !supplier) continue;
    const options = variantOptions(dims, v.variantKey);
    if (Object.values(options).some(x => LOUD_COLOR.test(x))) continue;
    const size = Object.entries(options).find(([k]) => /size/i.test(k))?.[1] || null;
    const color = Object.entries(options).filter(([k]) => !/size/i.test(k)).map(([, x]) => x).join(' / ') || null;
    const vData = {
      productId: product.id, sku: v.variantSku || null, options, size, color, supplierPriceUsd: supplier,
      priceCents: retailCents(supplier, shipping), imageUrl: /^https:\/\//.test(v.variantImage || '') ? v.variantImage : null,
      weightG: Math.round(Number(v.variantWeight)) || null, active: true
    };
    await prisma.productVariant.upsert({ where: { cjVid: String(v.vid) }, create: { cjVid: String(v.vid), ...vData }, update: vData });
    seen.push(String(v.vid));
  }
  await prisma.productVariant.updateMany({ where: { productId: product.id, cjVid: { notIn: seen } }, data: { active: false } });
  if (!seen.length) { await prisma.product.update({ where: { id: product.id }, data: { active: false } }); return 0; }
  const cheapest = await prisma.productVariant.aggregate({ where: { productId: product.id, active: true }, _min: { priceCents: true } });
  if (cheapest._min.priceCents) await prisma.product.update({ where: { id: product.id }, data: { priceCents: cheapest._min.priceCents } });
  return seen.length;
}

const { CJ_API_KEY, DATABASE_URL } = process.env;
if (!CJ_API_KEY || (!DATABASE_URL && !DRY_RUN)) { console.error('Set CJ_API_KEY and DATABASE_URL in .env.'); process.exit(1); }
const auth = await (await fetch(CJ + '/authentication/getAccessToken', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: CJ_API_KEY })
})).json();
token = auth?.data?.accessToken;
if (!token) { console.error('CJ login failed: ' + (auth?.message || 'no token')); process.exit(1); }
if (!USD_PER_EUR) {
  const xml = await (await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml')).text();
  USD_PER_EUR = Number(/currency='USD' rate='([\d.]+)'/.exec(xml)?.[1]);
  if (!(USD_PER_EUR > 0)) throw new Error('Could not read the ECB USD rate; set USD_PER_EUR.');
}
console.log(`1 EUR = ${USD_PER_EUR} USD · ${PER_CATEGORY} per category${DRY_RUN ? ' · DRY RUN' : ''}`);

const prisma = DRY_RUN ? null : new PrismaClient();
const runStarted = new Date();
const count = {};
const usedPids = new Set();
// Each search may fill only its share of the category, so a category mixes its searches
// (bracelets, earrings, pearls ...) instead of filling up from the first one.
const searchesIn = c => SEARCHES.filter(s => s.category === c).length;
for (const { category, keyword } of SEARCHES.filter(s => !ONLY || s.category === ONLY)) {
  if ((count[category] || 0) >= PER_CATEGORY) continue;
  const share = Math.ceil(PER_CATEGORY / searchesIn(category));
  const limit = Math.min(PER_CATEGORY, (count[category] || 0) + share);
  for (let page = 1; page <= MAX_PAGES && (count[category] || 0) < limit; page++) {
    const url = `/product/listV2?page=${page}&size=100&keyWord=${encodeURIComponent(keyword)}`;
    const list = (await cj(url))?.content?.flatMap(c => c.productList || []) || [];
    const candidates = list
      .map(p => ({ id: String(p.id || ''), name: String(p.nameEn || '').replace(/\s+/g, ' ').trim(), price: firstNumber(p.sellPrice), image: p.bigImage }))
      .filter(p => p.id && !usedPids.has(p.id) && p.name && /^[\x20-\x7E]+$/.test(p.name) && p.price >= minPrice(category) &&
        fitsStore(p.name, category) && /^https:\/\//.test(p.image || ''));
    for (const item of candidates) {
      if ((count[category] || 0) >= limit) break;
      usedPids.add(item.id);
      // A piece already shown in another category stays there (an upsert would move it).
      if (prisma) {
        const existing = await prisma.product.findUnique({ where: { cjPid: item.id }, select: { category: true, active: true } });
        if (existing?.active && existing.category !== category) continue;
      }
      try {
        const detail = await cj(`/product/query?pid=${item.id}`);
        const shipping = await shippingUsd(detail);
        if (shipping == null) { console.log(`  skip (no shipping to ${SHIP_TO}): ${item.name.slice(0, 60)}`); continue; }
        // Bulky items whose shipping costs more than the product itself do not fit the price range.
        if (shipping > item.price) { console.log(`  skip (shipping $${shipping} > price): ${item.name.slice(0, 60)}`); continue; }
        const price = (retailCents(item.price, shipping) / 100).toFixed(2);
        if (DRY_RUN) console.log(`  ${category}: €${price} ($${item.price} + $${shipping} ship) ${item.name.slice(0, 70)}`);
        else {
          const variants = await save(prisma, category, item, detail, shipping);
          if (!variants) { console.log(`  skip (no variant in the palette): ${item.name.slice(0, 60)}`); continue; }
          console.log(`  ${category}: €${price} · ${variants} variants · ${item.name.slice(0, 60)}`);
        }
        count[category] = (count[category] || 0) + 1;
      } catch (err) {
        console.warn(`  failed ${item.id}: ${err.message}`);
      }
    }
    if (!list.length) break;
  }
  console.log(`${category}: ${count[category] || 0} so far ("${keyword}")`);
}
// A full run defines the catalogue: products from earlier runs that no longer pass the rules are hidden.
if (prisma) {
  const hidden = await prisma.product.updateMany({ where: { active: true, cjPid: { not: null }, updatedAt: { lt: runStarted }, ...(ONLY ? { category: ONLY } : {}) }, data: { active: false } });
  console.log(`Hidden ${hidden.count} older products that this run did not import.`);
}
await prisma?.$disconnect();
console.log('Done:', JSON.stringify(count));
