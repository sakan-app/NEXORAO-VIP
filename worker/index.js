// NEXORA on Cloudflare Workers: serves the static storefront (assets) and the payment API, the same order
// cycle as SakanVIP: login -> Stripe/PayPal -> order + PDF invoice by email -> CJ order -> tracking email.
// Secrets (SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PAYPAL_CLIENT_SECRET,
// SMTP_PASS, CJ_API_KEY) are set in the Cloudflare dashboard as type Secret, never in this repository.
import Stripe from 'stripe';
import { WorkerMailer } from 'worker-mailer';
import { recordPaidOrder, supabase, variantText } from './orders.js';
import { sendToCj, retryCjOrders, checkCjTracking } from './cj.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EU_COUNTRIES = ['DE', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'SE'];
const emailOk = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const shopName = env => env.SHOP_NAME || 'NEXORA';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

class UserError extends Error {}

// "NEXORA <info@example.com>" -> { name, email }
function parseAddress(value) {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value || '');
  return match ? { name: match[1].replace(/^"|"$/g, ''), email: match[2] } : { email: String(value || '').trim() };
}

// Checkout needs an account: the page sends the Supabase access token, Supabase confirms who it belongs to.
async function currentUser(env, request) {
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const response = await fetch(new URL('/auth/v1/user', env.SUPABASE_URL), { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const user = await response.json();
  return user?.id && emailOk(user.email) ? { id: user.id, email: user.email } : null;
}

function validateShipping(input) {
  const name = String(input?.name || '').trim().slice(0, 120);
  const street = String(input?.street || '').trim().slice(0, 200);
  const city = String(input?.city || '').trim().slice(0, 120);
  const postalCode = String(input?.postalCode || '').trim().slice(0, 24);
  const country = String(input?.country || 'DE').trim().toUpperCase();
  // CJ and the carriers need a phone number for delivery; spaces, brackets, dots and dashes are dropped.
  const phone = String(input?.phone || '').replace(/[\s()./-]/g, '');
  if (!name || !street || !city || !postalCode || !EU_COUNTRIES.includes(country)) throw new UserError('Bitte Name und Lieferadresse vollständig angeben.');
  if (!/^\+?\d{6,15}$/.test(phone)) throw new UserError('Bitte geben Sie eine gültige Telefonnummer für die Zustellung an.');
  return { name, street, city, postalCode, country, phone };
}

// Prices, names and variants come from the database, never from the browser. Every NEXORA product is sold
// per CJ variant, so each cart line must name an active variant of an active product.
async function trustedCart(env, items) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new UserError('Warenkorb ungültig.');
  const lines = items.map(x => ({ id: String(x?.product_id || ''), variantId: String(x?.variant_id || ''), quantity: Number(x?.quantity) }));
  if (lines.some(x => !UUID.test(x.id) || !UUID.test(x.variantId) || !Number.isInteger(x.quantity) || x.quantity < 1 || x.quantity > 20)) {
    throw new UserError('Warenkorbposition ungültig. Bitte Artikel neu in den Warenkorb legen.');
  }
  const ids = [...new Set(lines.map(x => x.id))];
  const variantIds = [...new Set(lines.map(x => x.variantId))];
  const [products, variants] = await Promise.all([
    supabase(env, `Product?id=in.(${ids.join(',')})&active=eq.true&select=id,name`),
    supabase(env, `ProductVariant?id=in.(${variantIds.join(',')})&active=eq.true&select=id,productId,priceCents,size,color`)
  ]);
  const productOf = new Map(products.map(p => [p.id, p]));
  const variantOf = new Map(variants.map(v => [v.id, v]));
  return lines.map(x => {
    const product = productOf.get(x.id);
    const variant = variantOf.get(x.variantId);
    if (!product) throw new UserError('Ein Artikel ist nicht mehr verfügbar. Bitte entfernen Sie ihn aus dem Warenkorb.');
    if (!variant || variant.productId !== x.id) throw new UserError(`Bitte wählen Sie Größe und Farbe für "${String(product.name).slice(0, 60)}" erneut aus.`);
    return { product: { id: product.id, name: product.name, price: variant.priceCents / 100 }, quantity: x.quantity, size: variant.size || '', color: variant.color || '', variantId: variant.id };
  });
}

const paypalBase = env => (env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const paypalReady = env => Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

async function paypalAccessToken(env) {
  const r = await fetch(paypalBase(env) + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_CLIENT_SECRET), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error('PayPal Auth fehlgeschlagen.');
  return data.access_token;
}

const smtpReady = env => Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM && env.MAIL_TO_INFO);

async function sendMail(env, message) {
  const port = Number(env.SMTP_PORT);
  if (![465, 587].includes(port)) throw new Error('SMTP_PORT must be 465 (TLS) or 587 (STARTTLS)');
  await WorkerMailer.send(
    { host: env.SMTP_HOST, port, secure: port === 465, startTls: port === 587, credentials: { username: env.SMTP_USER, password: env.SMTP_PASS }, authType: ['plain', 'login'] },
    { from: parseAddress(env.MAIL_FROM), ...message }
  );
}

// Online withdrawal function (EU Consumer Rights Directive, Art. 11a): the shop gets the declaration,
// the customer an immediate receipt by email.
async function withdrawal(env, body) {
  const name = String(body?.name || '').trim().slice(0, 120);
  const email = String(body?.email || '').trim();
  const order = String(body?.order || '').trim().toUpperCase();
  const items = String(body?.items || '').trim().slice(0, 1000);
  if (!name || !emailOk(email) || !/^[A-Z0-9-]{3,40}$/.test(order)) return json({ error: 'Bitte Name, E-Mail und Rechnungsnummer prüfen.' }, 400);
  if (!smtpReady(env)) return json({ error: 'E-Mail-Versand ist noch nicht konfiguriert.' }, 503);
  const at = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'long', timeStyle: 'short' }).format(new Date());
  const shop = env.MAIL_TO_INFO;
  const what = items || 'gesamte Bestellung';
  const returnAddress = [env.SHOP_LEGAL_NAME || shopName(env), ...String(env.SHOP_ADDRESS || '').split('|')].filter(Boolean).join(', ');
  try {
    await sendMail(env, { to: shop, reply: email, subject: `[${shopName(env)} Widerruf] ${order}`, text: `Widerruf über die Website, eingegangen am ${at} Uhr.\n\nName: ${name}\nE-Mail: ${email}\nRechnungsnummer: ${order}\nArtikel: ${what}` });
    await sendMail(env, {
      to: email, reply: shop, subject: `Eingangsbestätigung Ihres Widerrufs – ${order}`,
      text: [
        `Guten Tag ${name},`, '', `wir bestätigen den Eingang Ihres Widerrufs am ${at} Uhr.`, '',
        `Rechnungsnummer: ${order}`, `Widerrufene Artikel: ${what}`, '',
        `Bitte senden Sie die Ware innerhalb von 14 Tagen an: ${returnAddress}.`,
        'Bitte schreiben Sie uns vor der Rücksendung kurz an diese Adresse; wir antworten mit allen Details.',
        'Wir erstatten Ihre Zahlung unverzüglich, spätestens 14 Tage nach Eingang Ihres Widerrufs, über das ursprüngliche Zahlungsmittel. Wir können die Erstattung zurückhalten, bis die Ware bei uns eingegangen ist oder Sie die Rücksendung nachgewiesen haben.', '',
        `Mit freundlichen Grüßen\n${shopName(env)}`
      ].join('\n')
    });
    return json({ ok: true }, 202);
  } catch (err) {
    console.error('Withdrawal mail failed:', order, err.message);
    return json({ error: 'Ihr Widerruf konnte gerade nicht gesendet werden.' }, 503);
  }
}

