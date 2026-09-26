import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pinClock } from "../../test/appointmentFixture.js";
import { ORG } from "../../test/memberFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { visitWorld } from "../../test/visitFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { Member, MemberNote } from "../member/member.model.js";
import { StaffMember } from "../staff/staff.model.js";
import { CONSENT_TEXT, TranscriptSegment, VisitConsent } from "./visit.model.js";

beforeEach(() => pinClock());
afterEach(() => vi.useRealTimers());

const actions = async (targetType: string) =>
  (await AuditEvent.find({ targetType }).sort({ _id: 1 }).lean()).map((e) => e.action);

it("stamps the visit start and end through the status route and reports the duration", async () => {
  const v = await visitWorld(false);
  const visit = () => v.api.get(`/api/v1/appointments/${v.id}/visit`);
  expect((await visit()).body.data).toMatchObject({
    status: "booked",
    startedAt: null,
    durationSec: null,
  });
  await v.status("checked_in");
  vi.setSystemTime(new Date("2027-03-01T20:01:00.000Z"));
  await v.status("in_progress");
  vi.setSystemTime(new Date("2027-03-01T20:13:32.000Z"));
  await v.status("completed");
  const body = (await visit()).body.data;
  expect(body).toMatchObject({ status: "completed", durationSec: 752 });
  expect(body.startedAt).toBe("2027-03-01T20:01:00.000Z");
  expect(body.consentText).toEqual(CONSENT_TEXT);
  expect(body.transcription).toEqual({ configured: false });
  expect(body.suggestions).toMatchObject({ configured: false, count: 0 });
  expect(await actions("Visit")).toContain("viewed");
});

it("records versioned consent once, refuses stale wording, and allows re-consent after revoking", async () => {
  const v = await visitWorld(false);
  const early = await v.consent();
  expect(early.status).toBe(422);
  expect(early.body.code).toBe("VISIT_NOT_ACTIVE");
  await v.status("checked_in");
  const stale = await v.api.post(`/api/v1/appointments/${v.id}/visit/consent`, {
    method: "verbal",
    consentVersion: "2020-01-01.0",
  });
  expect(stale.body.code).toBe("CONSENT_VERSION_STALE");
  // Two clinicians ticking the box at once: exactly one consent row.
  const [a, b] = await Promise.all([v.consent(), v.consent()]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);
  expect([a, b].find((r) => r.status === 409)?.body.code).toBe("CONSENT_ALREADY_RECORDED");
  const row = await VisitConsent.findOne({ appointmentId: v.id }).lean();
  expect(row).toMatchObject({
    method: "verbal",
    consentVersion: CONSENT_TEXT.version,
    consentText: CONSENT_TEXT.text,
    revokedAt: null,
  });
  expect(String(row?.capturedById)).toBe(String(v.director.staff._id));
  const state = (await v.api.get(`/api/v1/appointments/${v.id}/visit`)).body.data;
  expect(state.consent).toMatchObject({ method: "verbal", consentVersion: CONSENT_TEXT.version });
  expect(state.consent.capturedBy.name).toBe("Test Actor");

  const revoke = () => v.api.post(`/api/v1/appointments/${v.id}/visit/consent/revoke`);
  expect((await revoke()).status).toBe(200);
  expect((await revoke()).body.code).toBe("NO_ACTIVE_CONSENT");
  expect((await v.api.get(`/api/v1/appointments/${v.id}/visit`)).body.data.consent).toBeNull();
  expect((await v.consent()).status).toBe(201);
  expect(await VisitConsent.countDocuments({ appointmentId: v.id })).toBe(2);
  expect(await actions("VisitConsent")).toEqual([
    "consent_recorded",
    "consent_revoked",
    "consent_recorded",
  ]);
});

it("needs CLINICAL_NOTES: front desk is refused, view-only cannot record consent", async () => {
  const v = await visitWorld();
  const frontDesk = await staffFixture(false, 4);
  const res = await as(frontDesk.accessToken).get(`/api/v1/appointments/${v.id}/visit`);
  expect(res.status).toBe(403);
  expect(res.body.code).toBe("CLINICAL_NOTES_REQUIRED");
  expect(
    (await as(frontDesk.accessToken).get(`/api/v1/appointments/${v.id}/transcript`)).status
  ).toBe(403);
  const coordinator = await staffFixture(false, 3); // CLINICAL_NOTES view, APPOINTMENTS master
  const api = as(coordinator.accessToken);
  expect((await api.get(`/api/v1/appointments/${v.id}/visit`)).status).toBe(200);
  expect((await api.get(`/api/v1/appointments/${v.id}/transcript`)).status).toBe(200);
  const consent = await api.post(`/api/v1/appointments/${v.id}/visit/consent`, {
    method: "verbal",
    consentVersion: CONSENT_TEXT.version,
  });
  expect(consent.status).toBe(403);
  expect((await api.patch(`/api/v1/appointments/${v.id}/visit`, { summary: "x" })).status).toBe(
    403
  );
  expect(await VisitConsent.countDocuments()).toBe(0);
});

