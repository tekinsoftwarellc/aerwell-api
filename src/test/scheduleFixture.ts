import request from "supertest";
import { Location } from "../api/location/location.model.js";
import { StaffMember } from "../api/staff/staff.model.js";
import { createServer } from "../server.js";
import { staffFixture } from "./staffFixture.js";

export const app = createServer();
export const LA = "America/Los_Angeles";

/** Bearer-authenticated supertest helpers for one staff session. */
export function as(token: string) {
  const auth = { type: "bearer" } as const;
  return {
    get: (path: string) => request(app).get(path).auth(token, auth),
    post: (path: string, body: object = {}) => request(app).post(path).auth(token, auth).send(body),
    patch: (path: string, body: object) => request(app).patch(path).auth(token, auth).send(body),
    put: (path: string, body: object) => request(app).put(path).auth(token, auth).send(body),
    delete: (path: string) => request(app).delete(path).auth(token, auth),
  };
}

/** Director (STAFF_RECORDS master, not super admin) plus a nurse (STAFF_RECORDS view). */
export async function scheduleFixture() {
  const director = await staffFixture(false, 0);
  const nurse = await staffFixture(false, 2);
  await StaffMember.updateOne({ _id: nurse.staff._id }, { firstName: "Theresa", lastName: "West" });
  const location = await Location.create({
    organizationId: "org-test",
    name: `Clinic ${Math.random()}`,
    timeZone: LA,
  });
  const shift = {
    staffId: String(nurse.staff._id),
    positionRoleId: String(nurse.role._id),
    locationId: String(location._id),
    date: "2027-03-10",
    startTime: "08:00",
    endTime: "12:00",
  };
  return { director, nurse, location, shift, boss: as(director.accessToken) };
}

export async function grant(staffId: unknown, level: string, scope: "all" | "own") {
  await StaffMember.updateOne(
    { _id: staffId },
    { $set: { permissionOverrides: [{ module: "STAFF_RECORDS", level, scope }] } }
  );
}
