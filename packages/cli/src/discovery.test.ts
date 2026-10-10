import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverModules, entryOf } from "./discovery.js";

async function fakeInstall(packages: Record<string, { name?: string; manifest: string }>) {
  const root = await mkdtemp(join(tmpdir(), "flexi-disc-"));
  for (const [dirName, pkg] of Object.entries(packages)) {
    const dir = join(root, "node_modules", "@flexity", dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: pkg.name ?? `@flexity/${dirName}`, type: "module", exports: { ".": "./index.js" } }),
    );
    await writeFile(join(dir, "index.js"), pkg.manifest);
  }
  return root;
}

const manifest = (name: string) =>
  `export default { name: ${JSON.stringify(name)}, description: "Demo.", tasks: { check: { description: "Check.", run: async () => ({}) } } };`;

describe("discoverModules", () => {
  it("imports @flexity/module-* packages and ignores other packages", async () => {
    const root = await fakeInstall({
      "module-beta": { manifest: manifest("beta") },
      "module-alpha": { manifest: manifest("alpha") },
      core: { manifest: "export default {};" },
    });
    const found = await discoverModules({ searchFrom: [root], enabled: null });
    expect(found.map((m) => m.module.name)).toEqual(["alpha", "beta"]);
    expect(found[0]!.packageName).toBe("@flexity/module-alpha");
  });

  it("follows FLEXI_MODULES order and reports missing modules", async () => {
    const root = await fakeInstall({
      "module-alpha": { manifest: manifest("alpha") },
      "module-beta": { manifest: manifest("beta") },
    });
    const found = await discoverModules({ searchFrom: [root], enabled: ["beta"] });
    expect(found.map((m) => m.module.name)).toEqual(["beta"]);
    await expect(discoverModules({ searchFrom: [root], enabled: ["gamma"] })).rejects.toThrow(
      /@flexity\/module-gamma is not installed/,
    );
  });

  it("rejects invalid manifests and name mismatches", async () => {
    const bad = await fakeInstall({ "module-bad": { manifest: "export default { name: 'bad' };" } });
    await expect(discoverModules({ searchFrom: [bad], enabled: null })).rejects.toThrow(/Invalid flexi module/);
    const mismatch = await fakeInstall({ "module-one": { manifest: manifest("two") } });
    await expect(discoverModules({ searchFrom: [mismatch], enabled: null })).rejects.toThrow(/expected "one"/);
  });

  it("finds node_modules in ancestor directories", async () => {
    const root = await fakeInstall({ "module-alpha": { manifest: manifest("alpha") } });
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    const found = await discoverModules({ searchFrom: [nested], enabled: null });
    expect(found.map((m) => m.module.name)).toEqual(["alpha"]);
  });

  it("never imports modules that FLEXI_MODULES leaves out", async () => {
    const root = await fakeInstall({
      "module-alpha": { manifest: manifest("alpha") },
      "module-evil": { manifest: `throw new Error("imported a disabled module");` },
    });
    const found = await discoverModules({ searchFrom: [root], enabled: ["alpha"] });
    expect(found.map((m) => m.module.name)).toEqual(["alpha"]);
  });

  it("stops at the nearest node_modules/@flexity and ignores ones further up", async () => {
    const outer = await fakeInstall({ "module-outer": { manifest: manifest("outer") } });
    const innerDir = join(outer, "project", "node_modules", "@flexity", "module-inner");
    await mkdir(innerDir, { recursive: true });
    await writeFile(
      join(innerDir, "package.json"),
      JSON.stringify({ name: "@flexity/module-inner", type: "module", exports: { ".": "./index.js" } }),
    );
    await writeFile(join(innerDir, "index.js"), manifest("inner"));
    const found = await discoverModules({ searchFrom: [join(outer, "project")], enabled: null });
    expect(found.map((m) => m.module.name)).toEqual(["inner"]);
  });
});

describe("entryOf", () => {
  it("reads the common package.json entry shapes", () => {
    expect(entryOf({ exports: "./a.js" })).toBe("./a.js");
    expect(entryOf({ exports: { ".": "./src/index.ts" } })).toBe("./src/index.ts");
    expect(entryOf({ exports: { ".": { import: "./esm.js", require: "./cjs.cjs" } } })).toBe("./esm.js");
    expect(entryOf({ main: "./main.js" })).toBe("./main.js");
    expect(entryOf({})).toBe("index.js");
  });
});
