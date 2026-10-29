import { Router } from 'express';
import { z } from 'zod';

const uuid = z.string().uuid();
const orderInput = z.object({
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().min(1).max(20)
  }).strict()).min(1).max(30),
  shippingAddress: z.object({
    name: z.string().trim().min(1).max(120),
    line1: z.string().trim().min(1).max(180),
    line2: z.string().trim().max(180).optional(),
    city: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(2).max(20),
    country: z.string().trim().length(2).transform(v => v.toUpperCase())
  }).strict()
}).strict();

function requireUser(req, res, next) {
  if (!req.session?.userId || typeof req.session.userId !== 'string') {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
}

export default function ordersRouter(prisma) {
  const router = Router();
  router.use(requireUser);

  router.get('/:id', async (req, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ error: 'Order not found.' });
    try {
      // Ownership is enforced in the query itself; knowing an order UUID grants no access.
      const order = await prisma.order.findFirst({
        where: { id: id.data, userId: req.session.userId },
        select: { id: true, status: true, totalCents: true, currency: true, createdAt: true, items: true }
      });
      if (!order) return res.status(404).json({ error: 'Order not found.' });
      res.json({ order });
    } catch (err) { next(err); }
  });

  router.post('/', async (req, res, next) => {
    const parsed = orderInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid order data.' });
    try {
      const ids = [...new Set(parsed.data.items.map(i => i.productId))];
      const products = await prisma.product.findMany({
        where: { id: { in: ids }, active: true },
        select: { id: true, priceCents: true, currency: true, stock: true }
      });
      if (products.length !== ids.length) return res.status(400).json({ error: 'One or more products are unavailable.' });
      const byId = new Map(products.map(p => [p.id, p]));
      let totalCents = 0;
      const items = parsed.data.items.map(item => {
        const product = byId.get(item.productId);
        if (!product || product.stock < item.quantity) throw Object.assign(new Error('Unavailable item'), { status: 400 });
        if (product.currency !== 'EUR') throw Object.assign(new Error('Unsupported currency'), { status: 400 });
        totalCents += product.priceCents * item.quantity;
        return { productId: product.id, quantity: item.quantity, unitPriceCents: product.priceCents };
      });
      if (!Number.isSafeInteger(totalCents) || totalCents <= 0) return res.status(400).json({ error: 'Invalid order total.' });

      const order = await prisma.$transaction(async tx => {
        for (const item of items) {
          const changed = await tx.product.updateMany({
            where: { id: item.productId, active: true, stock: { gte: item.quantity } },
            data: { stock: { decrement: item.quantity } }
          });
          if (changed.count !== 1) throw Object.assign(new Error('Inventory changed'), { status: 409 });
        }
        return tx.order.create({
          data: {
            userId: req.session.userId,
            totalCents,
            currency: 'EUR',
            shippingAddress: parsed.data.shippingAddress,
            items: { create: items }
          },
          select: { id: true, status: true, totalCents: true, currency: true, createdAt: true }
        });
      });
      res.status(201).json({ order });
    } catch (err) { next(err); }
  });

  router.delete('/:id', async (req, res, next) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ error: 'Order not found.' });
    try {
      const deleted = await prisma.order.deleteMany({
        where: { id: id.data, userId: req.session.userId, status: 'PENDING' }
      });
      if (deleted.count !== 1) return res.status(404).json({ error: 'Order not found.' });
      res.status(204).end();
    } catch (err) { next(err); }
  });
  return router;
}