async function stripeSession(env, body, origin, user) {
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Kartenzahlung ist noch nicht eingerichtet.' }, 503);
  try {
    const items = await trustedCart(env, body?.items);
    const shipping = validateShipping(body?.shipping);
    const metadata = {
      user_id: user.id, shipping_name: shipping.name, shipping_street: shipping.street, shipping_city: shipping.city,
      shipping_postal_code: shipping.postalCode, shipping_country: shipping.country, shipping_phone: shipping.phone
    };
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      currency: 'eur',
      // The invoice goes to the account's email address.
      customer_email: user.email,
      line_items: items.map(({ product, quantity, size, color, variantId }) => ({
        quantity,
        price_data: {
          currency: 'eur',
          unit_amount: Math.round(product.price * 100),
          product_data: {
            name: product.name,
            ...(variantText({ size, color }) && { description: variantText({ size, color }) }),
            metadata: { product_id: product.id, variant_id: variantId, size, color }
          }
        }
      })),
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: EU_COUNTRIES },
      // Stripe collects the shipping address itself; it rejects a preset payment_intent_data.shipping
      // alongside it, so the address from the page only goes in the metadata.
      payment_intent_data: { metadata },
      metadata,
      success_url: `${origin}/?payment=success`,
      cancel_url: `${origin}/?payment=cancel`
    });
    return json({ url: session.url, id: session.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return json({ error: err instanceof UserError ? err.message : 'Die Kartenzahlung konnte nicht gestartet werden.' }, 400);
  }
}

