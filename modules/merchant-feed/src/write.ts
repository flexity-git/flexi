import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Writes `content` to a temporary file in the target directory and renames it
 * over `path`. A reader (web server, merchant center crawler) sees either the
 * old file or the complete new one, never a partial write.
 */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const target = resolve(path);
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
