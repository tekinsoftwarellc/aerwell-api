import { env } from "../../config/env.js";

/** Kill switch: unset means on everywhere except production, which must opt in. */
export const partnerContractEnabled = (): boolean =>
  env.PARTNER_CONTRACT_ENABLED
    ? env.PARTNER_CONTRACT_ENABLED === "true"
    : env.NODE_ENV !== "production";

/** On unless switched off; with no switch it follows the contract and needs Alfred's address and credentials. */
export const partnerOutboxEnabled = (): boolean =>
  env.PARTNER_OUTBOX_ENABLED
    ? env.PARTNER_OUTBOX_ENABLED === "true"
    : partnerContractEnabled() &&
      Boolean(env.ALFRED_API_URL && env.ALFRED_AUTH_URL && env.ALFRED_AUTH_CLIENT_ID);
