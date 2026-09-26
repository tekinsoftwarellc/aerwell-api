import { ValidationError } from "../../common/errors/AppError.js";
export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const DEFAULT_TIME_ZONE = "America/Los_Angeles";
// Building an Intl.DateTimeFormat costs far more than formatting with one: cache per
// zone (W11 load test: a month summary spent seconds constructing formatters).
const cached = (options: Intl.DateTimeFormatOptions) => {
  const byZone = new Map<string, Intl.DateTimeFormat>();
  return (timeZone: string) => {
    let formatter = byZone.get(timeZone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat("sv-SE", { ...options, timeZone });
      byZone.set(timeZone, formatter);
    }
    return formatter;
  };
};
const dateFormatter = cached({ year: "numeric", month: "2-digit", day: "2-digit" });
const minuteFormatter = cached({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
/** Calendar date (YYYY-MM-DD) of `now` in the given IANA zone. */
export const todayIn = (timeZone = DEFAULT_TIME_ZONE, now = new Date()) =>
  dateFormatter(timeZone).format(now);
export function localInstant(date: string, time: string, timeZone: string) {
  const base = Date.parse(`${date}T${time}:00Z`);
  const formatter = minuteFormatter(timeZone);
  const matches: number[] = [];
  // IANA offsets are minute-granular for supported contemporary scheduling dates.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = base + offset * 60000;
    if (formatter.format(candidate) === `${date} ${time}`) matches.push(candidate);
  }
  const [match] = matches;
  if (matches.length !== 1 || match === undefined)
    throw new ValidationError(
      "This local time is missing or ambiguous during a clock change. Choose another time.",
      "INVALID_LOCAL_TIME"
    );
  return new Date(match);
}
export function dateRange(date: string, view: string) {
  if (view === "month")
    return {
      from: `${date.slice(0, 7)}-01`,
      to: new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 1))
        .toISOString()
        .slice(0, 10),
    };
  if (view === "week") {
    const weekday = new Date(`${date}T12:00Z`).getUTCDay();
    const from = addDays(date, -((weekday + 6) % 7));
    return { from, to: addDays(from, 7) };
  }
  return { from: date, to: addDays(date, 1) };
}
export function daysByYear(start: string, end: string) {
  const result: Record<string, number> = {};
  for (let date = start; date <= end; date = addDays(date, 1))
    result[date.slice(0, 4)] = (result[date.slice(0, 4)] ?? 0) + 1;
  return result;
}
