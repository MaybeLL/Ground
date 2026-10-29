import { spawn } from "node:child_process";
import { openSync, closeSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker } from "./env-docker.js";
import { DomainError } from "./errors.js";

export interface DevelopmentBuildHost { engine_id: string; platform: string; builder: string; endpoint: string }
export interface DevelopmentBuildIdentity extends DevelopmentBuildHost { preparation_id: string; input_digest: string }
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
/** Local trusted recipes only. A lost CLI result never proves a terminal build failure. */
export class DevelopmentImageBuilder {
  async identity(): Promise<DevelopmentBuildHost> {
    const endpoint = process.env.DOCKER_CONTEXT
      ? JSON.parse(docker(["context", "inspect", process.env.DOCKER_CONTEXT]))[0].Endpoints.docker.Host
      : process.env.DOCKER_HOST || JSON.parse(docker(["context", "inspect"]))[0].Endpoints.docker.Host;
    if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///")) conflict("Development builds require a local Unix Docker endpoint");
    const info = JSON.parse(docker(["--host", endpoint, "info", "--format", "{{json .}}"]));
    if (info.OSType !== "linux" || !info.ID) conflict("Development builds require an identifiable Linux engine");
    const plugin = info.ClientInfo?.Plugins?.find((entry: { Name: string }) => entry.Name === "buildx");
    if (!plugin || typeof plugin.Path !== "string" || !plugin.Path.startsWith("/")) conflict("Local Docker buildx plugin is unavailable");
    const arch = info.Architecture === "aarch64" ? "arm64" : info.Architecture === "x86_64" ? "amd64" : info.Architecture;
    return { endpoint, engine_id: info.ID, platform: `linux/${arch}`, builder: "docker-buildkit/v1" };
  }
  private async assertHost(record: DevelopmentBuildIdentity) {
    const current = await this.identity();
    if (Object.keys(current).some(k => current[k as keyof DevelopmentBuildHost] !== record[k as keyof DevelopmentBuildHost]))
      conflict("Original build engine or platform is unavailable; do not redispatch");
  }
  async verify(record: DevelopmentBuildIdentity, image: string): Promise<boolean> {
    await this.assertHost(record);
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) return false;
    const found = docker(["--host", record.endpoint, "image", "ls", "--no-trunc", "-q", "--filter", `label=grounds.development-preparation=${record.preparation_id}`]).split("\n");
    if (!found.includes(image)) return false;
    const value = JSON.parse(docker(["--host", record.endpoint, "image", "inspect", image]))[0];
    return value.Id === image && `${value.Os}/${value.Architecture}` === record.platform
      && value.Config.Labels?.["grounds.development-preparation"] === record.preparation_id
      && value.Config.Labels?.["grounds.build-input"] === record.input_digest;
  }
  async find(record: DevelopmentBuildIdentity): Promise<string | undefined> {
    await this.assertHost(record);
    const images = [...new Set(docker(["--host", record.endpoint, "image", "ls", "--no-trunc", "-q", "--filter", `label=grounds.development-preparation=${record.preparation_id}`]).split("\n").filter(Boolean))];
    if (images.length > 1) conflict("Ambiguous build results; retain preparation");
    if (!images.length) return undefined;
    if (!await this.verify(record, images[0])) conflict("Build result labels or platform do not match");
    return images[0];
  }
  async build(record: DevelopmentBuildIdentity, context: string, dockerfile: string, args: Record<string, string>, log: string): Promise<string> {
    await this.assertHost(record);
    const config = mkdtempSync(join(tmpdir(), "grounds-build-config-"));
    writeFileSync(join(config, "config.json"), "{}", { mode: 0o600 });
    const plugins = JSON.parse(docker(["--host", record.endpoint, "info", "--format", "{{json .ClientInfo.Plugins}}"]));
    const plugin = plugins.find((entry: { Name: string }) => entry.Name === "buildx");
    if (!plugin || typeof plugin.Path !== "string" || !plugin.Path.startsWith("/")) conflict("Local Docker buildx plugin is unavailable");
    mkdirSync(join(config, "cli-plugins"));
    symlinkSync(plugin.Path, join(config, "cli-plugins", "docker-buildx"));
    const fd = openSync(log, "wx", 0o600);
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, DOCKER_HOST: record.endpoint, DOCKER_CONFIG: config, BUILDX_BUILDER: "default" };
      delete env.DOCKER_CONTEXT;
      delete env.BUILDX_CONFIG;
      delete env.BUILDKIT_HOST;
      const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("docker", ["--host", record.endpoint, "buildx", "build", "--builder", "default", "--load",
          "--progress=plain", "--platform", record.platform, "--network", "default",
          "--label", `grounds.development-preparation=${record.preparation_id}`, "--label", `grounds.build-input=${record.input_digest}`,
          "--tag", `grounds-development-build:${record.preparation_id}`, "--file", join(context, dockerfile),
          ...Object.entries(args).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]), context],
        { env, stdio: ["ignore", fd, fd] });
        child.once("error", reject); child.once("close", resolve);
      });
      const image = await this.find(record);
      if (image) return image;
      return conflict(`Build result is unproven (client exit ${code}); retain the operation and inspect its log`);
    } finally { closeSync(fd); rmSync(config, { recursive: true, force: true }); }
  }
}
