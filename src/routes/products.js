import { Router } from 'express';
import { z } from 'zod';

const uuid = z.string().uuid();
const category = z.string().regex(/^[a-z]{2,30}$/);

// Public catalogue: only active products and variants, and never supplier prices or CJ ids.
export default function productsRouter(prisma) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    const cat = req.query.category === undefined ? null : category.safeParse(req.query.category);
    if (cat && !cat.success) return res.status(400).json({ error: 'Invalid category.' });
    try {
      const products = await prisma.product.findMany({
        where: { active: true, ...(cat ? { category: cat.data } : {}) },
        select: { id: true, name: true, category: true, priceCents: true, currency: true, imageUrl: true, images: true },
        orderBy: [{ category: 'asc' }, { createdAt: 'asc' }],
        take: 500
      });
      // The list only needs a second photo for the hover view, not the whole gallery.
      const list = products.map(({ images, ...p }) => ({ ...p, altImage: images.find(u => u !== p.imageUrl) || null }));
      res.set('Cache-Control', 'public, max-age=60').json({ products: list });
    } catch (err) { next(err); }
  });

  router.get('/:id', async (req, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ error: 'Product not found.' });
    try {
      const product = await prisma.product.findFirst({
        where: { id: id.data, active: true },
        select: {
          id: true, name: true, category: true, description: true, priceCents: true, currency: true,
          imageUrl: true, images: true, variantDims: true,
          variants: {
            where: { active: true },
            select: { id: true, size: true, color: true, options: true, priceCents: true, imageUrl: true },
            orderBy: { priceCents: 'asc' }
          }
        }
      });
      if (!product) return res.status(404).json({ error: 'Product not found.' });
      res.set('Cache-Control', 'public, max-age=60').json({ product });
    } catch (err) { next(err); }
  });

  return router;
}
