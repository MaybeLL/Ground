import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { readdirSync, lstatSync } from "node:fs";
import { docker } from "./env-docker.js";
import { DomainError } from "./errors.js";
import { buildRecipe, type RepositoryBuildMaterial } from "./repository-build-materials.js";
import { atomicPrivateWrite, digestBytes, safeRead } from "./runtime-files.js";
import type { ImageBuildEngine, ImagePreparation } from "./repository-image-preparation.js";

const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
export class DockerImageBuildEngine implements ImageBuildEngine {
  async identity() {
    const version = JSON.parse(docker(["version", "--format", "{{json .Server}}"]));
    return { engine_id: docker(["info", "--format", "{{.ID}}"]), platform: `${version.Os}/${version.Arch}`,
      builder: `docker-classic/${version.Version}/grounds-fixed-recipe-v1` };
  }
  async assertBase(image: string, platform: string) {
    const value = JSON.parse(docker(["image", "inspect", image]))[0];
    if (value.Id !== image || `${value.Os}/${value.Architecture}` !== platform || platform.split("/")[0] !== "linux"
      || value.Config.OnBuild?.length) conflict("Base must be a local matching Linux image without inherited ONBUILD instructions");
  }
  async find(record: ImagePreparation) {
    const images = [...new Set(docker(["image", "ls", "--no-trunc", "-q", "--filter", `label=grounds.image-preparation=${record.preparation_id}`,
      "--filter", `label=grounds.build-input=${record.input_digest}`]).split("\n").filter(Boolean))];
    if (images.length > 1) conflict("Build result is ambiguous; retain preparation");
    return images[0];
  }
  async verify(record: ImagePreparation, image: string) {
    if ((await this.identity()).engine_id !== record.engine_id) conflict("Build engine changed");
    const available = docker(["image", "ls", "--no-trunc", "-aq"]).split("\n");
    if (!available.includes(image)) return false; // Only a successful inventory proves absence.
    const value = JSON.parse(docker(["image", "inspect", image]))[0];
    if (value.Id !== image || `${value.Os}/${value.Architecture}` !== record.platform
      || value.Config.Labels?.["grounds.image-preparation"] !== (record.producer_id ?? record.preparation_id)
      || value.Config.Labels?.["grounds.build-input"] !== record.input_digest) conflict("Image does not match the fixed preparation");
    let ancestor = value.Parent;
    for (let i = 0; i < 256 && ancestor; i++) {
      if (ancestor === record.base_image) return true;
      ancestor = JSON.parse(docker(["image", "inspect", ancestor]))[0].Parent;
    }
    return conflict("Classic build result does not prove the fixed base ancestry");
  }
  async build(record: ImagePreparation, material: RepositoryBuildMaterial, directory: string) {
    const context = join(directory, "context"), selected = new Set(material.files.map(file => file.path));
    let count = 0;
    const inspect = (relative: string) => {
      for (const entry of readdirSync(join(context, relative), { withFileTypes: true })) {
        if (++count > 512) conflict("Build context exceeds its fixed material");
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) inspect(path);
        else if (!entry.isFile() || !selected.delete(path)) conflict("Build context contains unselected files or links");
      }
    };
    inspect("");
    if (selected.size || material.files.some(file => digestBytes(safeRead(join(context, file.path), 4 * 1024 * 1024)) !== file.digest
      || (lstatSync(join(context, file.path)).mode & 0o777) !== (file.mode === "100755" ? 0o755 : 0o644)))
      conflict("Build context no longer matches captured bytes");
    await this.assertBase(record.base_image, record.platform);
    const tag = `grounds-build-base:${record.preparation_id}`;
    const existing = docker(["image", "ls", "--no-trunc", "-q", tag]);
    if (existing && existing !== record.base_image) conflict("Reserved base tag is already occupied");
    docker(["image", "tag", record.base_image, tag]);
    atomicPrivateWrite(join(directory, "Dockerfile"), buildRecipe(material, tag));
    const iid = join(directory, "image-id");
    // Read the daemon's structured terminal response. A CLI exit code alone cannot
    // distinguish a failed recipe from a broken transport with a running build.
    const endpoint = process.env.DOCKER_CONTEXT
      ? JSON.parse(docker(["context", "inspect", process.env.DOCKER_CONTEXT]))[0].Endpoints.docker.Host
      : process.env.DOCKER_HOST || JSON.parse(docker(["context", "inspect"]))[0].Endpoints.docker.Host;
    if (typeof endpoint !== "string" || !endpoint.startsWith("unix:///")) conflict("Image builds require a local Unix Docker endpoint");
    const version = JSON.parse(docker(["version", "--format", "{{json .Server}}"])).ApiVersion;
    if (!/^1\.[0-9]+$/.test(version)) conflict("Docker API version is unavailable");
    // Generated recipe has a private name; selected materials cannot contain dot paths.
    const recipeName = ".grounds-build-recipe";
    atomicPrivateWrite(join(directory, recipeName), buildRecipe(material, tag));
    atomicPrivateWrite(join(directory, ".dockerignore"), ".grounds-build-recipe\n.dockerignore\n");
    const tar = execFileSync("tar", ["--format=ustar", "-cf", "-", "-C", directory, recipeName, ".dockerignore", "-C", context,
      ...material.files.map(file => file.path)], { maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
    const proxies = Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY", "ALL_PROXY",
      "http_proxy", "https_proxy", "ftp_proxy", "no_proxy", "all_proxy"].map(key => [key, ""]));
    const query = new URLSearchParams({ version: "1", dockerfile: recipeName, pull: "0", networkmode: "none", platform: record.platform,
      rm: "1", forcerm: "1", memory: "536870912", cpuperiod: "100000", cpuquota: "100000", buildargs: JSON.stringify(proxies),
      labels: JSON.stringify({ "grounds.image-preparation": record.preparation_id, "grounds.build-input": record.input_digest }) });
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      let body = "", size = 0;
      const req = httpRequest({ socketPath: endpoint.slice(7), method: "POST", path: `/v${version}/build?${query}`,
        headers: { "Content-Type": "application/x-tar", "Content-Length": tar.length } }, res => {
        res.setEncoding("utf8");
        res.on("data", (part: string) => {
          size += Buffer.byteLength(part);
          if (size > 1024 * 1024) { req.destroy(new Error("Build output exceeds limit")); return; }
          body += part;
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            atomicPrivateWrite(join(directory, "build.log"), body);
            if (!res.complete) reject(new Error("Incomplete daemon response"));
            else resolve({ status: res.statusCode ?? 0, body });
          } catch (error) { reject(error); }
        });
      });
      const timer = setTimeout(() => req.destroy(new Error("Build deadline exceeded; retain unknown ownership")), 120_000);
      req.on("error", reject);
      req.on("close", () => clearTimeout(timer));
      req.end(tar);
    });
    // Only a complete HTTP 200 JSON stream ending in a daemon error proves a
    // recipe failure. Transport/HTTP/protocol errors remain needs-recovery.
    if (result.status !== 200) conflict("Build request did not return a complete successful HTTP response");
    const events = result.body.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
    const last = events.at(-1);
    if (last && typeof last.errorDetail?.message === "string" && typeof last.error === "string") {
      atomicPrivateWrite(join(directory, "build-failure.json"), JSON.stringify({ format: "grounds.build-failure/v1",
        preparation_id: record.preparation_id, request_digest: record.request_digest, input_digest: record.input_digest,
        engine_id: record.engine_id, outcome: "failed" }));
      conflict("Docker daemon confirmed recipe failure; see retained build log");
    }
    const image = await this.find(record);
    if (!image) conflict("Build stream did not produce a verifiable image");
    atomicPrivateWrite(iid, image);
    return image;
  }
  async failureConfirmed(record: ImagePreparation, directory: string) {
    let proof;
    try { proof = JSON.parse(safeRead(join(directory, "build-failure.json"), 4096).toString()); }
    catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
    if ((await this.identity()).engine_id !== record.engine_id || proof.format !== "grounds.build-failure/v1"
      || proof.preparation_id !== record.preparation_id || proof.request_digest !== record.request_digest
      || proof.input_digest !== record.input_digest || proof.engine_id !== record.engine_id || proof.outcome !== "failed")
      conflict("Build failure proof does not match this preparation and engine");
    return true;
  }
}
