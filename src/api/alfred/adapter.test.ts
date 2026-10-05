import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, expect, it } from "vitest";
import { env, envSchema } from "../../config/env.js";
import { client, idOf, memberRow, staffWith } from "../../test/memberFixture.js";
import { app } from "../../test/scheduleFixture.js";
import { staffFixture } from "../../test/staffFixture.js";
import { SupplementOrder, seedSupplementCatalog } from "../supplement/supplement.js";
import {
  BedrockAlfredModel,
  ModelCallError,
  getAlfredModel,
  setAlfredModel,
} from "./model.adapter.js";

afterEach(() => {
  env.BEDROCK_REGION = undefined;
  env.BEDROCK_MODEL_FAST = undefined;
  env.BEDROCK_MODEL_SMART = undefined;
  setAlfredModel("fast", undefined);
  setAlfredModel("smart", undefined);
});

it("sends the configured model id and maps the Converse response", async () => {
  const sent: ConverseCommand[] = [];
  const model = new BedrockAlfredModel(
    {
      send: (command) => {
        sent.push(command);
        return Promise.resolve({
          stopReason: "tool_use",
          output: {
            message: { content: [{ toolUse: { toolUseId: "t1", name: "x", input: {} } }] },
          },
          usage: { inputTokens: 11, outputTokens: 3 },
          metrics: { latencyMs: 42 },
        });
      },
    },
    "us.anthropic.claude-sonnet-5"
  );
  const turn = await model.converse({ messages: [{ role: "user", content: [{ text: "hi" }] }] });
  expect(sent[0]).toBeInstanceOf(ConverseCommand);
  expect(sent[0]?.input.modelId).toBe("us.anthropic.claude-sonnet-5");
  expect(turn).toEqual({
    stopReason: "tool_use",
    content: [{ toolUse: { toolUseId: "t1", name: "x", input: {} } }],
    usage: { inputTokens: 11, outputTokens: 3 },
    latencyMs: 42,
  });
});

it("keeps only the provider error NAME, never its message", async () => {
  const leaky = Object.assign(new Error("arn:aws:iam::123:user/other-app is not authorized"), {
    name: "AccessDeniedException",
  });
  const model = new BedrockAlfredModel({ send: () => Promise.reject(leaky) }, "us.x");
  const error = await model.converse({ messages: [] }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ModelCallError);
  expect((error as ModelCallError).providerErrorName).toBe("AccessDeniedException");
  expect(JSON.stringify(error) + String((error as Error).message)).not.toContain("arn:aws");
});

it("is unconfigured per tier until region and that tier's us. profile are set", () => {
  expect(getAlfredModel("smart")).toBeNull();
  env.BEDROCK_REGION = "us-east-1";
  expect(getAlfredModel("smart")).toBeNull();
  env.BEDROCK_MODEL_SMART = "us.anthropic.claude-sonnet-5";
  expect(getAlfredModel("smart")?.modelId).toBe("us.anthropic.claude-sonnet-5");
  expect(getAlfredModel("fast")).toBeNull();
  const base = { MONGODB_URI: "mongodb://x" };
  expect(
    envSchema.safeParse({ ...base, BEDROCK_MODEL_SMART: "anthropic.claude-sonnet-5" }).success
  ).toBe(false);
  expect(
    envSchema.safeParse({ ...base, BEDROCK_MODEL_SMART: "us.anthropic.claude-sonnet-5" }).success
  ).toBe(true);
});

it("supplement catalog and draft orders are PROTOCOLS-guarded, scoped, audited and never placed", async () => {
  await seedSupplementCatalog("org-test");
  await seedSupplementCatalog("org-test");
  const admin = client(app, (await staffFixture(true)).accessToken);
  const products = (await admin.get("/supplement-products")).body.data.items;
  expect(products).toHaveLength(4);
  const member = await memberRow();
  const body = {
    productId: products[0]._id,
    directions: "Daily",
    durationDays: 30,
    qty: 1,
    fulfillment: "pickup",
  };
  const created = await admin.send("post", `/members/${idOf(member)}/supplement-orders`, body);
  expect(created.status).toBe(201);
  expect(created.body.data.status).toBe("draft");
  expect(
    (
      await admin.send("post", `/members/${idOf(member)}/supplement-orders`, {
        ...body,
        status: "placed",
      })
    ).status
  ).toBe(400);
  const list = await admin.get(`/members/${idOf(member)}/supplement-orders`);
  expect(list.body.data).toMatchObject({
    fulfilment: "unconfigured",
    items: [{ status: "draft" }],
  });
  const frontDesk = client(app, (await staffFixture(false, 4)).accessToken);
  expect((await frontDesk.get(`/members/${idOf(member)}/supplement-orders`)).status).toBe(403);
  const own = client(
    app,
    (await staffWith({ MEMBER_RECORDS: "edit", PROTOCOLS: "edit" }, "own")).accessToken
  );
  expect((await own.send("post", `/members/${idOf(member)}/supplement-orders`, body)).status).toBe(
    404
  );
  expect(
    (
      await admin.send("post", `/members/${idOf(member)}/supplement-orders`, {
        ...body,
        productId: idOf(member),
      })
    ).body.code
  ).toBe("PRODUCT_NOT_FOUND");
  expect(await SupplementOrder.countDocuments()).toBe(1);
});
