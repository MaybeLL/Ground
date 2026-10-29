import type { VerificationSummaryItem } from "./store-types.js";

// The old unversioned cursor used text ordering and cannot safely resume under
// nanosecond ordering. Keep the marker inside the opaque payload.
export const VERIFICATION_CURSOR_PREFIX = "v2\0";
export const encodeVerificationCursor = (summary: Pick<VerificationSummaryItem, "created_at" | "id">): string =>
  Buffer.from(`${VERIFICATION_CURSOR_PREFIX}${summary.created_at}\0${summary.id}`, "utf8").toString("base64url");
