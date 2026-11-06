// Writes the active catalogue to assets/catalog.json, the file the storefront reads. GitHub Pages and
// Cloudflare Pages only serve files, so the catalogue ships as a static file; run this after every import
// or review and commit the result.
//   node scripts/export-catalog.mjs
// Only public data is exported: no supplier prices, CJ ids or stock.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const products = await prisma.product.findMany({
  where: { active: true },
  select: {
    id: true, name: true, category: true, description: true, priceCents: true, imageUrl: true, images: true, variantDims: true,
    variants: { where: { active: true }, select: { id: true, size: true, color: true, options: true, priceCents: true, imageUrl: true }, orderBy: { priceCents: 'asc' } }
  },
  orderBy: [{ category: 'asc' }, { createdAt: 'asc' }]
});
await prisma.$disconnect();

const catalog = {
  updatedAt: new Date().toISOString(),
  products: products.filter(p => p.variants.length).map(p => ({
    ...p,
    images: [...new Set([p.imageUrl, ...p.images].filter(Boolean))].slice(0, 6),
    description: p.description ? p.description.slice(0, 700) : null
  }))
};
writeFileSync('assets/catalog.json', JSON.stringify(catalog));
console.log(`assets/catalog.json: ${catalog.products.length} products, ${(JSON.stringify(catalog).length / 1024).toFixed(0)} KB`);