async function paypalOrder(env, body, origin, user) {
  if (!paypalReady(env)) return json({ error: 'PayPal ist noch nicht eingerichtet.' }, 503);
  try {
    const items = await trustedCart(env, body?.items);
    const shipping = validateShipping(body?.shipping);
    const total = items.reduce((sum, x) => sum + x.product.price * x.quantity, 0);
    const token = await paypalAccessToken(env);
    const response = await fetch(paypalBase(env) + '/v2/checkout/orders', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          // Read back when the order is saved: account, account email and delivery phone.
          custom_id: [user.id, shipping.phone].join('|'),
          shipping: {
            name: { full_name: shipping.name },
            address: { address_line_1: shipping.street, admin_area_2: shipping.city, postal_code: shipping.postalCode, country_code: shipping.country }
          },
          amount: { currency_code: 'EUR', value: total.toFixed(2), breakdown: { item_total: { currency_code: 'EUR', value: total.toFixed(2) } } },
          items: items.map(({ product, quantity, size, color, variantId }) => ({
            name: String(product.name).slice(0, 127), quantity: String(quantity),
            sku: [product.id, variantId, size, color].join('|').slice(0, 127),
            ...(variantText({ size, color }) && { description: variantText({ size, color }).slice(0, 127) }),
            unit_amount: { currency_code: 'EUR', value: product.price.toFixed(2) }
          }))
        }],
        application_context: { shipping_preference: 'SET_PROVIDED_ADDRESS', return_url: `${origin}/?payment=paypal-approved`, cancel_url: `${origin}/?payment=cancel` }
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'PayPal order create failed');
    const approval = data.links?.find(x => x.rel === 'approve')?.href;
    if (!approval) throw new Error('PayPal approval URL missing');
    return json({ id: data.id, url: approval });
  } catch (err) {
    console.error('PayPal order error:', err.message);
    return json({ error: err instanceof UserError ? err.message : 'PayPal konnte nicht gestartet werden.' }, 400);
  }
}

async function paypalCapture(env, body, user, ctx) {
  if (!paypalReady(env)) return json({ error: 'PayPal ist noch nicht eingerichtet.' }, 503);
  const orderId = String(body?.orderId || '');
  if (!/^[A-Z0-9-]{8,64}$/i.test(orderId)) return json({ error: 'Ungültige PayPal-Bestellnummer.' }, 400);
  try {
    const token = await paypalAccessToken(env);
    const response = await fetch(paypalBase(env) + '/v2/checkout/orders/' + encodeURIComponent(orderId) + '/capture', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() }, body: '{}'
    });
    const data = await response.json();
    if (!response.ok || data.status !== 'COMPLETED') throw new Error(data.message || 'Capture not completed');
    // The payment is done; a failed order email must not show the customer an error.
    let invoice = null;
    try {
      const order = await recordPaypalOrder(env, token, orderId, user);
      invoice = order.invoice_number;
      ctx?.waitUntil(sendToCj(env, order, sendMail));
    } catch (err) { console.error('PayPal order record failed:', orderId, err.message); }
    return json({ ok: true, invoice });
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    return json({ error: 'Die PayPal-Zahlung konnte nicht abgeschlossen werden.' }, 400);
  }
}

async function recordPaypalOrder(env, token, orderId, user) {
  const response = await fetch(paypalBase(env) + '/v2/checkout/orders/' + encodeURIComponent(orderId), { headers: { Authorization: 'Bearer ' + token } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'PayPal order lookup failed');
  const unit = data.purchase_units?.[0] || {};
  const [userId, phone] = String(unit.custom_id || '').split('|');
  const a = unit.shipping?.address || {};
  const shipping = { name: unit.shipping?.name?.full_name, line1: a.address_line_1, line2: a.address_line_2, city: a.admin_area_2, postal_code: a.postal_code, country: a.country_code };
  return recordPaidOrder(env, {
    provider: 'paypal',
    reference: orderId,
    userId: userId || user?.id,
    // The invoice goes to the shop account's email, not the PayPal login.
    customer: { name: shipping.name || [data.payer?.name?.given_name, data.payer?.name?.surname].filter(Boolean).join(' '), email: user?.email || data.payer?.email_address, phone },
    shipping,
    billing: null,
    items: (unit.items || []).map(item => {
      const [product_id, variant_id, size, color] = String(item.sku || '').split('|');
      return { product_id, variant_id: variant_id || null, name: item.name, size, color, quantity: Number(item.quantity), unit_price: Number(item.unit_amount?.value) };
    }),
    total: Number(unit.amount?.value)
  }, sendMail);
}

async function recordStripeOrder(env, stripe, session) {
  const lines = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100, expand: ['data.price.product'] });
  const details = session.customer_details || {};
  const ship = session.collected_information?.shipping_details || session.shipping_details || {};
  return recordPaidOrder(env, {
    provider: 'stripe',
    reference: session.id,
    userId: session.metadata?.user_id,
    customer: { name: ship.name || details.name || session.metadata?.shipping_name, email: session.customer_email || details.email, phone: session.metadata?.shipping_phone || details.phone },
    shipping: { name: ship.name || session.metadata?.shipping_name, ...(ship.address || details.address) },
    billing: details.address ? { name: details.name, ...details.address } : null,
    items: lines.data.map(line => {
      const meta = line.price?.product?.metadata || {};
      return { product_id: meta.product_id, variant_id: meta.variant_id || null, name: line.price?.product?.name || line.description, size: meta.size, color: meta.color, quantity: line.quantity, unit_price: line.price.unit_amount / 100 };
    }),
    total: session.amount_total / 100
  }, sendMail);
}

