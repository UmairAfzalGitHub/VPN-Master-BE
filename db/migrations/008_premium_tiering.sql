-- Paywall tiering (BACKEND.md 2.x): exactly ONE free server; every other server
-- is premium so the app shows a crown on it and gates it behind IAP.
--
-- Free tier = 1 GB/month on the single free server. Premium = all servers,
-- 10 GB/month (see services/config.js). We designate New York (us-nyc-01) as the
-- free server; flip a different id here if that changes. Idempotent.

UPDATE servers SET is_premium = true;
UPDATE servers SET is_premium = false WHERE id = 'us-nyc-01';
