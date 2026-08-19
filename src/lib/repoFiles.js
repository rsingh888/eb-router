import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function candidateRoots() {
  const roots = [process.cwd()];
  if (process.env.INIT_CWD) roots.push(process.env.INIT_CWD);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/lib → repo root
    roots.push(join(here, "..", ".."));
    // standalone tracing can nest server chunks deeper
    roots.push(join(here, "..", "..", ".."));
  } catch {
    /* ignore */
  }
  return [...new Set(roots.filter(Boolean))];
}

export async function readRepoFile(...parts) {
  for (const root of candidateRoots()) {
    const filePath = join(root, ...parts);
    if (existsSync(filePath)) {
      return readFile(filePath, "utf8");
    }
  }
  return null;
}
