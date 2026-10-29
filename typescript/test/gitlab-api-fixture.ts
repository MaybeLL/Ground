import { createServer } from "node:http";
import { once } from "node:events";

export const defaultTagRules = () => ["grounds/candidates/*", "grounds/deliveries/*"].map(name => ({ name, create_access_levels: [{ access_level: 30, access_level_description: "Developers + Maintainers" }] }));
export interface APIFixtureProject { id: number; path: string; rules: unknown[]; roles: Record<string, number>; shared?: unknown[]; archived?: boolean }
/** An actual HTTP boundary. The transcript stores requests/responses, never
 * Authorization headers. Everything is local, task-owned and disposable. */
export async function gitLabAPIFixture() {
  const projects = new Map<string, APIFixtureProject>();
  projects.set("team/repo", { id: 101, path: "team/repo", rules: defaultTagRules(), roles: { developer: 30, maintainer: 40, reporter: 20 } });
  const transcript: { method: string; path: string; actor: string; status: number; response: unknown; authentication: string; private_token_present: boolean }[] = [];
  const failures = new Map<string, { status?: number; body?: unknown; delay?: number; headers?: Record<string, string> }>();
  const state = { version: "14.10.5-ee", groups: new Map<string, unknown>(), afterRules: undefined as (() => void) | undefined, publicInstance: undefined as string | undefined, requireBearer: false };
  let instance = "";
  const server = createServer(async (req, res) => {
    const path = req.url!.replace(/^\/api\/v4/, "");
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const credential = bearer ?? (state.requireBearer ? undefined : req.headers["private-token"]);
    const actor = String(credential ?? "").replace(/^fixture-/, "");
    const authentication = bearer ? "bearer" : req.headers["private-token"] ? "private-token" : "missing";
    let status = 200, body: unknown;
    const failure = failures.get(path) ?? failures.get(path.split("?")[0]!);
    if (failure?.delay) await new Promise(resolve => setTimeout(resolve, failure.delay));
    if (failure) { status = failure.status ?? 200; body = failure.body ?? { message: "task fixture error" }; }
    else if (!["developer", "maintainer", "reporter"].includes(actor)) { status = 401; body = { message: "invalid fixture credential" }; }
    else if (path === "/version") body = { version: state.version, revision: "fixture" };
    else if (path === "/user") body = { id: actor === "developer" ? 11 : actor === "maintainer" ? 12 : 13, username: actor, state: "active" };
    else if (path.startsWith("/groups/")) { body = state.groups.get(path); if (!body) { status = 404; body = { message: "Not found" }; } }
    else if (path.startsWith("/projects/")) {
      const identifier = path.slice("/projects/".length).split("/")[0]!;
      const project = [...projects.values()].find(project => String(project.id) === identifier || project.path === decodeURIComponent(identifier));
      if (!project) { status = 404; body = { message: "Not found" }; }
      else if (path.includes("/members/all/")) body = { id: actor === "developer" ? 11 : actor === "maintainer" ? 12 : 13, access_level: project.roles[actor] ?? 0, state: "active", expires_at: null };
      else if (path.includes("/protected_tags")) {
        const page = Number(new URL(req.url!, instance).searchParams.get("page") ?? "1");
        body = project.rules.slice((page - 1) * 100, page * 100);
        state.afterRules?.();
      } else body = { id: project.id, path_with_namespace: project.path, web_url: `${state.publicInstance ?? instance}/${project.path}`, archived: project.archived ?? false,
        repository_access_level: "enabled", shared_with_groups: project.shared ?? [], permissions: { project_access: { access_level: project.roles[actor] ?? 0 }, group_access: null } };
    } else { status = 404; body = { message: "not found" }; }
    transcript.push({ method: req.method!, path, actor, status, response: structuredClone(body), authentication, private_token_present: req.headers["private-token"] !== undefined });
    res.writeHead(status, { "content-type": "application/json", ...failure?.headers }); res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  instance = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { instance, server, projects, transcript, failures, state,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
