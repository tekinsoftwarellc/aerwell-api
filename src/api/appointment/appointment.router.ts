import { Router } from "express";
import { idParams, secured } from "../../common/http.js";
import {
  availabilityQuery,
  bookBody,
  cancelBody,
  episodeBody,
  episodeCancelBody,
  listQuery,
  memberAppointmentsQuery,
  quoteBody,
  rescheduleBody,
  statusBody,
  summaryQuery,
} from "./appointment.schema.js";
import {
  appointmentDetail,
  appointmentSummary,
  listAppointments,
  memberAppointments,
} from "./appointment.service.js";
import { availability } from "./availability.service.js";
import { bookAppointment, rescheduleAppointment } from "./booking.service.js";
import { cancelEpisode, createEpisode, getEpisode, memberEpisodes } from "./episode.service.js";
import { cancelAppointment, changeStatus } from "./lifecycle.service.js";
import { quote } from "./quote.service.js";

export const appointmentRouter = Router();
const appts = (level: "view" | "edit") => ({ module: "APPOINTMENTS", level }) as const;
const r = appointmentRouter;

// Static paths before /appointments/:id.
secured(r, "get", "/appointments", appts("view"), { query: listQuery }, listAppointments);
secured(
  r,
  "get",
  "/appointments/summary",
  appts("view"),
  { query: summaryQuery },
  appointmentSummary
);
secured(r, "post", "/appointments/quote", appts("view"), { body: quoteBody }, quote);
secured(r, "post", "/appointments", appts("edit"), { body: bookBody }, bookAppointment, 201);
secured(r, "get", "/availability", appts("view"), { query: availabilityQuery }, availability);
secured(r, "get", "/appointments/:id", appts("view"), { params: idParams }, appointmentDetail);
secured(
  r,
  "post",
  "/appointments/:id/reschedule",
  appts("edit"),
  { params: idParams, body: rescheduleBody },
  rescheduleAppointment
);
secured(
  r,
  "post",
  "/appointments/:id/cancel",
  appts("edit"),
  { params: idParams, body: cancelBody },
  cancelAppointment
);
secured(
  r,
  "patch",
  "/appointments/:id/status",
  appts("edit"),
  { params: idParams, body: statusBody },
  changeStatus
);
secured(
  r,
  "get",
  "/members/:id/appointments",
  appts("view"),
  { params: idParams, query: memberAppointmentsQuery },
  memberAppointments
);
secured(
  r,
  "post",
  "/assessment-episodes",
  appts("edit"),
  { body: episodeBody },
  createEpisode,
  201
);
secured(r, "get", "/assessment-episodes/:id", appts("view"), { params: idParams }, getEpisode);
secured(
  r,
  "post",
  "/assessment-episodes/:id/cancel",
  appts("edit"),
  { params: idParams, body: episodeCancelBody },
  cancelEpisode
);
secured(
  r,
  "get",
  "/members/:id/assessment-episodes",
  appts("view"),
  { params: idParams },
  memberEpisodes
);
