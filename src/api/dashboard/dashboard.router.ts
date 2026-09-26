import { Router } from "express";
import { z } from "zod";
import { secured } from "../../common/http.js";
import { date } from "../schedule/schedule.schema.js";
import { agenda, outlook, summary } from "./dashboard.service.js";

// Any signed-in staff member; every widget checks its own module permission.
export const dashboardRouter = Router();
const query = z.object({ date: date.optional() }).strict();
secured(dashboardRouter, "get", "/dashboard/summary", null, { query }, summary);
secured(dashboardRouter, "get", "/dashboard/agenda", null, { query }, agenda);
secured(dashboardRouter, "get", "/dashboard/outlook", null, { query }, outlook);
