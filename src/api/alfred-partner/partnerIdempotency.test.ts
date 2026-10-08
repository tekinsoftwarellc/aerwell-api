import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { AppError, NotFoundError } from "../../common/errors/AppError.js";
import { errorHandler } from "../../common/middleware/errorHandler.js";
import { ServiceResponse } from "../../common/models/serviceResponse.js";
import { STALE_CLAIM_MS, idempotent } from "./partnerIdempotency.js";
import { PartnerIdempotencyKey } from "./partnerIdempotency.model.js";

let runs = 0;
let slow = 0;
const app = express();
app.use(express.json());
app.post("/ok", idempotent(), async (_req, res) => {
  runs += 1;
  if (slow) await new Promise((r) => setTimeout(r, slow));
  res.status(201).json(ServiceResponse.success("made", { n: runs }, 201));
});
app.post("/other", idempotent(), (_req, res) => {
  runs += 1;
  res.json(ServiceResponse.success("other", { n: runs }));
});
app.post("/refuse", idempotent(), () => {
  runs += 1;
  throw new NotFoundError("gone");
});
let fail = true;
app.post("/flaky", idempotent(), () => {
  runs += 1;
  if (fail) throw new AppError("boom", 500);
  throw new NotFoundError("recovered");
});
app.use(errorHandler);
const post = (path: string, key: string | null, body: object = { a: 1 }) => {
  const r = request(app).post(path);
  return (key === null ? r : r.set("Idempotency-Key", key)).send(body);
};

describe("partner idempotency store", () => {
  it("replays the first answer without running the handler twice", async () => {
    runs = 0;
    const first = await post("/ok", "book:acct:item:slot:abc");
    const again = await post("/ok", "book:acct:item:slot:abc");
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(runs).toBe(1);
  });
  it("is blind to key order and whitespace in the body", async () => {
    runs = 0;
    await post("/ok", "k-order", { a: 1, b: { c: 2, d: 3 } });
    const again = await post("/ok", "k-order", { b: { d: 3, c: 2 }, a: 1 });
    expect(again.status).toBe(201);
    expect(runs).toBe(1);
  });
  it("answers 422 IDEMPOTENCY_MISMATCH for the same key with a different body", async () => {
    await post("/ok", "k-mismatch", { a: 1 });
    const res = await post("/ok", "k-mismatch", { a: 2 });
    expect(res.status).toBe(422);
    expect(res.body.data).toEqual({ code: "IDEMPOTENCY_MISMATCH" });
  });
  it("treats an absent field, null and an empty object as three bodies", async () => {
    await post("/ok", "k-null", {});
    expect((await post("/ok", "k-null", { a: null })).status).toBe(422);
  });
  it("scopes a key to the route pattern", async () => {
    runs = 0;
    await post("/ok", "same-key");
    const other = await post("/other", "same-key");
    expect(other.status).toBe(200);
    expect(runs).toBe(2);
  });
  it("stores and replays a 4xx exactly like a success", async () => {
    runs = 0;
    const first = await post("/refuse", "k-4xx");
    const again = await post("/refuse", "k-4xx");
    expect(first.status).toBe(404);
    expect(again.status).toBe(404);
    expect(again.body).toEqual(first.body);
    expect(runs).toBe(1);
  });
  it("never stores a 5xx: the outcome is unknown, so a retry runs again", async () => {
    runs = 0;
    fail = true;
    expect((await post("/flaky", "k-5xx")).status).toBe(500);
    fail = false;
    expect((await post("/flaky", "k-5xx")).status).toBe(404);
    expect(runs).toBe(2);
  });
  it("runs the handler once when two identical requests are in flight; the loser is 503, never 4xx", async () => {
    runs = 0;
    slow = 150;
    const [a, b] = await Promise.all([post("/ok", "k-race"), post("/ok", "k-race")]);
    slow = 0;
    expect(runs).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 503]);
    const loser = a.status === 503 ? a : b;
    expect(loser.headers["retry-after"]).toBe("1");
    const retry = await post("/ok", "k-race");
    expect(retry.status).toBe(201);
    expect(retry.headers["idempotency-replayed"]).toBe("true");
    expect(runs).toBe(1);
  });
  it("lets a replay take over a claim left behind by a dead process", async () => {
    runs = 0;
    const first = await post("/ok", "k-dead");
    await PartnerIdempotencyKey.updateOne(
      { key: /k-dead$/ },
      { $set: { state: "pending", claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 1000) } }
    );
    const again = await post("/ok", "k-dead");
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(runs).toBe(2);
  });
  it("requires a visible-ASCII key of at most 128 characters; colons are legal", async () => {
    expect((await post("/ok", null)).status).toBe(400);
    expect((await post("/ok", "a".repeat(129))).status).toBe(400);
    expect((await post("/ok", "has space")).status).toBe(400);
    expect((await post("/ok", `book:${"a".repeat(24)}:${"b".repeat(24)}:slot:key`)).status).toBe(
      201
    );
    expect((await post("/ok", "a".repeat(128))).status).toBe(201);
  });
});
