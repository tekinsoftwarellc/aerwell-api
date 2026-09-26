import { expect, it } from "vitest";
import { dateRange, daysByYear, localInstant, todayIn } from "./time.js";

const LA = "America/Los_Angeles";

it("rejects nonexistent and ambiguous local times and respects DST elapsed hours", () => {
  expect(() => localInstant("2027-03-14", "02:30", LA)).toThrow();
  expect(() => localInstant("2027-11-07", "01:30", LA)).toThrow();
  const spring =
    localInstant("2027-03-14", "04:00", LA).getTime() -
    localInstant("2027-03-14", "00:00", LA).getTime();
  const fall =
    localInstant("2027-11-07", "04:00", LA).getTime() -
    localInstant("2027-11-07", "00:00", LA).getTime();
  expect(spring).toBe(3 * 3600000);
  expect(fall).toBe(5 * 3600000);
  expect(localInstant("2027-01-08", "08:00", LA).toISOString()).toBe("2027-01-08T16:00:00.000Z");
  expect(localInstant("2027-07-08", "08:00", LA).toISOString()).toBe("2027-07-08T15:00:00.000Z");
});

it("computes exclusive day, Monday-first week and next-month ranges", () => {
  expect(dateRange("2027-01-08", "day")).toEqual({ from: "2027-01-08", to: "2027-01-09" });
  // 2027-01-08 is a Friday; 2027-01-10 a Sunday.
  expect(dateRange("2027-01-08", "week")).toEqual({ from: "2027-01-04", to: "2027-01-11" });
  expect(dateRange("2027-01-10", "week")).toEqual({ from: "2027-01-04", to: "2027-01-11" });
  expect(dateRange("2027-12-15", "month")).toEqual({ from: "2027-12-01", to: "2028-01-01" });
});

it("derives today in the location time zone, not UTC", () => {
  // 03:30 UTC on 9 Jan is still the evening of 8 Jan in Los Angeles.
  expect(todayIn(LA, new Date("2027-01-09T03:30:00Z"))).toBe("2027-01-08");
  expect(todayIn("UTC", new Date("2027-01-09T03:30:00Z"))).toBe("2027-01-09");
});

it("splits inclusive calendar days across a year boundary", () => {
  expect(daysByYear("2027-12-30", "2028-01-02")).toEqual({ "2027": 2, "2028": 2 });
  expect(daysByYear("2027-03-10", "2027-03-10")).toEqual({ "2027": 1 });
});
