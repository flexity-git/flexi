import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertModule, type FlexiModule } from "@flexity/core";

export const MODULE_SCOPE = "@flexity";
export const MODULE_PREFIX = "module-";

export interface DiscoveredModule {
  packageName: string;
  dir: string;
  module: FlexiModule<any>;
}

export interface DiscoverOptions {
  /** Directories to walk up from, looking for node_modules/@flexity. */
  searchFrom?: string[];
  /** Enabled module names in order (FLEXI_MODULES), or null for all installed. */
  enabled: string[] | null;
  /** Loads a module entry file. Overridable for tests. */
  importer?: (fileUrl: string) => Promise<unknown>;
}

// Only the CLI's own install location is searched, never the working directory:
// running `flexi` inside an untrusted checkout must not import code from it.
function defaultSearchFrom(): string[] {
  return [dirname(fileURLToPath(import.meta.url))];
}

/** The nearest node_modules/@flexity above `from`, or none. Ancestors further up are ignored. */
function scopeDirs(from: string): string[] {
  let current = resolve(from);
  for (;;) {
    const candidate = join(current, "node_modules", MODULE_SCOPE);
    if (existsSync(candidate)) return [candidate];
    const parent = dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}

/** Picks the ESM entry from package.json: exports["."] (string or import/default), then main. */
export function entryOf(pkg: { exports?: unknown; main?: unknown }): string {
  const root =
    typeof pkg.exports === "string"
      ? pkg.exports
      : pkg.exports && typeof pkg.exports === "object"
        ? (pkg.exports as Record<string, unknown>)["."]
        : undefined;
  if (typeof root === "string") return root;
  if (root && typeof root === "object") {
    const conditions = root as Record<string, unknown>;
    for (const key of ["import", "default"]) {
      if (typeof conditions[key] === "string") return conditions[key] as string;
    }
  }
  if (typeof pkg.main === "string") return pkg.main;
  return "index.js";
}

/**
 * Finds installed packages named @flexity/module-* and imports their default export.
 *
 * It scans the nearest node_modules/@flexity above the CLI's own location, which is
 * the project flexi is installed in. npm workspaces symlink every package under
 * modules/ there, and the same lookup works for modules installed from npm. When
 * FLEXI_MODULES is set, only the listed modules are imported.
 */
export async function discoverModules(options: DiscoverOptions): Promise<DiscoveredModule[]> {
  const importer = options.importer ?? ((url: string) => import(url));
  const found = new Map<string, DiscoveredModule>();

  const seenScopes = new Set<string>();
  for (const from of options.searchFrom ?? defaultSearchFrom()) {
    for (const scope of scopeDirs(from)) {
      const real = await realpath(scope);
      if (seenScopes.has(real)) continue;
      seenScopes.add(real);

      for (const entry of await readdir(scope)) {
        if (!entry.startsWith(MODULE_PREFIX)) continue;
        const packageName = `${MODULE_SCOPE}/${entry}`;
        if (found.has(packageName)) continue; // nearest install wins
        const suffix = entry.slice(MODULE_PREFIX.length);
        if (options.enabled && !options.enabled.includes(suffix)) continue; // never import disabled modules
        const dir = await realpath(join(scope, entry));
        const pkgFile = join(dir, "package.json");
        if (!existsSync(pkgFile)) continue;
        const pkg = JSON.parse(await readFile(pkgFile, "utf8")) as { name?: string; exports?: unknown; main?: unknown };
        if (pkg.name !== packageName) continue;

        let loaded: unknown;
        try {
          loaded = await importer(pathToFileURL(join(dir, entryOf(pkg))).href);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Could not load ${packageName}: ${message}`, { cause: err });
        }
        const manifest = (loaded as { default?: unknown }).default;
        assertModule(manifest, packageName);
        if (manifest.name !== suffix) {
          throw new Error(`${packageName} declares name "${manifest.name}"; expected "${suffix}".`);
        }
        found.set(packageName, { packageName, dir, module: manifest });
      }
    }
  }

  const byName = new Map([...found.values()].map((m) => [m.module.name, m]));
  if (options.enabled) {
    return options.enabled.map((name) => {
      const hit = byName.get(name);
      if (!hit) {
        throw new Error(
          `FLEXI_MODULES lists "${name}", but ${MODULE_SCOPE}/${MODULE_PREFIX}${name} is not installed.`,
        );
      }
      return hit;
    });
  }
  return [...byName.values()].sort((a, b) => a.module.name.localeCompare(b.module.name));
}