// Stripe calls this server-to-server, so it has no Origin header and needs the raw body for the signature.
async function stripeWebhook(env, request, ctx) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return new Response('Stripe webhook is not configured.', { status: 503 });
  const signature = request.headers.get('stripe-signature');
  const raw = await request.text();
  if (!signature || !raw) return new Response('Missing Stripe signature or raw request body.', { status: 400 });
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() });
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, signature, env.STRIPE_WEBHOOK_SECRET, undefined, Stripe.createSubtleCryptoProvider());
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return new Response('Invalid Stripe signature.', { status: 400 });
  }
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (event.data.object.payment_status !== 'paid') break; // delayed methods arrive as async_payment_succeeded
      try {
        const order = await recordStripeOrder(env, stripe, event.data.object);
        // The CJ order runs after Stripe gets its answer; failures stay on the order and the cron retries.
        ctx?.waitUntil(sendToCj(env, order, sendMail));
      } catch (err) {
        // 500 makes Stripe retry; recordPaidOrder skips what is already done.
        console.error('Stripe order record failed:', event.data.object.id, err.message);
        return new Response('Order could not be recorded.', { status: 500 });
      }
      break;
    case 'checkout.session.async_payment_failed':
      console.warn('Stripe asynchronous payment failed:', event.data.object.id);
      break;
    default:
      console.log('Stripe webhook event received:', event.type);
  }
  return json({ received: true });
}

// Routes the page calls with POST; `login` routes need a signed-in customer.
const routes = {
  '/api/withdrawal': { handler: (env, body) => withdrawal(env, body) },
  '/api/payments/stripe/session': { login: true, handler: (env, body, origin, user) => stripeSession(env, body, origin, user) },
  '/api/payments/paypal/order': { login: true, handler: (env, body, origin, user) => paypalOrder(env, body, origin, user) },
  '/api/payments/paypal/capture': { login: true, handler: (env, body, origin, user, ctx) => paypalCapture(env, body, user, ctx) }
};

export default {
  async scheduled(controller, env, ctx) {
    // One after the other: CJ allows about one request per second.
    ctx.waitUntil(retryCjOrders(env, sendMail).finally(() => checkCjTracking(env, sendMail)));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // One public address for search engines once CANONICAL_HOST is set: pages on www or on the production
    // workers.dev name move there. API calls and branch previews stay.
    const canonical = env.CANONICAL_HOST;
    if (canonical && url.hostname !== canonical && (request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/') &&
        (url.hostname === 'www.' + canonical || (env.WORKER_NAME && url.hostname.startsWith(env.WORKER_NAME + '.') && url.hostname.endsWith('.workers.dev')))) {
      return Response.redirect(`https://${canonical}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname === '/health') return json({ ok: true });
    // Public storefront settings: the page shows only the payment methods that are set up.
    if (url.pathname === '/api/config') {
      return json({
        payments: true,
        stripe: Boolean(env.STRIPE_SECRET_KEY),
        paypalClientId: paypalReady(env) ? env.PAYPAL_CLIENT_ID : null
      }, 200, { 'Cache-Control': 'no-store' });
    }
    if (url.pathname === '/api/payments/stripe/webhook') {
      return request.method === 'POST' ? stripeWebhook(env, request, ctx) : json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    }
    const route = routes[url.pathname];
    if (!route) return url.pathname.startsWith('/api/') ? json({ error: 'Not found' }, 404) : env.ASSETS.fetch(request);

    // Same-origin only.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Origin not allowed' }, 403);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });

    if (env.LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.LIMITER.limit({ key: `${ip}:${url.pathname}` });
      if (!success) return json({ error: 'Zu viele Versuche. Bitte in einer Minute erneut versuchen.' }, 429);
    }
    let user = null;
    if (route.login) {
      user = await currentUser(env, request);
      if (!user) return json({ error: 'Bitte melden Sie sich an, um zur Kasse zu gehen.', login: true }, 401);
    }
    const raw = await request.text();
    if (raw.length > 12 * 1024) return json({ error: 'Anfrage zu groß.' }, 413);
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch { return json({ error: 'Ungültige Anfrage.' }, 400); }
    return route.handler(env, body, url.origin, user, ctx);
  }
};
