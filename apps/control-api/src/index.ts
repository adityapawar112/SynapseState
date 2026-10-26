import { buildServer, type ServerOptions } from "./app.js";
import { leasePool, runMigrations, closePools } from "./db/index.js";

export * from "./db/index.js";
export * from "./keyset.js";
export * from "./services/state-manager.js";
export * from "./sealer/index.js";
export * from "./routes/time.js";
export * from "./routes/leases.js";
export * from "./routes/state.js";
export * from "./routes/health.js";
export * from "./routes/telemetry.js";
export * from "./routes/changes.js";
export { buildServer, type ServerOptions };

export const server = buildServer({
  enableAuditSealer:
    process.env.ENABLE_AUDIT_SEALER === "true" ||
    process.env.NODE_ENV !== "test",
});

// Start server if executed directly as entrypoint
const argvPath = process.argv[1] ?? "";
const isMainModule =
  /dist[\\/]index\.js$/.test(argvPath) ||
  /src[\\/]index\.ts$/.test(argvPath) ||
  argvPath.endsWith("dist/index.js") ||
  argvPath.endsWith("src/index.ts");

if (isMainModule) {
  const startServer = async () => {
    if (process.env.AUTO_MIGRATE === "true") {
      try {
        server.log.info("Running automatic database migrations...");
        const applied = await runMigrations(leasePool);
        server.log.info(
          { appliedCount: applied.length, applied },
          "Database migrations applied successfully",
        );
      } catch (err) {
        server.log.error(err, "Failed to apply database migrations on startup");
        process.exit(1);
      }
    }

    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    const host = process.env.HOST || "0.0.0.0";
    server.listen({ port, host }, (err, address) => {
      if (err) {
        server.log.error(err);
        process.exit(1);
      }
      server.log.info(`SynapseState Control API listening at ${address}`);
    });
  };

  void startServer();

  const handleShutdown = (signal: string) => {
    server.log.info(`Received ${signal}, shutting down gracefully...`);
    void server
      .close()
      .then(async () => {
        await closePools();
        process.exit(0);
      })
      .catch(async (err) => {
        server.log.error(err, "Error during graceful shutdown");
        try {
          await closePools();
        } catch {
          // ignore error during forced exit
        }
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}
