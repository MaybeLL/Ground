import { isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Node } from "yaml";
import { DomainError, validation } from "./errors.js";

/**
 * Parse the deliberately small YAML dialect accepted by Grounds.
 *
 * We inspect the YAML node graph before converting it to JavaScript.  Doing
 * this after `toJS()` is too late: aliases and merge keys have already been
 * resolved, custom tags have been discarded, and a recursive alias can make
 * a post-conversion walk overflow the stack.
 */
export const parseSafeYAML = (data: Buffer, field = "file", options: { allowNulls?: boolean } = {}): Document<Node> => {
  if (data.length > 2 * 1024 * 1024) throw validation(field, "must not exceed 2 MiB");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw validation(field, "must contain valid UTF-8");
  }
  let document: Document<Node>;
  try {
    document = parseDocument(text, { uniqueKeys: true, prettyErrors: true });
  } catch (error) {
    throw validation(field, error instanceof Error ? error.message : String(error));
  }
  if (document.errors.length > 0) throw validation(field, document.errors[0].message);
  if (!document.contents) throw validation(field, "must contain one YAML document");

  const visit = (node: Node | null | undefined, path: string): void => {
    if (!node) throw validation(path, "must not be empty");
    const candidate = node as Node & { tag?: string; anchor?: string; items?: unknown[]; value?: unknown };
    if (isAlias(node)) throw validation(path, "YAML aliases are not supported");
    if (candidate.anchor) throw validation(path, "YAML anchors are not supported");
    if (candidate.tag && !["tag:yaml.org,2002:map", "tag:yaml.org,2002:seq", "tag:yaml.org,2002:str", "tag:yaml.org,2002:int", "tag:yaml.org,2002:bool"].includes(candidate.tag)) throw validation(path, "custom YAML tags are not supported");
    if (isMap(node)) {
      for (const [index, item] of (candidate.items ?? []).entries()) {
        const pair = item as { key?: Node; value?: Node };
        const key = pair.key as Node & { value?: unknown } | undefined;
        if (!key || isAlias(key) || !isScalar(key) || typeof key.value !== "string") throw validation(`${path}.key[${index}]`, "mapping keys must be strings");
        if (key.value === "<<") throw validation(`${path}.${key.value}`, "YAML merge keys are not supported");
        visit(pair.key, `${path}.${key.value}`);
        visit(pair.value, `${path}.${key.value}`);
      }
      return;
    }
    if (isSeq(node)) {
      for (const [index, item] of (candidate.items ?? []).entries()) visit(item as Node, `${path}[${index}]`);
      return;
    }
    // Null is rejected by default: the input model treats an explicit null as
    // illegal and expresses optional fields by omission.  Callers whose contract
    // declares a nullable field opt in with `allowNulls`, because a value already
    // stored as null must still round-trip when it is submitted back.
    if (candidate.value === null && !options.allowNulls) throw validation(path, "YAML null is not supported; omit optional fields instead");
  };
  visit(document.contents as Node, field);
  return document;
};

export const safeYAMLToJS = <T>(data: Buffer, field = "file", options: { allowNulls?: boolean } = {}): T => {
  try {
    return parseSafeYAML(data, field, options).toJS({ mapAsMap: false }) as T;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw validation(field, error instanceof Error ? error.message : String(error));
  }
};
