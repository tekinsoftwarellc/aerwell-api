import type { Request } from "express";
import { AppError, ConflictError } from "../../common/errors/AppError.js";
import { audit } from "../audit/audit.js";
import type { MemberDocument } from "../member/member.model.js";
import { organizationToday } from "../schedule/flags.js";
import { addDays } from "../schedule/time.js";
import {
  type ClinicalModule,
  actorId,
  auditRead,
  auditedWrite,
  byMember,
  clinicalMember,
} from "./clinical.shared.js";
import { panelCounts } from "./labs.service.js";
import { OUT_OF_RANGE, type Status } from "./range.js";
import {
  ClinicalList,
  HealthScoreSnapshot,
  type LIST_KINDS,
  LabPanel,
  Scan,
} from "./records.model.js";
import { type WearableDay, getWearablesAdapter } from "./wearables.adapter.js";

export function ageOn(dateOfBirth: string | null | undefined, today: string) {
  if (!dateOfBirth) return null;
  const years = Number(today.slice(0, 4)) - Number(dateOfBirth.slice(0, 4));
  return today.slice(5) < dateOfBirth.slice(5) ? years - 1 : years;
}
const SCORE_SOURCE = {
  source: "clinician_entered",
  note: "Entered by a clinician; the scoring method and source are not defined by Aerwell.",
};

async function latestPanelSummary(member: MemberDocument) {
  const panel = await LabPanel.findOne(byMember(member)).sort({ drawnAt: -1, _id: -1 }).lean();
  if (!panel) return null;
  return {
    panelId: panel._id,
    drawnAt: panel.drawnAt,
    nextPanelDue: panel.nextPanelDue ?? null,
    reviewStatus: panel.reviewStatus,
    ...panelCounts(panel.results),
    flagged: panel.results
      .filter((r) => OUT_OF_RANGE.has((r.status ?? null) as Status))
      .map((r) => ({
        name: r.name,
        shortName: r.shortName,
        value: r.value,
        unit: r.unit,
        status: r.status,
      })),
  };
}
async function latestDexaSummary(member: MemberDocument) {
  const [scan, previous] = await Scan.find({ ...byMember(member), type: "dexa" })
    .sort({ performedAt: -1, _id: -1 })
    .limit(2)
    .lean();
  if (!scan) return null;
  const m = (s: typeof scan | undefined, k: string) =>
    ((s?.metrics ?? {}) as Record<string, { value: number; status: string | null }>)[k];
  const metric = (k: string) => {
    const now = m(scan, k);
    const before = m(previous, k);
    return now
      ? {
          value: now.value,
          status: now.status,
          delta: before ? Math.round((now.value - before.value) * 100) / 100 : null,
        }
      : null;
  };
  const hip = scan.boneDensity.find((b) => b.site === "total_hip_left");
  return {
    scanId: scan._id,
    performedAt: scan.performedAt,
    bodyFatPct: metric("bodyFatPct"),
    leanMassLb: metric("leanMassLb"),
    vatCm2: metric("vatCm2"),
    hipTScore: metric("hipTScore"),
    boneDensity: hip
      ? { site: hip.site, tScore: hip.tScore ?? null, classification: hip.classification ?? null }
      : null,
  };
}
export async function healthSummary(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  const [latest, previous] = await HealthScoreSnapshot.find(byMember(member))
    .sort({ period: -1, createdAt: -1 })
    .limit(2)
    .lean();
  const today = await organizationToday(member.organizationId);
  const summary = {
    score: latest
      ? {
          ...SCORE_SOURCE,
          period: latest.period,
          overallScore: latest.overallScore ?? null,
          statusLabel: latest.statusLabel ?? null,
          biologicalAge: latest.biologicalAge ?? null,
          delta:
            typeof latest.overallScore === "number" && typeof previous?.overallScore === "number"
              ? latest.overallScore - previous.overallScore
              : null,
        }
      : null,
    actualAge: ageOn(member.dateOfBirth, today),
    labs: await latestPanelSummary(member),
    dexa: await latestDexaSummary(member),
  };
  await auditRead(req, "HealthSummary", member);
  return summary;
}

