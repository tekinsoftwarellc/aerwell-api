import { Router } from "express";
import { z } from "zod";
import { idParams, objectId, secured } from "../../common/http.js";
import {
  billingConfig,
  createSetupIntent,
  getPaymentMethod,
  invoicePdf,
  listInvoices,
  putPaymentMethod,
} from "../billing/billing.service.js";
import {
  addressSchema,
  benefitsQuery,
  bulkArchive,
  flagCreate,
  flagParams,
  flagQuery,
  memberCreate,
  memberPatch,
  memberQuery,
  membershipCreate,
  membershipParams,
  membershipPatch,
  noteCreate,
  notesRead,
  searchQuery,
  viewParams,
  viewPut,
} from "./member.schema.js";
import {
  archiveMembers,
  createMember,
  listMembers,
  memberOverview,
  memberProfile,
  searchMembers,
  updateMember,
} from "./member.service.js";
import {
  createFlag,
  createNote,
  getViewPreference,
  listFlags,
  listNotes,
  markNotesRead,
  putViewPreference,
  resolveFlag,
} from "./memberRecords.service.js";
import {
  createMembership,
  listMemberships,
  memberBenefits,
  patchMembership,
} from "./membership.service.js";

export const memberRouter = Router();
const records = (level: "view" | "edit" | "master") =>
  ({ module: "MEMBER_RECORDS", level }) as const;
const notes = (level: "view" | "edit") => ({ module: "CLINICAL_NOTES", level }) as const;
const billing = (level: "view" | "edit") => ({ module: "BILLING", level }) as const;
const r = memberRouter;

// Static paths before /members/:id.
secured(r, "get", "/members", records("view"), { query: memberQuery }, listMembers);
secured(r, "post", "/members", records("edit"), { body: memberCreate }, createMember, 201);
secured(r, "get", "/members/search", records("view"), { query: searchQuery }, searchMembers);
secured(
  r,
  "post",
  "/members/bulk/archive",
  records("master"),
  { body: bulkArchive },
  archiveMembers
);
secured(r, "get", "/members/:id", records("view"), { params: idParams }, memberProfile);
secured(
  r,
  "patch",
  "/members/:id",
  records("edit"),
  { params: idParams, body: memberPatch },
  updateMember
);
secured(r, "get", "/members/:id/overview", records("view"), { params: idParams }, memberOverview);

secured(
  r,
  "get",
  "/members/:id/flags",
  records("view"),
  { params: idParams, query: flagQuery },
  listFlags
);
secured(
  r,
  "post",
  "/members/:id/flags",
  records("edit"),
  { params: idParams, body: flagCreate },
  createFlag,
  201
);
secured(
  r,
  "post",
  "/members/:id/flags/:flagId/resolve",
  records("edit"),
  { params: flagParams },
  resolveFlag
);

secured(r, "get", "/members/:id/notes", notes("view"), { params: idParams }, listNotes);
secured(
  r,
  "post",
  "/members/:id/notes",
  notes("edit"),
  { params: idParams, body: noteCreate },
  createNote,
  201
);
secured(
  r,
  "post",
  "/members/:id/notes/read",
  notes("view"),
  { params: idParams, body: notesRead },
  markNotesRead
);

secured(
  r,
  "get",
  "/members/:id/memberships",
  records("view"),
  { params: idParams },
  listMemberships
);
secured(
  r,
  "post",
  "/members/:id/memberships",
  records("edit"),
  { params: idParams, body: membershipCreate },
  createMembership,
  201
);
secured(
  r,
  "patch",
  "/members/:id/memberships/:membershipId",
  records("edit"),
  { params: membershipParams, body: membershipPatch },
  patchMembership
);
secured(
  r,
  "get",
  "/members/:id/benefits",
  records("view"),
  { params: idParams, query: benefitsQuery },
  memberBenefits
);

secured(r, "get", "/billing/config", billing("view"), {}, async () => billingConfig());
secured(
  r,
  "get",
  "/members/:id/payment-method",
  billing("view"),
  { params: idParams },
  getPaymentMethod
);
secured(
  r,
  "put",
  "/members/:id/payment-method",
  billing("edit"),
  {
    params: idParams,
    body: z
      .object({
        processorPaymentMethodId: z
          .string()
          .regex(/^pm_[A-Za-z0-9_]{1,200}$/, "Use a Stripe payment method id"),
        nameOnCard: z.string().trim().min(1).max(200),
        billingAddress: addressSchema.optional(),
      })
      .strict(),
  },
  putPaymentMethod
);
secured(
  r,
  "post",
  "/members/:id/payment-method/setup-intent",
  billing("edit"),
  { params: idParams },
  createSetupIntent
);
secured(
  r,
  "get",
  "/members/:id/invoices",
  billing("view"),
  {
    params: idParams,
    query: z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict(),
  },
  listInvoices
);
secured(
  r,
  "get",
  "/invoices/:id/pdf",
  billing("view"),
  { params: z.object({ id: objectId }).strict() },
  invoicePdf
);

// Personal UI preference: any signed-in staff member, no module permission.
secured(r, "get", "/me/view-preferences/:context", null, { params: viewParams }, getViewPreference);
secured(
  r,
  "put",
  "/me/view-preferences/:context",
  null,
  { params: viewParams, body: viewPut },
  putViewPreference
);
