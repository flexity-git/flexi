#!/usr/bin/env -S npx tsx
import { main } from "./main.js";

process.exitCode = await main(process.argv.slice(2));