const MONTHS = { "3m": 3, "6m": 6, "1y": 12 } as const;
function monthsBefore(date: string, months: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}
export async function listScores(req: Request) {
  const member = await clinicalMember(req, "LABS_SCANS");
  const range = String(req.query["range"]) as keyof typeof MONTHS;
  const today = await organizationToday(member.organizationId);
  const from = monthsBefore(today, MONTHS[range]);
  const rows = await HealthScoreSnapshot.find({
    ...byMember(member),
    period: { $gte: from, $lte: today },
  })
    .sort({ period: 1, createdAt: 1 })
    .lean();
  await auditRead(req, "HealthScores", member);
  return { ...SCORE_SOURCE, range, from, to: today, items: rows };
}
export function createScore(req: Request) {
  return clinicalMember(req, "LABS_SCANS", true).then((member) =>
    auditedWrite(
      req,
      member,
      { action: "created", targetType: "HealthScoreSnapshot" },
      async (session) => {
        const [row] = await HealthScoreSnapshot.create(
          [{ ...req.body, ...byMember(member), enteredById: actorId(req) }],
          { session }
        );
        if (!row) throw new Error("Score was not saved");
        return row;
      }
    )
  );
}

// ---- Wearables: read-through seam, nothing stored.
const mean = (days: WearableDay[], key: keyof WearableDay) => {
  const values = days.map((d) => d[key]).filter((v): v is number => typeof v === "number");
  return values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
    : null;
};
const AVERAGES = {
  sleep: ["sleepScore", "sleepDurationMin", "hrvMs", "restingHr"],
  activity: ["activeMinutes", "steps", "calories"],
} as const;
export function wearables(windowDays: number) {
  return async (req: Request) => {
    const member = await clinicalMember(req, "LABS_SCANS");
    const metric = req.query["metric"] as "sleep" | "activity";
    const to =
      (req.query["to"] as string | undefined) ?? (await organizationToday(member.organizationId));
    const from = (req.query["from"] as string | undefined) ?? addDays(to, -(windowDays - 1));
    await audit(req, "viewed", "Wearables", metric, String(member._id));
    const adapter = getWearablesAdapter();
    if (!adapter.configured) return { status: "unconfigured", metric, from, to };
    if (!member.alfredAccountId) return { status: "unlinked", metric, from, to };
    try {
      const series = await adapter.read({
        alfredAccountId: member.alfredAccountId,
        metric,
        from,
        to,
      });
      const averages = Object.fromEntries(AVERAGES[metric].map((k) => [k, mean(series.days, k)]));
      const trainingLogged =
        metric === "activity"
          ? series.days.reduce((n, d) => n + (d.trainingSessions ?? 0), 0)
          : undefined;
      return { status: "ok", metric, from, to, ...series, averages, trainingLogged };
    } catch {
      // Never forward upstream text: it may carry PHI or internals.
      throw new AppError("Wearable data unavailable", 503, true, undefined, "UPSTREAM_UNAVAILABLE");
    }
  };
}

// ---- Versioned lists (goals, history, allergies, meds, supps)
export type ListKind = (typeof LIST_KINDS)[number];
export const LIST_MODULE: Record<ListKind, ClinicalModule> = {
  goals: "CLINICAL_NOTES",
  medical_history: "CLINICAL_NOTES",
  allergies: "CLINICAL_NOTES",
  medications: "PROTOCOLS",
  supplements: "PROTOCOLS",
};
export function getList(kind: ListKind) {
  return async (req: Request) => {
    const member = await clinicalMember(req, LIST_MODULE[kind]);
    const row = await ClinicalList.findOne({ ...byMember(member), kind }).lean();
    await auditRead(req, `ClinicalList:${kind}`, member);
    return {
      kind,
      items: row?.items ?? [],
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
    };
  };
}
const isDuplicate = (e: unknown) => (e as { code?: number }).code === 11000;
export function putList(kind: ListKind) {
  return async (req: Request) => {
    const member = await clinicalMember(req, LIST_MODULE[kind], true);
    const { expectedVersion, items } = req.body;
    try {
      const row = await auditedWrite(
        req,
        member,
        { action: "updated", targetType: `ClinicalList:${kind}` },
        async (session) => {
          // Upsert on the expected version: a stale editor matches nothing and
          // collides with the unique (member, kind) row instead of overwriting it.
          const updated = await ClinicalList.findOneAndUpdate(
            { ...byMember(member), kind, version: expectedVersion },
            { $set: { items, updatedById: actorId(req) }, $inc: { version: 1 } },
            { upsert: true, new: true, session }
          );
          return updated;
        }
      );
      return { kind, items: row.items, version: row.version, updatedAt: row.updatedAt };
    } catch (error) {
      if (isDuplicate(error))
        throw new ConflictError(
          "This list changed since you opened it",
          undefined,
          "VERSION_CONFLICT"
        );
      throw error;
    }
  };
}
