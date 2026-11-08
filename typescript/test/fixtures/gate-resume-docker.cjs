#!/usr/bin/env node
// Installed as "docker" only in this fixture's controller environment.
const {spawnSync}=require("node:child_process");
const {appendFileSync,existsSync,readFileSync,writeFileSync}=require("node:fs");
const {join}=require("node:path");
const args=process.argv.slice(2),docker=readFileSync(join(__dirname,"real-docker"),"utf8");
const {gate,stamp,phase}=JSON.parse(readFileSync(join(__dirname,"interrupt.json"),"utf8"));
const ownerFile=join(process.env.GROUNDS_DATA_HOME,"runtime","managed-host","slots",gate);
let matched=false,owned=false;
if (args[0]==="start" && args.length===2) {
  const label=spawnSync(docker,["inspect","--format",'{{index .Config.Labels "dev.grounds.setup-attempt"}}',args[1]],{encoding:"utf8"});
  matched=label.status===0 && label.stdout.trim()===gate;
  if (matched && existsSync(ownerFile)) {
    const owner=JSON.parse(readFileSync(ownerFile,"utf8"));
    owned=owner.pid===process.ppid && owner.name.startsWith(gate+".");
  }
}
function crash() {
  writeFileSync(stamp,phase,{flag:"wx"});
  process.kill(process.ppid,"SIGKILL");
}
const interrupt=owned && !existsSync(stamp);
if (interrupt && phase==="before") {crash();process.exit(0);}
const result=spawnSync(docker,args,{stdio:"inherit"});
if (result.error) throw result.error;
if (matched && result.status===0) {
  appendFileSync(stamp+".starts",args[1]+"\n");
  if (interrupt) crash();
}
process.exit(result.status ?? 1);
