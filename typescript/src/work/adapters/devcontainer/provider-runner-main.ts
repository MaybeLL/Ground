import { collectProvider } from "./provider-runner.js";
try { await collectProvider(process.argv[2]!); } catch { process.exitCode=1; }
