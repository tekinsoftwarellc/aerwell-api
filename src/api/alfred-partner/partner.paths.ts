/**
 * The partner contract shares the `/api/v1/alfred` prefix with the staff AI assistant
 * (`config`, `conversations`, `drafts`, `suggestions`). Partner paths never overlap those, so
 * the guard is applied per route and everything else on the prefix is left to the staff router.
 */
export const PARTNER_SEGMENTS = [
  "members",
  "catalog",
  "availability",
  "bookings",
  "orders",
  "events",
  "clinical",
];
export const PARTNER_PATH = new RegExp(`^/api/v1/alfred/(${PARTNER_SEGMENTS.join("|")})(/|$)`);
