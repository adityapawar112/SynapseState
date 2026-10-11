import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(__dirname, "../src/db/migrations");
const distDir = path.resolve(__dirname, "../dist/db/migrations");

if (!fs.existsSync(srcDir)) {
  throw new Error(`Migration source directory does not exist: ${srcDir}`);
}

fs.mkdirSync(distDir, { recursive: true });
fs.cpSync(srcDir, distDir, { recursive: true });
