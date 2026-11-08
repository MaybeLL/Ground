import type { DeliveryItem, Id, ReceiptCheck, Timestamp } from "../domain/index.js";

export interface Clock { now(): Timestamp }
/** Fresh identifiers: run, work and session identities are issued here, never invented by callers. */
export interface IdSource { next(): Id }

/**
 * Looks at the archived deliveries a manifest names before it is frozen: are
 * they there, and do they match what was recorded? A manifest is only accepted
 * when every item is accepted; an unreachable archive is `unavailable`, not a
 * verdict on the work.
 */
export interface DeliveryReceiptPort {
  check(items: readonly DeliveryItem[]): Promise<ReceiptCheck>;
}
