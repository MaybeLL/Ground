// The process census intentionally returns unknown for an unreadable orphan
// of the same uid. Keep unrelated runner processes out of this CI fixture.
import {spawnSync} from "node:child_process";
import {chmodSync,copyFileSync,cpSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join} from "node:path";

if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true") throw new Error("expected a hosted macOS test runner");
const stage=mkdtempSync("/private/tmp/grounds-census-ci-");
try {
  for (const entry of ["package.json","src","prebuilds","node_modules"]) {
    cpSync(realpathSync(entry),join(stage,entry),{recursive:true,verbatimSymlinks:true});
  }
  mkdirSync(join(stage,"test"));
  for (const file of ["env-process.test.ts","env-test-helpers.ts"]) copyFileSync(join("test",file),join(stage,"test",file));
  mkdirSync(join(stage,"bin"));
  copyFileSync(process.execPath,join(stage,"bin/node"));
  chmodSync(join(stage,"bin/node"),0o755);
  cpSync(realpathSync(process.env.pythonLocation),join(stage,"python"),{recursive:true,verbatimSymlinks:true});
  chmodSync(stage,0o755);

  // Repository code executes as the unprivileged account. The runner only
  // supplies public fixture code and toolchains; no runner credentials pass.
  const child=spawnSync("/usr/bin/sudo",["-n","-u","nobody","/usr/bin/env","-i","PATH="+join(stage,"bin")+":"+join(stage,"python/bin")+":/usr/bin:/bin:/usr/sbin:/sbin",
    "/bin/sh","-ec",`
      fixture=$(mktemp -d /private/tmp/grounds-census-data-XXXXXXXX)
      trap 'rm -rf "$fixture"' EXIT
      export TMPDIR="$fixture" GROUNDS_DATA_HOME="$fixture/grounds" XDG_CACHE_HOME="$fixture/cache"
      node --import tsx --test --test-concurrency=1 "$@" test/env-process.test.ts
    `,"grounds-census",...process.argv.slice(2)],{cwd:stage,stdio:"inherit"});
  if (child.error) throw child.error;
  process.exitCode=child.status ?? 1;
} finally {rmSync(stage,{recursive:true,force:true});}
