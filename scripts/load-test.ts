/**
 * W11 load test. Disposable memory Mongo only; never point it at a real database.
 *
 *   npx tsx scripts/load-test.ts [--members=10000] [--appointments=50000] [--out=file.json]
 *
 * 1. Starts a one-node MongoMemoryReplSet and seeds the dev reference data plus
 *    synthetic members, memberships, shifts, appointments, lab panels, notes,
 *    flags and notifications (no real person's data).
 * 2. Builds every index (the same syncAllIndexes the deploy runs).
 * 3. Starts the real API as a CHILD process (so the load generator does not share
 *    its event loop), signs in over HTTP and measures each endpoint's latency.
 * 4. Profiles every query the API ran and reports collection scans.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback);
const MEMBERS = arg("members", 10_000);
const APPOINTMENTS = arg("appointments", 50_000);
const OUT = process.argv.find((a) => a.startsWith("--out="))?.split("=")[1];
const ORG = "org-load";
const TZ = "America/Los_Angeles";
const ADMIN = { email: "load.admin@example.invalid", password: "Load-test-passphrase!9" };
const PROVIDERS = 30;
const BOOKING_PROVIDERS = 5;
const WEEKS = 13; // shifts and appointments span ±13 weeks around today

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
const pick = <T>(list: T[], i: number): T => list[i % list.length] as T;
const LAST = ["Nguyen", "Garcia", "Smith", "Johnson", "Patel", "Kim", "Brown", "Lopez", "Davis"];
const FIRST = ["Avery", "Jordan", "Riley", "Casey", "Morgan", "Quinn", "Taylor", "Skyler"];

async function seed(uri: string) {
  process.env["MONGODB_URI"] = uri;
  process.env["NODE_ENV"] = "test";
  process.env["STAFF_JWT_SECRET"] = "load-test-only-signing-key-0123456789";
  process.env["AERWELL_ORG_ID"] = ORG;
  await mongoose.connect(uri);
  const { seedDevelopmentData } = await import("../src/scripts/seed.service.js");
  const { syncAllIndexes } = await import("../src/config/indexes.js");
  const { Location } = await import("../src/api/location/location.model.js");
  const { Service } = await import("../src/api/service/service.model.js");
  const { MembershipPlan } = await import("../src/api/catalog/catalog.model.js");
  const { Role } = await import("../src/api/role/role.model.js");
  const { StaffMember } = await import("../src/api/staff/staff.model.js");
  const { Shift } = await import("../src/api/schedule/schedule.model.js");
  const { Member, MemberMembership, MemberNote, MemberFlag } = await import(
    "../src/api/member/member.model.js"
  );
  const { Appointment } = await import("../src/api/appointment/appointment.model.js");
  const { LabPanel } = await import("../src/api/clinical/records.model.js");
  const { Notification } = await import("../src/api/notification/notification.model.js");
  const { localInstant, todayIn, addDays } = await import("../src/api/schedule/time.js");

  await seedDevelopmentData({
    organizationId: ORG,
    ...ADMIN,
    firstName: "Load",
    lastName: "Admin",
  });
  await syncAllIndexes();
  const location = await Location.findOne({ organizationId: ORG }).lean();
  if (!location) throw new Error("No seeded location");
  await Location.updateOne(
    { _id: location._id },
    {
      businessHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        open: "07:00",
        close: "19:00",
        closed: weekday === 0 || weekday === 6,
      })),
    }
  );
  const services = (
    await Service.find({ organizationId: ORG, status: "active", deletedAt: null }).lean()
  ).filter((s) => !s.bundleComponentIds?.length);
  const plans = await MembershipPlan.find({ organizationId: ORG }).lean();
  const physician = await Role.findOne({ organizationId: ORG, name: /Physician/ }).lean();
  const admin = await StaffMember.findOne({ organizationId: ORG, email: ADMIN.email }).lean();
  if (!(physician && admin)) throw new Error("Seed incomplete");
  await StaffMember.updateOne({ _id: admin._id }, { isProvider: true });

  const providerIds = Array.from(
    { length: PROVIDERS + BOOKING_PROVIDERS },
    () => new Types.ObjectId()
  );
  await StaffMember.collection.insertMany(
    providerIds.map((_id, i) => ({
      _id,
      organizationId: ORG,
      email: `provider${i}@example.invalid`,
      firstName: pick(FIRST, i),
      lastName: `Provider${i}`,
      roleId: physician._id,
      isProvider: true,
      accountStatus: "active",
      deletedAt: null,
      isSuperAdmin: false,
      permissionOverrides: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
  );
  const today = todayIn(TZ, new Date());
  const dates: string[] = [];
  for (let d = -WEEKS * 7; d <= WEEKS * 7; d += 1) {
    const date = addDays(today, d);
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) dates.push(date);
  }
  const shifts = [];
  for (const staffId of [...providerIds, admin._id])
    for (const date of dates)
      shifts.push({
        organizationId: ORG,
        staffId,
        positionRoleId: physician._id,
        locationId: location._id,
        date,
        startTime: "08:00",
        endTime: "17:00",
        startAt: localInstant(date, "08:00", TZ),
        endAt: localInstant(date, "17:00", TZ),
        timeZone: TZ,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
  await Shift.collection.insertMany(shifts);

  const memberIds = Array.from({ length: MEMBERS }, () => new Types.ObjectId());
  for (let i = 0; i < MEMBERS; i += 2000)
    await Member.collection.insertMany(
      memberIds.slice(i, i + 2000).map((_id, k) => {
        const n = i + k;
        return {
          _id,
          organizationId: ORG,
          firstName: pick(FIRST, n),
          lastName: `${pick(LAST, n)}${n}`,
          email: `member${n}@example.invalid`,
          status: n % 10 === 0 ? "pending_onboarding" : "active",
          assignedClinicianIds: [pick(providerIds, n)],
          lastVisitAt: null,
          archivedAt: null,
          membershipRevision: 0,
          createdAt: new Date(Date.now() - n * 60_000),
          updatedAt: new Date(),
        };
      })
    );
  const continuum = plans.find((p) => p.slug === "aerwell-continuum") ?? plans[0];
  await MemberMembership.collection.insertMany(
    memberIds
      .filter((_, n) => n % 10 < 7)
      .map((memberId) => ({
        organizationId: ORG,
        memberId,
        planId: continuum?._id,
        status: "active",
        startedAt: new Date(Date.now() - 200 * 86_400_000),
        endsAt: null,
        periodAnchor: "anniversary",
        priceCents: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
  );
  const busy = providerIds.slice(0, PROVIDERS);
  const appointments = [];
  const now = Date.now();
  for (let n = 0; n < APPOINTMENTS; n += 1) {
    const service = pick(services, n);
    const date = pick(dates, Math.floor(n / PROVIDERS));
    const slot = n % 36; // 15-minute slots from 08:00
    const startAt = localInstant(
      date,
      `${String(8 + Math.floor(slot / 4)).padStart(2, "0")}:${String((slot % 4) * 15).padStart(2, "0")}`,
      TZ
    );
    const past = startAt.getTime() < now;
    appointments.push({
      organizationId: ORG,
      memberId: pick(memberIds, n * 7),
      serviceId: service._id,
      categoryId: service.categoryId,
      providerId: n % 50 === 0 ? admin._id : pick(busy, n),
      locationId: location._id,
      startAt,
      endAt: new Date(startAt.getTime() + service.durationMinutes * 60_000),
      durationMinutes: service.durationMinutes,
      timeZone: TZ,
      status: past ? (n % 13 === 0 ? "no_show" : "completed") : n % 3 ? "booked" : "confirmed",
      deliveryMethod: "standard",
      modality: service.modality ?? "physical",
      bookingSource: "staff",
      bookedById: admin._id,
      price: { decision: "retail", finalCents: 0 },
      amountDueCents: 0,
      paymentStatus: "not_required",
      statusHistory: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  for (let i = 0; i < appointments.length; i += 5000)
    await Appointment.collection.insertMany(appointments.slice(i, i + 5000));
  await LabPanel.collection.insertMany(
    memberIds.map((memberId, n) => ({
      organizationId: ORG,
      memberId,
      drawnAt: new Date(now - (n % 180) * 86_400_000),
      panelType: "Full Panel",
      reviewStatus: n % 20 === 0 ? "new" : "reviewed",
      results: Array.from({ length: 20 }, (_, k) => ({
        biomarkerId: new Types.ObjectId(),
        key: `marker${k}`,
        name: `Marker ${k}`,
        category: "metabolic",
        resultType: "numeric",
        value: (n % 97) + k,
        status: "normal",
      })),
      createdAt: new Date(now - n * 30_000),
      updatedAt: new Date(),
    }))
  );
  await MemberNote.collection.insertMany(
    Array.from({ length: MEMBERS * 2 }, (_, n) => ({
      organizationId: ORG,
      memberId: pick(memberIds, n),
      authorId: pick(busy, n),
      body: `Synthetic note ${n}`,
      readBy: n % 4 ? [admin._id] : [],
      createdAt: new Date(now - n * 60_000),
      updatedAt: new Date(),
    }))
  );
  await MemberFlag.collection.insertMany(
    Array.from({ length: MEMBERS / 5 }, (_, n) => ({
      organizationId: ORG,
      memberId: pick(memberIds, n * 3),
      category: pick(["waitlist", "clinical", "billing"], n),
      title: `Synthetic flag ${n}`,
      severity: "open",
      resolvedAt: n % 2 ? new Date() : null,
      raisedAt: new Date(now - n * 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
  );
  await Notification.collection.insertMany(
    Array.from({ length: 2000 }, (_, n) => ({
      organizationId: ORG,
      recipientStaffId: admin._id,
      kind: "appointment_booked",
      category: "appointments",
      title: "Appointment booked",
      link: null,
      critical: false,
      deliverAfter: new Date(now - n * 60_000),
      readAt: n % 3 ? new Date() : null,
      deliveries: { in_app: "delivered", email: "off", push: "off" },
      createdAt: new Date(now - n * 60_000),
      updatedAt: new Date(),
    }))
  );
  // Booking targets: providers with shifts but no seeded appointments, next week.
  const bookable = services.find((s) => s.slug === "red-light-therapy") ?? services[0];
  const nextWeek = dates.filter((d) => d > addDays(today, 7)).slice(0, 10);
  const targets = providerIds.slice(PROVIDERS).flatMap((providerId, p) =>
    nextWeek.flatMap((date) =>
      ["09:00", "10:00", "11:00", "13:00", "14:00", "15:00"].map((time, t) => ({
        providerId: String(providerId),
        startAt: localInstant(date, time, TZ).toISOString(),
        memberId: String(pick(memberIds, (p * 97 + t * 13 + date.length) * 10 + 1)),
      }))
    )
  );
  const counts = {
    members: await Member.countDocuments(),
    memberships: await MemberMembership.countDocuments(),
    appointments: await Appointment.countDocuments(),
    shifts: await Shift.countDocuments(),
    labPanels: await LabPanel.countDocuments(),
    notes: await MemberNote.countDocuments(),
    flags: await MemberFlag.countDocuments(),
    notifications: await Notification.countDocuments(),
  };
  await mongoose.disconnect();
  return {
    counts,
    today,
    location: String(location._id),
    bookableService: String(bookable?._id),
    service: String(services[0]?._id),
    provider: String(busy[0]),
    member: String(memberIds[1]),
    targets,
  };
}

async function startApi(uri: string, port: number): Promise<ChildProcess> {
  // cwd is an empty temp dir so dotenv finds no developer .env; tsx by absolute path.
  const root = new URL("..", import.meta.url);
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("node_modules/tsx/dist/loader.mjs", root).href,
      new URL("src/index.ts", root).pathname,
    ],
    {
      cwd: mkdtempSync(join(tmpdir(), "aerwell-load-")),
      env: {
        PATH: process.env["PATH"] ?? "",
        NODE_ENV: "production",
        PORT: String(port),
        HOST: "127.0.0.1",
        MONGODB_URI: uri,
        CORS_ORIGIN: "http://127.0.0.1:1",
        RATE_LIMIT_MAX: "10000000",
        STAFF_JWT_SECRET: "load-test-only-signing-key-0123456789",
        AERWELL_ORG_ID: ORG,
      },
      stdio: ["ignore", "ignore", "inherit"],
    }
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    const ok = await fetch(`${base}/api/v1/health/ready`).then(
      (r) => r.ok,
      () => false
    );
    if (ok) return child;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGKILL");
  throw new Error("API did not become ready");
}

interface Result {
  name: string;
  requests: number;
  concurrency: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statuses: Record<string, number>;
}
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
async function bench(
  name: string,
  requests: number,
  concurrency: number,
  send: (i: number) => Promise<Response>
): Promise<Result> {
  const times: number[] = [];
  const statuses: Record<string, number> = {};
  let next = 0;
  const worker = async () => {
    while (next < requests) {
      const i = next++;
      const started = performance.now();
      const res = await send(i);
      await res.arrayBuffer();
      times.push(performance.now() - started);
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  times.sort((a, b) => a - b);
  const r = (v: number) => Math.round(v * 10) / 10;
  return {
    name,
    requests,
    concurrency,
    p50: r(percentile(times, 50)),
    p95: r(percentile(times, 95)),
    p99: r(percentile(times, 99)),
    max: r(times.at(-1) ?? 0),
    statuses,
  };
}

async function profileScans(uri: string) {
  const client = await mongoose.createConnection(uri).asPromise();
  const db = client.db;
  if (!db) throw new Error("No db");
  const rows = await db
    .collection("system.profile")
    .aggregate([
      { $match: { ns: { $not: /system\.|\.\$cmd/ }, planSummary: { $exists: true } } },
      {
        $group: {
          _id: { ns: "$ns", plan: "$planSummary", op: "$op" },
          count: { $sum: 1 },
          maxDocsExamined: { $max: "$docsExamined" },
          maxKeysExamined: { $max: "$keysExamined" },
          maxMillis: { $max: "$millis" },
          sortInMemory: { $max: { $cond: ["$hasSortStage", 1, 0] } },
        },
      },
      { $sort: { maxDocsExamined: -1 } },
    ])
    .toArray();
  await client.close();
  return rows.map((r) => ({
    collection: String(r._id.ns).split(".").slice(1).join("."),
    op: r._id.op,
    plan: r._id.plan,
    count: r.count,
    maxDocsExamined: r.maxDocsExamined,
    maxKeysExamined: r.maxKeysExamined,
    maxMillis: r.maxMillis,
    sortInMemory: Boolean(r.sortInMemory),
  }));
}

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri("aerwell-load");
  let api: ChildProcess | undefined;
  try {
    const t0 = performance.now();
    const world = await seed(uri);
    const seedSeconds = Math.round((performance.now() - t0) / 1000);
    const port = await freePort();
    api = await startApi(uri, port);
    const base = `http://127.0.0.1:${port}/api/v1`;
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ADMIN),
    }).then((r) => r.json() as Promise<{ data: { accessToken: string } }>);
    const headers = {
      authorization: `Bearer ${login.data.accessToken}`,
      "content-type": "application/json",
    };
    const get = (path: string) => () => fetch(`${base}${path}`, { headers });
    const post = (path: string, body: (i: number) => object) => (i: number) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body(i)) });
    const weekFrom = world.today;
    const weekTo = new Date(new Date(`${world.today}T12:00:00Z`).getTime() + 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const N = 200;
    const C = 10;
    const quoteBody = () => ({
      memberId: world.member,
      serviceId: world.bookableService,
      locationId: world.location,
      startAt: world.targets[0]?.startAt,
      deliveryMethod: "standard",
    });
    const results: Result[] = [];
    const half = Math.floor(world.targets.length / 2);
    // Warm-up (JIT, connection pool, plan cache) is not measured.
    await bench("warmup", 50, C, get("/members?page=1&limit=20"));
    const cases: [string, number, (i: number) => Promise<Response>][] = [
      ["GET /members (list, sort lastName, page 1)", N, get("/members?page=1&limit=20")],
      ["GET /members (list, page 250)", N, get("/members?page=250&limit=20")],
      ["GET /members?q= (search substring)", N, get("/members?q=garc&limit=20")],
      ["GET /members/search?q= (typeahead)", N, get("/members/search?q=nguy")],
      [
        "GET /appointments (calendar week, limit 500)",
        N,
        get(`/appointments?from=${weekFrom}&to=${weekTo}&limit=500`),
      ],
      [
        "GET /appointments/summary (month)",
        N,
        get(`/appointments/summary?month=${weekFrom.slice(0, 7)}`),
      ],
      [
        "GET /availability (1 provider, 7 days)",
        N,
        get(
          `/availability?serviceId=${world.bookableService}&locationId=${world.location}&providerId=${world.targets[0]?.providerId}&from=${weekFrom}&to=${weekTo}`
        ),
      ],
      ["POST /appointments/quote", N, post("/appointments/quote", quoteBody)],
      [
        "POST /appointments (book, 1 at a time)",
        half,
        post("/appointments", (i) => ({
          ...world.targets[half + i],
          serviceId: world.bookableService,
          locationId: world.location,
          deliveryMethod: "standard",
        })),
      ],
      [
        "POST /appointments (book, 10 concurrent)",
        half,
        post("/appointments", (i) => ({
          ...world.targets[i],
          serviceId: world.bookableService,
          locationId: world.location,
          deliveryMethod: "standard",
        })),
      ],
      ["GET /dashboard/summary", N, get("/dashboard/summary")],
      ["GET /dashboard/agenda", N, get("/dashboard/agenda")],
      ["GET /notifications", N, get("/notifications?limit=20")],
      ["GET /me/counters", N, get("/me/counters")],
      ["GET /members/:id/overview", N, get(`/members/${world.member}/overview`)],
      ["GET /members/:id/appointments", N, get(`/members/${world.member}/appointments`)],
      ["GET /members/:id/lab-panels", N, get(`/members/${world.member}/lab-panels`)],
      ["GET /staff", N, get("/staff?limit=20")],
      ["GET /audit-events", N, get("/audit-events?limit=50")],
    ];
    for (const [name, n, send] of cases)
      results.push(await bench(name, n, name.includes("1 at a time") ? 1 : C, send));
    // Second, unmeasured pass with the profiler on (profiling slows every query):
    // five calls of each read path, then every plan is inspected.
    const admin = await mongoose.createConnection(uri).asPromise();
    // system.profile is a 1 MB capped collection by default: make room for the sweep.
    await admin.db
      ?.collection("system.profile")
      .drop()
      .catch(() => undefined);
    await admin.db?.createCollection("system.profile", { capped: true, size: 256 * 1024 * 1024 });
    await admin.db?.command({ profile: 2 });
    for (const [name, , send] of cases)
      if (!name.startsWith("POST /appointments (book")) await bench(name, 5, 1, send);
    await admin.db?.command({ profile: 0 });
    await admin.close();
    const scans = await profileScans(uri);
    const report = {
      when: new Date().toISOString(),
      machine: {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        cpus: (await import("node:os")).cpus().length,
        mongo: "mongodb-memory-server single-node replica set (same machine)",
      },
      seedSeconds,
      counts: world.counts,
      concurrency: C,
      results,
      collectionScans: scans.filter((s) => String(s.plan).startsWith("COLLSCAN")),
      heaviestQueries: scans.slice(0, 15),
    };
    if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.table(
      results.map(({ statuses, ...r }) => ({ ...r, statuses: JSON.stringify(statuses) }))
    );
    console.log(
      JSON.stringify({ counts: report.counts, collectionScans: report.collectionScans }, null, 2)
    );
  } finally {
    api?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    await replSet.stop();
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
