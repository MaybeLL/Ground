import { rmSync } from "node:fs";
import { resolve } from "node:path";
rmSync(resolve(new URL("..", import.meta.url).pathname, "dist"), { recursive: true, force: true });
