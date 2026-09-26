import type { BenefitPeriodPolicy, PeriodUnit } from "./entitlement.types.js";

const MONTHS: Record<PeriodUnit, number> = { year: 12, quarter: 3, month: 1 };

/** anchor + n months in UTC, clamping the day to the target month's end. */
function addMonths(anchor: Date, months: number): Date {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(anchor.getTime());
  result.setUTCFullYear(year, month, Math.min(anchor.getUTCDate(), lastDay));
  return result;
}

/**
 * The anniversary period containing `at`, always computed from the original
 * anchor (never chained) so a Jan 31 start does not drift to the 28th.
 * Before the anchor, the first period applies.
 */
export function benefitPeriod(
  anchor: Date,
  policy: BenefitPeriodPolicy,
  at: Date
): { start: Date; end: Date } {
  const step = MONTHS[policy.unit];
  const elapsed =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + at.getUTCMonth() - anchor.getUTCMonth();
  let index = Math.max(0, Math.floor(elapsed / step));
  while (index > 0 && addMonths(anchor, index * step) > at) index--;
  while (addMonths(anchor, (index + 1) * step) <= at) index++;
  return { start: addMonths(anchor, index * step), end: addMonths(anchor, (index + 1) * step) };
}
