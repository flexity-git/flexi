#!/usr/bin/env -S npx tsx
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2));
