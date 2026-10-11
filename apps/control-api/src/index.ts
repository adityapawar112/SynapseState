import Fastify from "fastify";

export * from "./db/index.js";

export const server = Fastify({
  logger: true,
});

server.get("/v1/time", async () => {
  return { server_time: new Date().toISOString() };
});
