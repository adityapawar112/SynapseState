import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

export const app: FastifyInstance = Fastify({
  logger: process.env.NODE_ENV === "test" ? false : true,
});

app.get("/health", async () => {
  return { status: "ok" };
});

const argvPath = process.argv[1] ?? "";
const isMainModule =
  argvPath.endsWith("dist/index.js") || argvPath.endsWith("src/index.ts");

if (isMainModule) {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  const host = process.env.HOST || "0.0.0.0";
  app.listen({ port, host }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`SynapseState Demo Shop listening at ${address}`);
  });

  const handleShutdown = (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    void app
      .close()
      .then(() => {
        process.exit(0);
      })
      .catch((err) => {
        app.log.error(err, "Error during graceful shutdown");
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}
