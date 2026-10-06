import { Types } from "mongoose";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { createServer } from "../../server.js";
import { toCatalogItem } from "../alfred-partner/catalogItem.js";
import { Service } from "./service.model.js";

const sign = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: sign }));

const KEY = "org-test/service-images/3f1c2d4e-0000-4000-8000-000000000001";
const ctx = { allLocationIds: [], marketLocations: new Map(), componentIds: new Set<string>() };
const row = (over: Record<string, unknown> = {}) =>
  ({
    _id: new Types.ObjectId(),
    slug: "dexa-scan",
    title: "DEXA",
    status: "active",
    deletedAt: null,
    modality: "virtual",
    marketScope: "all",
    marketIds: [],
    locationId: null,
    durationMinutes: 30,
    capacityMax: 1,
    basePriceCents: null,
    updatedAt: new Date(),
    imageKey: KEY,
    ...over,
  }) as never;
const create = (over: Record<string, unknown> = {}) =>
  Service.create({
    organizationId: "org-test",
    title: "DEXA",
    categoryId: new Types.ObjectId(),
    slug: "dexa-scan",
    durationMinutes: 30,
    capacityMin: 1,
    capacityMax: 1,
    imageKey: KEY,
    ...over,
  });

beforeEach(() => {
  env.AWS_REGION = "us-east-1";
  env.AWS_S3_BUCKET = "private-test-bucket";
  sign.mockReset();
  sign.mockResolvedValue("https://s3.example.invalid/signed?X-Amz-Expires=300");
});
afterEach(() => {
  env.PUBLIC_API_URL = undefined;
});

describe("catalog media", () => {
  it("links the public image route, versioned by the key, when a base URL is set", () => {
    env.PUBLIC_API_URL = "https://api.example.test/";
    expect(toCatalogItem(row(), ctx).media).toEqual([
      {
        url: "https://api.example.test/api/v1/public/service-images/dexa-scan?v=3f1c2d4e-0000-4000-8000-000000000001",
        kind: "image",
      },
    ]);
  });
  it("is empty without a base URL or without an image", () => {
    expect(toCatalogItem(row(), ctx).media).toEqual([]);
    env.PUBLIC_API_URL = "https://api.example.test";
    expect(toCatalogItem(row({ imageKey: undefined }), ctx).media).toEqual([]);
  });
});

describe("GET /api/v1/public/service-images/:slug", () => {
  const app = createServer();
  it("redirects without auth to a fresh presigned URL, cached for less than its lifetime", async () => {
    await create();
    const res = await request(app).get("/api/v1/public/service-images/dexa-scan?v=abc");
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("https://s3.example.invalid/signed?X-Amz-Expires=300");
    expect(res.headers["cache-control"]).toBe("public, max-age=240");
    expect(sign.mock.calls[0]?.[1].input).toEqual({ Bucket: "private-test-bucket", Key: KEY });
    expect(sign.mock.calls[0]?.[2]).toEqual({ expiresIn: 300 });
  });
  it("404s an unknown, inactive, deleted, imageless, other-org or non-image-key service", async () => {
    await create({ slug: "inactive", status: "inactive" });
    await create({ slug: "deleted", deletedAt: new Date() });
    await create({ slug: "no-image", imageKey: undefined });
    await create({ slug: "other-org", organizationId: "org-other" });
    await create({ slug: "wrong-key", imageKey: "org-test/members/x.png" });
    for (const slug of ["unknown", "inactive", "deleted", "no-image", "other-org", "wrong-key"]) {
      const res = await request(app).get(`/api/v1/public/service-images/${slug}`);
      expect(res.status, slug).toBe(404);
    }
    expect(sign).not.toHaveBeenCalled();
  });
  it("400s a malformed slug or unknown query", async () => {
    expect((await request(app).get("/api/v1/public/service-images/Bad%20Slug")).status).toBe(400);
    expect((await request(app).get("/api/v1/public/service-images/ok-slug?x=1")).status).toBe(400);
  });
});
