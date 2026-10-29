import { withRuntimeDirectories } from "../src/runtime-files.js";
import { environmentUp } from "../src/env-environment.js";
import { implicitHostDefinition } from "../src/env-definition.js";
import { startRun } from "../src/env-run.js";

const [runtimeHome, directoryRegistryHome, workspace, preparedEnvironment] = process.argv.slice(2);
await withRuntimeDirectories({ runtimeHome, directoryRegistryHome }, async () => {
  const environment = preparedEnvironment ? { id: preparedEnvironment } : await environmentUp({ workspace, definition: implicitHostDefinition() });
  const started = startRun({
    environmentId: environment.id,
    argv: ["sh", "-c", preparedEnvironment ? "seq 1 15000; echo ready > started; sleep 30" : "echo before-controller-crash; echo ready > started; sleep 30"],
  });
  console.log(JSON.stringify({ environment: environment.id, run: started.run.id, directory: started.run.directory }));
  await started.done;
});
