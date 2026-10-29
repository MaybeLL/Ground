import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  JsonWorkspaceStore,
  validateJsonDraft,
  MAX_WORKSPACE_BYTES,
} from "./workspace-json.js";
import { EDITOR_CLIENT } from "./workspace-editor-client.js";
import { renderWorkspaceReading, READING_CSS } from "./contract-page.js";
import { pinnedRuntimeSource } from "./contract-review.js";
import { inlineRuntimeScript } from "./plan-render.js";
import { validateRequirementInput, validateIssueInput } from "./domain.js";
import { acquireRuntimeLease, directoryRegistryRoot } from "./runtime-files.js";

/** Only draft content crosses this boundary; managed publication metadata never does. */
export async function startWorkspaceEditor(
  workspacePath: string,
): ReturnType<typeof startEditor> {
  const release = await acquireRuntimeLease(directoryRegistryRoot(), "data-layout", "shared");
  try {
    const editor = await startEditor(workspacePath);
    editor.server.once("close", release);
    return editor;
  } catch (error) { release(); throw error; }
}

async function startEditor(
  workspacePath: string,
): Promise<{
  url: string;
  version: string;
  source: Record<string, unknown>;
  editable: true;
  server: Server;
  close: () => Promise<void>;
}> {
  const store = new JsonWorkspaceStore(workspacePath);
  const initial = store.read(); // Validate the full local source before listening.
  renderWorkspaceReading(initial);
  const publicSnapshot = (snapshot: ReturnType<JsonWorkspaceStore["read"]>) => {
    const reading = renderWorkspaceReading(snapshot);
    return {
      draft: snapshot.draft,
      reading,
      source: { ...reading.source, workspace_path: workspacePath },
      version: snapshot.version,
      externalIssues: snapshot.manifest.external_issues ?? "",
      conflicts: snapshot.manifest.conflicts ?? [],
      bindings: snapshot.manifest.issues.map((i) => ({
        key: i.key,
        requirementRevision:
          i.desired_requirement_revision_id ??
          i.requirement_revision_id ??
          null,
      })),
      currentRequirementIssueKeys: snapshot.manifest.issues
        .filter((issue) => {
          const binding =
            issue.desired_requirement_revision_id ??
            issue.requirement_revision_id;
          return (
            !binding || binding === snapshot.manifest.requirement.revision_id
          );
        })
        .map((issue) => issue.key),
    };
  };
  const token = randomBytes(32).toString("hex");
  const nonce = randomBytes(18).toString("base64");
  let origin = "";
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      reply(403, { error: "Forbidden origin or host" });
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(editorHtml(nonce));
      return;
    }
    const auth = req.headers.authorization;
    const supplied = Buffer.from(typeof auth === "string" ? auth : "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      reply(401, { error: "Session authorization required" });
      return;
    }
    let saving = false;
    try {
      if (req.method === "GET" && req.url === "/api/draft") {
        reply(200, publicSnapshot(await store.read()));
        return;
      }
      if (
        req.method !== "POST" ||
        !["/api/save", "/api/validate"].includes(req.url ?? "")
      ) {
        reply(404, { error: "Not found" });
        return;
      }
      if (req.headers["content-type"] !== "application/json") {
        reply(415, { error: "Expected application/json" });
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_WORKSPACE_BYTES) {
          reply(413, { error: "Draft is too large" });
          return;
        }
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        Object.keys(body).some((k) => !["draft", "expectedVersion"].includes(k))
      ) {
        reply(400, { error: "Expected draft and expectedVersion only" });
        return;
      }
      validateJsonDraft(body.draft);
      if (req.url === "/api/validate") {
        if (body.draft.requirement)
          validateRequirementInput(body.draft.requirement);
        for (const issue of body.draft.issues) {
          validateIssueInput(issue.input);
          if (issue.questions.length || issue.assumptions.length)
            throw new Error(
              "Resolve Issue questions and assumptions before publishing",
            );
        }
        if (
          body.draft.requirement.open_questions?.some(
            (q: { blocking: boolean }) => q.blocking,
          )
        )
          throw new Error(
            "Resolve blocking Requirement questions before publishing",
          );
        reply(200, {
          valid: true,
          message:
            "Content checks passed. Publication also checks links, baseline and remote state.",
        });
        return;
      }
      // Source availability is checked before attempting a write. The returned
      // reading view and version are built from one complete saved snapshot.
      renderWorkspaceReading({ ...store.read(), draft: body.draft });
      saving = true;
      reply(
        200,
        publicSnapshot(await store.save(body.draft, body.expectedVersion)),
      );
    } catch (error) {
      const e = error as {
        code?: string;
        message?: string;
        details?: unknown;
        commit_state?: string;
      };
      reply(
        e.code === "VERSION_CONFLICT" || e.code === "STATE_CONFLICT"
          ? 409
          : 400,
        {
          error: e.message ?? "Request failed",
          code: e.code,
          details: e.details,
          commit_state:
            e.commit_state ??
            (!saving ||
            ["VALIDATION_ERROR", "VERSION_CONFLICT", "STATE_CONFLICT"].includes(
              e.code ?? "",
            )
              ? "not_committed"
              : "unknown"),
        },
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Editor server has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/#${token}`,
    version: initial.version,
    source: publicSnapshot(initial).source,
    editable: true,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}

/** Same reading components as static export, with one local editing capability. */
export function editorHtml(nonce: string): string {
  const runtime = inlineRuntimeScript(
    pinnedRuntimeSource(),
    "groundslive",
    true,
  ).script.replace("<script>", `<script nonce="${nonce}">`);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grounds 契约草稿</title>
<style nonce="${nonce}">${READING_CSS}
*{box-sizing:border-box}body{margin:0;background:#f4f6fa;color:#182333;font:16px system-ui;overflow-wrap:anywhere}header{padding:16px 24px;background:#fff;border-bottom:1px solid #ccd4df;position:sticky;top:0;z-index:3}h1{font-size:22px;margin:0}button{font:inherit;padding:8px 12px;margin:4px;border:1px solid #aab9ca;border-radius:8px;background:white;cursor:pointer}button:disabled{opacity:.5}button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #16877d}#layout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:24px;padding:24px;max-width:1440px;margin:auto}main,nav,section,article{min-width:0}nav{align-self:start;position:sticky;top:160px;max-height:70vh;overflow:auto}#reading>article{background:white;padding:24px;border-radius:12px;margin-bottom:20px}fieldset{min-width:0;margin:12px 0;padding:12px;border:1px solid #ccd4df;border-radius:8px}legend{font-weight:600}label{display:block;margin:10px 0}textarea,input,select{font:inherit;max-width:100%;padding:8px;border:1px solid #aab7c8;border-radius:5px}textarea{display:block;width:100%;min-height:90px}pre{overflow:auto;max-width:100%;white-space:pre-wrap}#status{display:block;margin:6px 0}#conflict{border:2px solid #bd7500;padding:16px}#editor-actions{display:inline-block}#editor-actions[hidden]{display:none}.edit-block{font-size:14px;float:right}.row{border-left:3px solid #e0e7ef;padding-left:10px}[data-edit-path]{scroll-margin-top:180px;display:flow-root}dialog{max-width:min(90vw,540px);border:1px solid #9aaabb;border-radius:12px}#source{font-size:12px}@media(max-width:700px){#layout{display:block;padding:12px}nav{position:static;max-height:260px;margin-bottom:16px}header{padding:10px}#reading>article{padding:12px}button{font-size:14px}fieldset{padding:8px}}
</style></head><body><header><h1>契约草稿</h1><p>默认阅读，按区块编辑。保存写入本地 JSON；正式发布在对话中确认。</p><span id="status" role="status">正在读取…</span><span id="editor-actions" hidden><button id="save">保存</button><button id="cancel">取消</button></span><button id="validate" disabled>检查内容</button><button id="reload" disabled>重新读取</button></header>
<div id="layout"><nav id="navigation" aria-label="阅读目录"></nav><main><details><summary>查看来源与版本</summary><pre id="source"></pre></details><section id="info"></section><div id="reading"></div><section id="conflict" hidden><h2>保存冲突或结果未知</h2><p>输入仍保留。请复制并核对当前文件，再明确重新读取或重新编辑；不会自动覆盖。</p><button id="copy">复制我的修改</button><h3>我的修改</h3><pre id="mine"></pre><h3>当前磁盘内容</h3><pre id="current"></pre></section></main></div>
<dialog id="switch-dialog"><h2>当前区块有未保存的修改</h2><p>选择保存后继续、放弃后继续，或留在当前区块。放弃包含待提交的引用联动。</p><button id="switch-save">保存后继续</button><button id="switch-discard">放弃后继续</button><button id="switch-stay">继续编辑</button></dialog>
${runtime}<script nonce="${nonce}">${EDITOR_CLIENT.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
