#!/usr/bin/env node
// Scans files tracked or about to be tracked by git for secrets and personal data.
// Optional private denylist: FLEXI_SCAN_DENYLIST=/path/to/list.txt (one term per line,
// kept outside the repo) for names that must never appear, such as suppliers or hosts.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { name: "Slack webhook", re: /hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/ },
  { name: "Slack token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: "Anthropic/OpenAI key", re: /sk-(ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "Bearer token", re: /Bearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { name: "Stripe key", re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}/ },
  { name: "SendGrid key", re: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  {
    name: "E-mail address",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    allow: /^(info@flexity\.sk|noreply@anthropic\.com|[^@]+@([\w-]+\.)*(example|test|localhost)(\.[a-z]+)?|[^@]+@users\.noreply\.github\.com)$/i,
  },
  { name: "Private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Postgres URL with password", re: /postgres(ql)?:\/\/[^:\s/]+:(?!password@|postgres@|change-me@|\*+@)[^@\s]{3,}@[^\s/:"'`]+/, allow: /@(localhost|127\.0\.0\.1|[\w.-]*\.example|[\w.-]*\.test)\b/ },
  { name: "IBAN", re: /\b(SK|CZ|HU|HR|RO|AT|DE)\d{2}(?: ?\d{4}){4,6}\b/, allow: /\b(SK|CZ|HU|HR|RO|AT|DE)00[ 0]*\b/ },
  { name: "Phone number", re: /\+42[01] ?\d{3} ?\d{3} ?\d{3}/, allow: /^\+42[01][ 0]+$/ },
  { name: "IPv4 address", re: /\b(?!127\.|0\.|10\.0\.0\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)(\d{1,3}\.){3}\d{1,3}\b/ },
];

const SKIP = [/^package-lock\.json$/, /^LICENSE$/, /\.(png|jpg|jpeg|gif|svg|ico|pdf|woff2?)$/i];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !SKIP.some((re) => re.test(f)));

const denylist = process.env.FLEXI_SCAN_DENYLIST
  ? readFileSync(process.env.FLEXI_SCAN_DENYLIST, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      // Whole-word, case-insensitive: "Ann" must not match "planning".
      .map((l) => new RegExp(`(^|[^\\p{L}\\p{N}])${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu"))
  : [];

const findings = [];

function scanLine(where, line) {
  for (const p of PATTERNS) {
    const m = line.match(p.re);
    if (m && !(p.allow && p.allow.test(m[0]))) findings.push(`${where}  ${p.name}`);
  }
  for (const term of denylist) {
    if (term.test(line)) findings.push(`${where}  denylisted term`);
  }
}

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split("\n").forEach((line, i) => scanLine(`${file}:${i + 1}`, line));
}

// --history also scans every commit message and every added line in all refs,
// because deleting a secret from the working tree leaves it in history.
let commits = 0;
if (process.argv.includes("--history")) {
  const log = execFileSync("git", ["log", "--all", "-p", "--no-color", "--format=@@commit %H%n%B"], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  let commit = "";
  let file = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("@@commit ")) {
      commit = line.slice(9, 17);
      file = "message";
      commits++;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      continue;
    }
    if (line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (SKIP.some((re) => re.test(file))) continue;
    if (file === "message" || (line.startsWith("+") && !line.startsWith("+++"))) {
      scanLine(`history ${commit} ${file}`, file === "message" ? line : line.slice(1));
    }
  }
}

if (findings.length) {
  console.error(`secrets-scan: ${findings.length} finding(s)\n` + findings.join("\n"));
  process.exit(1);
}
console.log(
  `secrets-scan: ${files.length} files clean${commits ? `, ${commits} commits of history clean` : ""}${denylist.length ? `, ${denylist.length} denylist terms` : ""}`,
);
