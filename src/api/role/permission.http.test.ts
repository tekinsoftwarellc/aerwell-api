import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../common/middleware/errorHandler.js";
import { requirePermission } from "../../common/middleware/permission.js";
import { StaffMember } from "../staff/staff.model.js";
import { MODULES, seedRoles } from "./permission.js";
import type { PermissionLevel } from "./permission.types.js";
import { Role } from "./role.model.js";
const expectedRanks = [
  [3, 3, 3, 3, 1, 3, 3, 3, 3],
  [2, 2, 2, 2, 0, 1, 0, 1, 2],
  [2, 2, 2, 1, 0, 1, 0, 1, 2],
  [2, 1, 1, 1, 1, 1, 0, 1, 3],
  [1, 0, 0, 0, 1, 1, 0, 1, 2],
];
function mountPermissionRoutes(app: express.Express) {
  for (const module of MODULES) {
    for (const level of ["view", "edit", "master"] as PermissionLevel[])
      app.get(`/${module}/${level}`, requirePermission(module, level), (req, res) =>
        res.json(req.permission)
      );
  }
  app.use(errorHandler);
}
describe("permission middleware HTTP matrix", () => {
  it.each(seedRoles.map((role, index) => ({ role, index })))(
    "$role.name enforces all nine modules at every level",
    async ({ role, index }) => {
      const saved = await Role.create({ ...role, organizationId: "org-http" });
      const staff = await StaffMember.create({
        organizationId: "org-http",
        authAccountId: "account-http",
        firstName: "Test",
        lastName: "Actor",
        email: "actor@example.invalid",
        roleId: saved._id,
      });
      const app = express();
      app.use((req, _res, next) => {
        req.staff = staff;
        next();
      });
      mountPermissionRoutes(app);
      const server = app.listen(0);
      try {
        for (const [moduleIndex, module] of MODULES.entries()) {
          for (const [i, level] of ["view", "edit", "master"].entries()) {
            const allowed = (expectedRanks[index]?.[moduleIndex] ?? -1) >= i + 1;
            const response = await request(server)
              .get(`/${module}/${level}`)
              .set("Connection", "close");
            expect(response.status, `${role.name} ${module} ${level}`).toBe(allowed ? 200 : 403);
            if (!allowed) expect(response.body.code).toBe("FORBIDDEN");
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    }
  );
  it("denies missing actor before calling protected handlers", async () => {
    const app = express();
    app.get("/", requirePermission("STAFF_RECORDS", "view"), (_req, res) => res.sendStatus(200));
    app.use(errorHandler);
    expect((await request(app).get("/")).status).toBe(401);
  });
});
