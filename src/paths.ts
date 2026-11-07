import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
// Project root (src/ in dev via tsx, dist/ when built — both one level below the root).
export const ROOT = join(__dir, "..");
export const DATA_DIR = join(ROOT, "data");
