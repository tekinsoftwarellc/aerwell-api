import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PartnerOutbox } from "./api/alfred-partner/outbox/partnerOutbox.model.js";
import { drainOutbox } from "./api/alfred-partner/outbox/partnerOutbox.publisher.js";
import { releaseUnpaidOrders } from "./api/product/productOrder.service.js";
import { pinClock } from "./test/appointmentFixture.js";
import { client } from "./test/memberFixture.js";
import { staffWith } from "./test/memberFixture.js";
import { installAlfredKeys, removeAlfredKeys } from "./test/partnerFixture.js";
import { ADDRESS, productWorld } from "./test/productFixture.js";
import { app } from "./test/scheduleFixture.js";

/**
 * A product order's shipping address and a cancel reason, followed through place, read, cancel, ship,
 * the staff list, the sweep, a late payment and a failing publish: no log line, event or outbox error
 * text may carry them.
 */
const sink = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock("./common/utils/logger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./common/utils/logger.js")>();
  const capture = {
    write: (line: string) => {
      sink.lines.push(line);
    },
  };
  return { ...real, logger: real.createLogger(capture as never) };
});
vi.mock("./common/middleware/requestLogger.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./common/middleware/requestLogger.js")>();
  const { logger } = await import("./common/utils/logger.js");
  return { ...real, requestLogger: real.createRequestLogger(logger, true) };
});

beforeEach(() => {
  pinClock();
  sink.lines.length = 0;
  installAlfredKeys();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  removeAlfredKeys();
});

const SENTINELS = ["ADDRESS-SENTINEL", "89104", "REASON-SENTINEL", "Maple"];
const leaks = (text: string) => SENTINELS.filter((s) => text.includes(s));

it("a product order's address and cancel reason reach no log line, event or outbox error text", async () => {
  expect(JSON.stringify(ADDRESS)).toContain("ADDRESS-SENTINEL");
  const w = await productWorld();
  const staff = client(app, (await staffWith({ BILLING: "edit" })).accessToken);
  const shipped = await w.product();
  const cancelled = await w.product();
  const released = await w.product();
  for (const p of [shipped, cancelled, released]) await w.prescribe(p._id);
  const a = await w.place([{ itemRef: `prod_${shipped.sku}`, quantity: 1 }]);
  const b = await w.place([{ itemRef: `prod_${cancelled.sku}`, quantity: 1 }]);
  const c = await w.place([{ itemRef: `prod_${released.sku}`, quantity: 1 }]);
  // A refused order (non-US address) logs its refusal too.
  expect(
    (
      await w.place([{ itemRef: `prod_${shipped.sku}`, quantity: 1 }], {
        shippingAddress: { ...ADDRESS, country: "CA" },
      })
    ).status
  ).toBe(409);
  const [ref1, ref2, ref3] = [a, b, c].map((r) => r.body.data.orderRef as string);
  await w.event("order.paid", ref1 as string, { amountCents: 3400 });
  await w.event("order.paid", ref2 as string, { amountCents: 3400 });
  expect((await w.alfred.get(`/orders/${ref1}`)).status).toBe(200);
  expect(
    (await w.alfred.post(`/orders/${ref2}/cancel`, { reason: "REASON-SENTINEL" })).status
  ).toBe(200);
  expect(
    (
      await staff.send("post", `/product-orders/${ref1}/ship`, {
        carrier: "UPS",
        number: "1Z-DEMO",
      })
    ).status
  ).toBe(200);
  expect((await staff.get("/product-orders")).status).toBe(200);
  expect(await releaseUnpaidOrders(new Date(Date.now() + 3_600_000))).toBe(1);
  await w.event("order.paid", ref3 as string, { amountCents: 3400 });
  const events = JSON.stringify(await PartnerOutbox.find({}).lean());
  expect(events).toContain("order.shipped");
  expect(leaks(events)).toEqual([]);
  vi.stubGlobal("fetch", async () => {
    throw new Error(`connect failed ${ADDRESS.line1} ${ADDRESS.postalCode}`);
  });
  expect((await drainOutbox()).retried).toBeGreaterThan(0);
  expect(leaks(JSON.stringify(await PartnerOutbox.find({}).lean()))).toEqual([]);
  expect(sink.lines.length).toBeGreaterThan(5);
  const text = sink.lines.join("\n").replace(/"time":"[^"]*"/g, '""');
  expect(leaks(text)).toEqual([]);
});
