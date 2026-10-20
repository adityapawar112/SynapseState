import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import pg from "pg";
import { seedPostgresDatabase } from "./seed-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function isPortOpen(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let status = false;
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      status = true;
      socket.destroy();
    });
    socket.once("timeout", () => {
      socket.destroy();
    });
    socket.once("error", () => {
      resolve(false);
    });
    socket.once("close", () => {
      resolve(status);
    });
    socket.connect(port, host);
  });
}

async function main() {
  const dbUrl =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/synapsestate";

  let host = "localhost";
  let port = 5432;
  try {
    const parsed = new URL(dbUrl);
    host = parsed.hostname || "localhost";
    port = parseInt(parsed.port || "5432", 10);
  } catch {
    // fallback defaults
  }

  const pgAvailable = await isPortOpen(host, port, 1500);

  if (pgAvailable) {
    console.log(
      `[start-control-server] PostgreSQL detected at ${host}:${port}. Seeding and starting real control-api...`
    );
    try {
      const pool = new pg.Pool({ connectionString: dbUrl });
      await seedPostgresDatabase(pool);
      await pool.end();
      console.log(`[start-control-server] Database seeded successfully.`);
    } catch (err) {
      console.warn(`[start-control-server] Warning during seeding:`, err);
    }

    const testKeysetPath = path.resolve(__dirname, "test-keyset.json");

    const proc = spawn(
      "pnpm",
      ["--filter", "@synapsestate/control-api", "start"],
      {
        stdio: "inherit",
        shell: true,
        env: {
          ...process.env,
          PORT: process.env.PORT || "3000",
          DATABASE_URL: dbUrl,
          LEASE_DATABASE_URL: dbUrl,
          TELEMETRY_DATABASE_URL: dbUrl,
          KEYSET_PATH: testKeysetPath,
          AUTO_MIGRATE: "true",
          SYNAPSE_API_TOKEN:
            process.env.SYNAPSE_API_TOKEN ||
            "synapse-e2e-master-token-value-2026",
        },
      }
    );

    process.on("SIGTERM", () => proc.kill("SIGTERM"));
    process.on("SIGINT", () => proc.kill("SIGINT"));
    proc.on("exit", (code) => process.exit(code ?? 0));
  } else {
    console.log(
      `[start-control-server] PostgreSQL not detected on ${host}:${port}. Launching contract-compliant mock Control API server...`
    );
    await import("./mock-control-server.js");
  }
}

void main();
