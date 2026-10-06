import { Location } from "../location/location.model.js";

/** What only the client can supply (Q12): terms, support, the cancellation summary and street addresses. */
export interface ClientManifestValues {
  baseUrl?: string;
  displayName?: string;
  terms: { url: string; version: string; summary: string };
  cancellationPolicy: { summary: string; url?: string; lateFeeCents?: number };
  support: { email: string; url?: string };
  /** Structured street address per `Location._id`: the Location model keeps one free-text line. */
  addresses: Record<
    string,
    {
      line1: string;
      line2?: string;
      city: string;
      region: string;
      postalCode: string;
      country: string;
    }
  >;
}

type LocationRow = {
  _id: unknown;
  name: string;
  timeZone?: string | null;
  geo?: { type?: string | null; coordinates: number[] } | null;
  businessHours: { weekday: number; open: string; close: string; closed?: boolean | null }[];
};

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const DEFAULT_BASE_URL = "https://api-aerwell.tekinsoftware.com";
/** Alfred refuses a manifest holding this placeholder text (manifestValidator). */
const PLACEHOLDER = /change me/i;

const hoursOf = (row: LocationRow) =>
  Object.fromEntries(
    row.businessHours.map((h) => [
      DAYS[h.weekday],
      h.closed ? [] : [{ open: h.open, close: h.close }],
    ])
  );

/**
 * The manifest Alfred registers (contract §3). Fails loudly when a bookable location has no
 * coordinates or street address: a silently omitted location would hide that clinic from Alfred,
 * and every slot at it would arrive without a timezone.
 */
export function buildManifest(locations: LocationRow[], client: ClientManifestValues) {
  const incomplete = locations.flatMap((row) => {
    const missing = [
      ...(row.geo?.coordinates.length === 2 ? [] : ["geo"]),
      ...(client.addresses[String(row._id)] ? [] : ["address"]),
    ];
    return missing.length ? [`${row.name} (${String(row._id)}): ${missing.join(", ")}`] : [];
  });
  if (incomplete.length)
    throw new Error(`Locations missing manifest data: ${incomplete.join("; ")}`);
  const manifest = {
    contractVersion: 1,
    baseUrl: client.baseUrl ?? DEFAULT_BASE_URL,
    audience: "partner-aerwell",
    displayName: client.displayName ?? "Aerwell",
    capabilities: ["services"],
    locations: locations.map((row) => ({
      ref: String(row._id),
      name: row.name,
      address: client.addresses[String(row._id)],
      geo: { type: "Point", coordinates: row.geo?.coordinates },
      timezone: row.timeZone ?? "America/Los_Angeles",
      hours: hoursOf(row),
    })),
    terms: client.terms,
    cancellationPolicy: { ...client.cancellationPolicy, windowHours: 24 },
    support: client.support,
    membershipRequiredByDefault: false,
  };
  if (PLACEHOLDER.test(JSON.stringify(manifest)))
    throw new Error("The manifest still holds placeholder text (CHANGE ME)");
  return manifest;
}

export async function manifestFor(organizationId: string, client: ClientManifestValues) {
  return buildManifest(await Location.find({ organizationId }).sort({ name: 1 }).lean(), client);
}
