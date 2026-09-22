-- ---------------------------------------------------------------------------
-- 009: dev-only per-device data-allowance override.
--
-- A nullable monthly byte cap that, when set, overrides the free/premium plan
-- limit for THIS device only. It lets a developer force a small allowance and
-- exercise the near-cap / exhausted quota UI without burning real data. NULL ⇒
-- no override (fall back to the plan, as before). Gated end-to-end by the same
-- DEV_UNLIMITED_DEVICE_IDS allowlist as the /devices/premium toggle.
-- ---------------------------------------------------------------------------
ALTER TABLE devices ADD COLUMN IF NOT EXISTS quota_override_bytes BIGINT;
