import { afterEach, expect, it, vi } from "vitest";
import { env } from "../../config/env.js";
import { readAlfredHealthIntake } from "./healthIntake.client.js";
vi.mock("../../common/services/serviceTokenClient.js", () => ({
  ALFRED_TIMEOUT_MS: 5000,
  getServiceToken: vi.fn(async () => "token"),
}));
const saved = env.ALFRED_API_INTERNAL_URL;
afterEach(() => {
  env.ALFRED_API_INTERNAL_URL = saved;
  vi.unstubAllGlobals();
});
it("filters unexpected upstream detail for ordinary staff and withdrawn authorization", async () => {
  env.ALFRED_API_INTERNAL_URL = "https://alfred.test";
  for (const [detail, state, restricted, visible] of [
    [false, "authorized", false, false],
    [true, "withdrawn", false, false],
    [true, "not_authorized", false, false],
    [true, "authorized", false, true],
    [true, "authorized", true, false],
  ] as const) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                intake: {
                  status: "completed",
                  authorization: { state },
                  detailsRestricted: restricted,
                  questions: [{ value: "private sentinel" }],
                  review: { value: "private sentinel" },
                  progress: {
                    total: 1,
                    answered: 1,
                    skipped: 0,
                    remaining: 0,
                    value: "private sentinel",
                  },
                },
              },
            })
          )
      )
    );
    const result = await readAlfredHealthIntake("account", "staff", detail);
    expect(JSON.stringify(result).includes("private sentinel")).toBe(visible);
  }
});
