#!/usr/bin/env node
import { runCLI } from "./cli.js";

const code = await runCLI(process.argv.slice(2));
process.exitCode = code;
