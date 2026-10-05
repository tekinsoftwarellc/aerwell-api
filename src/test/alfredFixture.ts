import type { ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import {
  type AlfredModel,
  type AlfredTier,
  type ConverseRequest,
  ModelCallError,
  type ModelTurn,
  setAlfredModel,
} from "../api/alfred/model.adapter.js";
import { StaffMember } from "../api/staff/staff.model.js";
import { bookingWorld } from "./appointmentFixture.js";
import { catalogIds, result } from "./clinicalFixture.js";
import { client, idOf, staffWith } from "./memberFixture.js";
import { app, as } from "./scheduleFixture.js";
import { staffFixture } from "./staffFixture.js";

export const SMART = "us.anthropic.claude-sonnet-5";
export const FAST = "us.anthropic.claude-haiku-4-5";
let useCounter = 0;
type Step = ModelTurn | Error | ((request: ConverseRequest) => ModelTurn);

/**
 * Scripted Bedrock double. It is STRICTER than production on the provider rules
 * we have recorded: Sonnet rejects `outputConfig`, and a toolResult `json` must be
 * an object (never a bare array or scalar). Every request is kept for assertions.
 */
export class ScriptedModel implements AlfredModel {
  readonly requests: ConverseRequest[] = [];
  constructor(
    readonly modelId: string,
    private readonly steps: Step[]
  ) {}
  converse(request: ConverseRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(request));
    if (request.outputConfig && this.modelId.includes("sonnet"))
      return Promise.reject(new ModelCallError("ValidationException"));
    for (const message of request.messages ?? [])
      for (const block of message.content ?? []) {
        const json = (block as { toolResult?: { content?: { json?: unknown }[] } }).toolResult
          ?.content?.[0]?.json;
        if (
          "toolResult" in block &&
          (typeof json !== "object" || json === null || Array.isArray(json))
        )
          return Promise.reject(new ModelCallError("ValidationException"));
      }
    const step = this.steps.shift();
    if (!step) return Promise.reject(new Error("Script exhausted"));
    if (step instanceof Error) return Promise.reject(step);
    return Promise.resolve(typeof step === "function" ? step(request) : step);
  }
  /** Every toolResult json the model was sent, in order. */
  toolResults(): Record<string, unknown>[] {
    const last = this.requests.at(-1);
    return (last?.messages ?? []).flatMap((m) =>
      (m.content ?? []).flatMap((b) => {
        const r = (b as { toolResult?: { content?: { json?: Record<string, unknown> }[] } })
          .toolResult;
        return r ? [r.content?.[0]?.json ?? {}] : [];
      })
    );
  }
}
const usage = { inputTokens: 120, outputTokens: 30 };
export const toolTurn = (
  ...uses: { name: string; input: Record<string, unknown> }[]
): ModelTurn => ({
  stopReason: "tool_use",
  content: uses.map((u) => {
    useCounter += 1;
    return {
      toolUse: { toolUseId: `tooluse-${useCounter}`, name: u.name, input: u.input },
    } as ContentBlock;
  }),
  usage,
  latencyMs: 7,
});
export const textTurn = (text: string): ModelTurn => ({
  stopReason: "end_turn",
  content: [{ text }],
  usage,
  latencyMs: 5,
});
export function useModel(tier: AlfredTier, steps: Step[]) {
  const model = new ScriptedModel(tier === "smart" ? SMART : FAST, steps);
  setAlfredModel(tier, model);
  return model;
}
export function resetModels() {
  setAlfredModel("smart", undefined);
  setAlfredModel("fast", undefined);
}

export const LAB_SENTINEL = 4.87;
/**
 * Booking world plus a named member with a lab panel and a protocol, and four
 * staff: the medical director (clinical master), front desk (no clinical),
 * an own-scope nurse not assigned to the member, and a role with nothing.
 */
export async function alfredWorld() {
  const w = await bookingWorld();
  const ids = await catalogIds();
  const shannon = await w.member(["aerwell-essential"], {
    firstName: "Shannon",
    lastName: "Ashton",
  });
  const director = client(app, w.director.accessToken);
  const base = `/members/${idOf(shannon)}`;
  const panel = await director.send("post", `${base}/lab-panels`, {
    drawnAt: "2027-02-20T16:00:00Z",
    results: [result(ids["tsh"], LAB_SENTINEL)],
  });
  const protocol = await director.send("post", `${base}/protocols`, {
    type: "Peptide Protocol",
    name: "Synthetic protocol",
    prescribingProviderId: String(w.provider.staff._id),
    startDate: "2027-02-01",
    estEndDate: "2027-04-01",
    items: [
      {
        compound: "BPC-157",
        doseAmount: 250,
        doseUnit: "mcg",
        frequencyCount: 2,
        frequencyPeriod: "weekly",
        route: "subcutaneous",
      },
    ],
  });
  if (panel.status !== 201 || protocol.status !== 201) throw new Error("World setup failed");
  const frontDesk = await staffFixture(false, 4);
  const nurseOwn = await staffWith(
    {
      MEMBER_RECORDS: "edit",
      CLINICAL_NOTES: "edit",
      LABS_SCANS: "edit",
      PROTOCOLS: "edit",
      APPOINTMENTS: "edit",
      STAFF_RECORDS: "view",
      SERVICES: "view",
    },
    "own"
  );
  const nobody = await staffWith({});
  return {
    ...w,
    shannon,
    memberId: idOf(shannon),
    panelId: String(panel.body.data._id),
    protocolId: String(protocol.body.data._id),
    frontDesk,
    nurseOwn,
    nobody,
    http: (token: string) => as(token),
  };
}
export const loadStaff = async (id: unknown) => {
  const staff = await StaffMember.findById(id);
  if (!staff) throw new Error("No staff");
  return staff;
};
