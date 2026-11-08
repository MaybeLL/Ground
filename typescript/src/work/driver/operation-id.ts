import {createHash} from "node:crypto";

export const operation = (...keys:string[]) => {
  const hash = createHash("sha256").update(JSON.stringify(keys)).digest("hex");
  return [hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20,32)].join("-");
};