it("applies CLINICAL_NOTES own scope to the visit: unassigned members are not found", async () => {
  const v = await visitWorld();
  const nurse = await staffFixture(false, 2);
  await StaffMember.updateOne(
    { _id: nurse.staff._id },
    { $set: { permissionOverrides: [{ module: "CLINICAL_NOTES", level: "edit", scope: "own" }] } }
  );
  const api = as(nurse.accessToken);
  expect((await api.get(`/api/v1/appointments/${v.id}/visit`)).status).toBe(404);
  await Member.updateOne(
    { _id: v.memberRow._id },
    { $set: { assignedClinicianIds: [nurse.staff._id] } }
  );
  expect((await api.get(`/api/v1/appointments/${v.id}/visit`)).status).toBe(200);
});

it("returns the transcript in capture then sequence order with per-capture Speaker N labels", async () => {
  const v = await visitWorld();
  const seg = (captureIndex: number, sourceSequence: number, speakerLabel: string, text: string) =>
    TranscriptSegment.create({
      organizationId: ORG,
      appointmentId: v.id,
      memberId: v.memberRow._id,
      captureIndex,
      sourceSequence,
      resultId: `r${captureIndex}-${sourceSequence}`,
      speakerLabel,
      startedAtMs: sourceSequence * 1000,
      endedAtMs: sourceSequence * 1000 + 500,
      // Spoken times deliberately disagree with the stream order.
      spokenAt: new Date(Date.UTC(2027, 2, 1, 20, 0, 60 - captureIndex * 10 - sourceSequence)),
      text,
    });
  // Neither this insertion order nor its reverse is the expected order.
  await seg(1, 1, "spk_0", "e");
  await seg(0, 2, "spk_0", "c");
  await seg(1, 0, "spk_1", "d");
  await seg(0, 0, "spk_0", "a");
  await seg(0, 1, "spk_1", "b");
  const res = await v.api.get(`/api/v1/appointments/${v.id}/transcript`);
  expect(res.body.data.retention).toBe("transcript_only");
  const lines = res.body.data.segments.map(
    (s: { text: string; speaker: string }) => `${s.text}:${s.speaker}`
  );
  // spk_0 of the SECOND capture is not assumed to be the same person as the first's.
  expect(lines).toEqual([
    "a:Speaker 1",
    "b:Speaker 2",
    "c:Speaker 1",
    "d:Speaker 3",
    "e:Speaker 4",
  ]);
  expect(JSON.stringify(res.body.data)).not.toMatch(/doctor|patient|provider|member/i);
  expect(await actions("VisitTranscript")).toEqual(["viewed"]);
});

it("edits the visit summary only after the visit starts", async () => {
  const v = await visitWorld(false);
  await v.status("checked_in");
  const early = await v.api.patch(`/api/v1/appointments/${v.id}/visit`, { summary: "Plan" });
  expect(early.body.code).toBe("VISIT_NOT_STARTED");
  await v.status("in_progress");
  const ok = await v.api.patch(`/api/v1/appointments/${v.id}/visit`, { summary: "Review labs" });
  expect(ok.body.data).toEqual({ summary: "Review labs" });
  expect((await v.api.get(`/api/v1/appointments/${v.id}/visit`)).body.data.summary).toBe(
    "Review labs"
  );
  expect(await actions("Visit")).toContain("summary_updated");
});

it("filters notes by visit and refuses a note on another member's appointment", async () => {
  const v = await visitWorld();
  const otherMember = await v.member(["aerwell-essential"]);
  const booked = await v.api.post(
    "/api/v1/appointments",
    v.booking(otherMember._id, "clinician-telehealth-visit", "10:00")
  );
  const other = { id: booked.body.data.appointment._id as string };
  const notes = `/api/v1/members/${v.memberRow._id}/notes`;
  expect(
    (await v.api.post(notes, { body: "Visit note", appointmentId: v.id, recordingOffsetSec: 738 }))
      .status
  ).toBe(201);
  expect((await v.api.post(notes, { body: "General note" })).status).toBe(201);
  const foreign = await v.api.post(notes, { body: "Wrong visit", appointmentId: other.id });
  expect(foreign.status).toBe(404);
  const visitOnly = await v.api.get(`${notes}?appointmentId=${v.id}`);
  expect(visitOnly.body.data.items.map((n: { body: string }) => n.body)).toEqual(["Visit note"]);
  expect(visitOnly.body.data.items[0].recordingOffsetSec).toBe(738);
  const all = await v.api.get(notes);
  expect(all.body.data.items.map((n: { body: string }) => n.body).sort()).toEqual([
    "General note",
    "Visit note",
  ]);
  expect(await MemberNote.countDocuments({ body: "Wrong visit" })).toBe(0);
});
