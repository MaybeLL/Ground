#!/usr/bin/env node
// Installed as "docker" only in this fixture's controller environment.
const {spawnSync}=require("node:child_process");
const {appendFileSync,existsSync,readFileSync,writeFileSync}=require("node:fs");
const {join}=require("node:path");
const args=process.argv.slice(2),docker=readFileSync(join(__dirname,"real-docker"),"utf8");
const gate=process.env.GROUNDS_FIXTURE_GATE,stamp=process.env.GROUNDS_FIXTURE_STAMP;
const ownerFile=gate && join(process.env.GROUNDS_DATA_HOME,"runtime","managed-host","slots",gate);
let owned=false;
if (args[0]==="start" && args.length===2 && ownerFile && existsSync(ownerFile)) {
  const owner=JSON.parse(readFileSync(ownerFile,"utf8"));
  if (owner.pid===process.ppid && owner.name.startsWith(gate+".")) {
    const label=spawnSync(docker,["inspect","--format",'{{index .Config.Labels "dev.grounds.setup-attempt"}}',args[1]],{encoding:"utf8"});
    owned=label.status===0 && label.stdout.trim()===gate;
  }
}
function crash() {
  writeFileSync(stamp,process.env.GROUNDS_FIXTURE_PHASE,{flag:"wx"});
  process.kill(process.ppid,"SIGKILL");
}
const interrupt=owned && !existsSync(stamp);
if (interrupt && process.env.GROUNDS_FIXTURE_PHASE==="before") {crash();process.exit(0);}
const result=spawnSync(docker,args,{stdio:"inherit"});
if (result.error) throw result.error;
if (owned && result.status===0) {
  appendFileSync(stamp+".starts",args[1]+"\n");
  if (interrupt) crash();
}
process.exit(result.status ?? 1);
