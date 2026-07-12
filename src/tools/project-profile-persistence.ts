import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectProfile } from "./project-profile-types.js";

export async function writeProfileToDisk(projectRoot: string, profile: ProjectProfile): Promise<string> {
  const zuvoDir = join(projectRoot, ".zuvo");
  await mkdir(zuvoDir, { recursive: true });
  const profilePath = join(zuvoDir, "project-profile.json");
  const tmpPath = join(zuvoDir, `.project-profile.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, JSON.stringify(profile, null, 2), "utf-8");
    await rename(tmpPath, profilePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  return profilePath;
}
