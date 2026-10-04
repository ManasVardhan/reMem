// Pointing the plugin's hooks at the kernel setup installed.
//
// The hooks (plugin/hooks/_shared.mjs) resolve the kernel from
// ~/.remem/kernel-path.json before they search anywhere else, including
// ~/.remem/runtime. Anyone who installed reMem globally before setup existed
// has that file pointing at the global package, so without this the hooks
// would keep loading the old kernel after setup installed the new one. The
// file format is the one the hooks write: {"root": "<package dir>"}.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Resolves to undefined on success, or to a reason the pin could not be made.
export function pinKernel(cachePath: string, root: string): string | undefined {
  if (!existsSync(join(root, "dist", "index.js"))) {
    return `no kernel at ${root} (dist/index.js is missing)`;
  }
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ root }, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `could not write ${cachePath}: ${message}`;
  }
  return undefined;
}
