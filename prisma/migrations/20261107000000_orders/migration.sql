-- Paid orders, one row per Stripe Checkout session or PayPal order (same shape as SakanVIP). Written only by
-- the Cloudflare Worker with the service key; RLS is on with no policies, so the browser cannot read them.
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq;
CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL UNIQUE,
  payment_provider text NOT NULL CHECK (payment_provider IN ('stripe', 'paypal')),
  payment_reference text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'sent_to_supplier', 'shipped', 'delivered', 'cancelled', 'refunded')),
  user_id uuid,
  customer_name text, customer_email text, customer_phone text,
  shipping_address jsonb, billing_address jsonb,
  items jsonb NOT NULL,
  total numeric(12,2) NOT NULL, currency text NOT NULL DEFAULT 'EUR',
  invoice_sent_at timestamptz,
  -- CJ fulfilment (worker/cj.js)
  supplier_order_id text, supplier_shipment_id text, supplier_logistic text, supplier_paid_at timestamptz,
  supplier_cost_usd numeric(12,2), supplier_error text, supplier_status text, supplier_checked_at timestamptz,
  tracking_number text, tracking_url text, shipped_at timestamptz, delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON public.orders(status, created_at);
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.orders FROM anon, authenticated;

-- Gap-free invoice numbers (NX-2026-00001): only called for a payment that has no order yet.
CREATE OR REPLACE FUNCTION public.next_invoice_number() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT 'NX-' || to_char(now() AT TIME ZONE 'Europe/Berlin', 'YYYY') || '-' || lpad(nextval('public.invoice_number_seq')::text, 5, '0')
$$;
REVOKE ALL ON FUNCTION public.next_invoice_number() FROM public, anon, authenticated;
