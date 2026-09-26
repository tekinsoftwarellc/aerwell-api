import { AppError } from "../../common/errors/AppError.js";

// Wearables stay in the Alfred store (D14): Aerwell never copies them. The
// Alfred service contract is not configured, so the only adapters are the
// unconfigured default and test fakes; no network call exists in this wave.
export interface WearableDay {
  date: string;
  sleepScore?: number;
  sleepDurationMin?: number;
  hrvMs?: number;
  restingHr?: number;
  activeMinutes?: number;
  steps?: number;
  calories?: number;
  trainingSessions?: number;
}
export interface WearableSeries {
  source: string;
  lastSyncedAt: string | null;
  days: WearableDay[];
}
export interface WearablesAdapter {
  readonly configured: boolean;
  read(query: {
    alfredAccountId: string;
    metric: "sleep" | "activity";
    from: string;
    to: string;
  }): Promise<WearableSeries>;
}
const unconfigured: WearablesAdapter = {
  configured: false,
  read: () =>
    Promise.reject(
      new AppError("Wearables are not configured", 503, true, undefined, "WEARABLES_UNCONFIGURED")
    ),
};
let adapter: WearablesAdapter = unconfigured;
export const getWearablesAdapter = () => adapter;
/** Tests only. */
export function setWearablesAdapter(next: WearablesAdapter | null) {
  adapter = next ?? unconfigured;
}
