import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { pinClock } from "../../test/appointmentFixture.js";
import { ORG } from "../../test/memberFixture.js";
import { as } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { visitWorld } from "../../test/visitFixture.js";
import { AuditEvent } from "../audit/audit.js";
import { ClinicalList } from "../clinical/records.model.js";
import { MemberFlag, MemberNote } from "../member/member.model.js";
import {
  type NextStepGenerator,
  type NextStepInput,
  setNextStepGenerator,
} from "./suggestions.adapter.js";
import { groundNextSteps } from "./suggestions.service.js";
import { TranscriptSegment, VisitSuggestion } from "./visit.model.js";

beforeEach(() => pinClock());
afterEach(() => {
  setNextStepGenerator(undefined);
  vi.useRealTimers();
});

class FakeGenerator implements NextStepGenerator {
  readonly modelId = "us.anthropic.claude-haiku-4-5";
  calls: NextStepInput[] = [];
  constructor(private readonly respond: (input: NextStepInput) => unknown) {}
  generate(input: NextStepInput) {
    this.calls.push(input);
    try {
      return Promise.resolve(this.respond(input));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

async function transcribed() {
  const v = await visitWorld();
  const segments = await TranscriptSegment.create(
    ["Vitamin D came back low.", "Should I take more?", "Let's double the dose and recheck."].map(
      (text, i) => ({
        organizationId: ORG,
        appointmentId: v.id,
        memberId: v.memberRow._id,
        captureIndex: 0,
        sourceSequence: i,
        resultId: `r${i}`,
        speakerLabel: i === 1 ? "spk_1" : "spk_0",
        startedAtMs: i * 1000,
        endedAtMs: i * 1000 + 500,
        spokenAt: new Date(),
        text,
      })
    )
  );
  return { v, ids: segments.map((s) => String(s._id)) };
}
const nextSteps = (id: string) => `/api/v1/appointments/${id}/next-steps`;

it("keeps only valid, grounded items; one bad item never sinks the rest", () => {
  const known = new Set(["a", "b"]);
  const kept = groundNextSteps(
    {
      nextSteps: [
        {
          title: "Order vitamin D",
          detail: "Low today.",
          actionType: "order",
          evidenceSegmentIds: ["a", "zzz"],
        },
        {
          title: "Invented",
          detail: "No evidence.",
          actionType: "book",
          evidenceSegmentIds: ["zzz"],
        },
        { title: "Bad type", detail: "x", actionType: "prescribe", evidenceSegmentIds: ["a"] },
        { title: "", detail: "Empty title", actionType: "review", evidenceSegmentIds: ["b"] },
        "not an object",
        {
          title: "Book review",
          detail: "Quarterly.",
          actionType: "book",
          evidenceSegmentIds: ["b"],
        },
      ],
    },
    known
  );
  expect(kept).toEqual([
    {
      title: "Order vitamin D",
      detail: "Low today.",
      actionType: "order",
      evidenceSegmentIds: ["a"],
    },
    { title: "Book review", detail: "Quarterly.", actionType: "book", evidenceSegmentIds: ["b"] },
  ]);
  expect(groundNextSteps({ nextSteps: "nope" }, known)).toEqual([]);
  expect(groundNextSteps(null, known)).toEqual([]);
});

it("is explicit when Bedrock is unconfigured and when there is no transcript", async () => {
  const v = await visitWorld();
  setNextStepGenerator(null);
  const off = await v.api.post(nextSteps(v.id));
  expect(off.status).toBe(503);
  expect(off.body.code).toBe("SUGGESTIONS_UNCONFIGURED");
  expect((await v.api.get(nextSteps(v.id))).body.data).toMatchObject({
    configured: false,
    items: [],
  });
  setNextStepGenerator(new FakeGenerator(() => ({ nextSteps: [] })));
  const empty = await v.api.post(nextSteps(v.id));
  expect(empty.body.code).toBe("TRANSCRIPT_EMPTY");
});

it("drafts once with server ids from Speaker-labelled segments and writes nothing to the record", async () => {
  const { v, ids } = await transcribed();
  const fake = new FakeGenerator((input) => ({
    nextSteps: [
      {
        id: "model-made-up",
        title: "Order vitamin D",
        detail: "Low on today's draw.",
        actionType: "order",
        evidenceSegmentIds: [ids[0], ids[2]],
      },
      {
        title: "Hallucinated",
        detail: "Nobody said this.",
        actionType: "book",
        evidenceSegmentIds: ["64b000000000000000000000"],
      },
      {
        title: "Recheck in 8 weeks",
        detail: "Confirm the new dose works.",
        actionType: "follow_up",
        evidenceSegmentIds: [input.segments[2]?.segmentId],
      },
    ],
  }));
  setNextStepGenerator(fake);
  const before = {
    notes: await MemberNote.countDocuments(),
    flags: await MemberFlag.countDocuments(),
    lists: await ClinicalList.countDocuments(),
  };
  const res = await v.api.post(nextSteps(v.id));
  expect(res.status).toBe(201);
  expect(fake.calls[0]?.segments.map((s) => s.speaker)).toEqual([
    "Speaker 1",
    "Speaker 2",
    "Speaker 1",
  ]);
  expect(JSON.stringify(fake.calls[0])).not.toMatch(/Test|Actor|@example/); // no staff or member identity
  const items = res.body.data.items;
  expect(items.map((i: { title: string }) => i.title)).toEqual([
    "Order vitamin D",
    "Recheck in 8 weeks",
  ]);
  expect(items.every((i: { status: string }) => i.status === "draft")).toBe(true);
  expect(items[0].id).not.toBe("model-made-up");
  expect(items[0].id).toMatch(/^[a-f\d]{24}$/);
  const again = await v.api.post(nextSteps(v.id));
  expect(again.body.code).toBe("SUGGESTIONS_EXIST");
  expect(fake.calls).toHaveLength(1);
  expect({
    notes: await MemberNote.countDocuments(),
    flags: await MemberFlag.countDocuments(),
    lists: await ClinicalList.countDocuments(),
  }).toEqual(before);
  const rows = await VisitSuggestion.find().lean();
  expect(rows.map((r) => r.promptVersion)).toEqual(["visit-next-steps-v1", "visit-next-steps-v1"]);
  expect(rows[0]?.modelId).toBe("us.anthropic.claude-haiku-4-5");
});

it("a model failure returns 502, logs no provider text and releases the claim for a retry", async () => {
  const { v, ids } = await transcribed();
  let fail = true;
  setNextStepGenerator(
    new FakeGenerator(() => {
      if (fail)
        throw Object.assign(new Error("suggestions_model_error"), {
          providerErrorName: "ThrottlingException",
        });
      return {
        nextSteps: [
          { title: "Retry", detail: "Works.", actionType: "review", evidenceSegmentIds: [ids[0]] },
        ],
      };
    })
  );
  const first = await v.api.post(nextSteps(v.id));
  expect(first.status).toBe(502);
  expect(first.body.code).toBe("SUGGESTIONS_FAILED");
  fail = false;
  const second = await v.api.post(nextSteps(v.id));
  expect(second.status).toBe(201);
  expect(second.body.data.items).toHaveLength(1);
});

it("a clinician accepts (with edits) or rejects each draft exactly once", async () => {
  const { v, ids } = await transcribed();
  setNextStepGenerator(
    new FakeGenerator(() => ({
      nextSteps: [
        {
          title: "Order vitamin D",
          detail: "Low.",
          actionType: "order",
          evidenceSegmentIds: [ids[0]],
        },
        {
          title: "Book review",
          detail: "Quarterly.",
          actionType: "book",
          evidenceSegmentIds: [ids[2]],
        },
      ],
    }))
  );
  const [order, book] = (await v.api.post(nextSteps(v.id))).body.data.items;
  const decide = (sid: string, body: object) =>
    v.api.post(`${nextSteps(v.id)}/${sid}/decision`, body);
  const accepted = await decide(order.id, {
    decision: "accepted",
    detail: "Low; recheck in 8 weeks.",
  });
  expect(accepted.body.data).toMatchObject({
    status: "accepted",
    title: "Order vitamin D",
    detail: "Low; recheck in 8 weeks.",
    edited: true,
    draft: { title: "Order vitamin D", detail: "Low." },
  });
  expect((await decide(book.id, { decision: "rejected", title: "x" })).status).toBe(400);
  expect((await decide(book.id, { decision: "rejected" })).body.data.status).toBe("rejected");
  const twice = await decide(order.id, { decision: "rejected" });
  expect(twice.body.code).toBe("ALREADY_DECIDED");
  expect((await decide("64b000000000000000000000", { decision: "rejected" })).status).toBe(404);
  const list = (await v.api.get(nextSteps(v.id))).body.data;
  expect(list.items.map((i: { status: string }) => i.status)).toEqual(["accepted", "rejected"]);
  expect(list.generated).toBe(true);
  const trail = (
    await AuditEvent.find({ targetType: /VisitSuggestion/ })
      .sort({ _id: 1 })
      .lean()
  ).map((e) => e.action);
  expect(trail).toEqual([
    "suggestions_generated",
    "suggestion_accepted",
    "suggestion_rejected",
    "viewed",
  ]);
});

it("needs CLINICAL_NOTES edit to draft or decide and view to read", async () => {
  const { v, ids } = await transcribed();
  setNextStepGenerator(
    new FakeGenerator(() => ({
      nextSteps: [{ title: "A", detail: "B", actionType: "review", evidenceSegmentIds: [ids[0]] }],
    }))
  );
  const coordinator = as((await staffFixture(false, 3)).accessToken);
  expect((await coordinator.post(nextSteps(v.id))).status).toBe(403);
  const [item] = (await v.api.post(nextSteps(v.id))).body.data.items;
  expect((await coordinator.get(nextSteps(v.id))).status).toBe(200);
  expect(
    (await coordinator.post(`${nextSteps(v.id)}/${item.id}/decision`, { decision: "accepted" }))
      .status
  ).toBe(403);
  const frontDesk = as((await staffFixture(false, 4)).accessToken);
  expect((await frontDesk.get(nextSteps(v.id))).status).toBe(403);
});
