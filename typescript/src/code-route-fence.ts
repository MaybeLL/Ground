import { lstatSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Refuse reserved directories even after their owner service has been retired.
 * This is an exclusion check, not a recovery or execution compatibility path.
 * Never infer release from a missing process or remove a caller's marker.
 */
export const codeRouteFencePath = (route: string): string => {
  const path = resolve(route);
  return join(dirname(path), `.${basename(path)}.grounds-route.json`);
};
export const hasCodeRouteFence = (route: string): boolean => lstatSync(codeRouteFencePath(route), { throwIfNoEntry: false }) !== undefined;
export const isWithinCodeRoute = (directory: string): boolean => {
  for (let path = resolve(directory); path !== dirname(path); path = dirname(path)) {
    if (hasCodeRouteFence(path)) return true;
  }
  return false;
};
