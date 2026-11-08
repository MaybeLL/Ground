import { runLaunchHelper } from "./launch.js";
try { await runLaunchHelper(process.argv[2] ?? ""); }
catch { process.exitCode = 1; }
