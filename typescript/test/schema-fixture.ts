import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const contracts = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/contracts/v1");
const readSchema = (name: string): object => JSON.parse(readFileSync(resolve(contracts, name), "utf8")) as object;
const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
for (const name of readdirSync(contracts).filter((entry) => entry.endsWith(".schema.json"))) ajv.addSchema(readSchema(name));

const validators = new Map<string, ValidateFunction>();

export const assertContract = (schemaName: string, value: unknown): void => {
  let validate = validators.get(schemaName);
  if (!validate) {
    const [file = schemaName, fragment] = schemaName.split("#");
    validate = ajv.getSchema(`${(readSchema(file) as { $id: string }).$id}${fragment === undefined ? "" : `#${fragment}`}`);
    if (!validate) throw new Error(`schema is not registered: ${schemaName}`);
    validators.set(schemaName, validate);
  }
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
};
