import { EventEmitter } from "node:events";

/**
 * In-process signals that must stop a live capture at once. Sockets also
 * re-check the database on every heartbeat, which is the fallback.
 * ponytail: single process; with several API instances the other instances
 * only learn on their next heartbeat (<= heartbeat interval). Use a shared
 * pub/sub if the API is ever scaled out.
 */
export type VisitSignal = "consent_revoked" | "visit_ended";
const bus = new EventEmitter();
bus.setMaxListeners(0);

export const emitVisitSignal = (appointmentId: string, signal: VisitSignal) =>
  bus.emit("signal", appointmentId, signal);
export function onVisitSignal(listener: (appointmentId: string, signal: VisitSignal) => void) {
  bus.on("signal", listener);
  return () => bus.off("signal", listener);
}
