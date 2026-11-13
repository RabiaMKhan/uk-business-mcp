#!/usr/bin/env node
/**
 * Entry point: runs the server over stdio.
 *
 * stdio = the client (Claude Desktop, Claude Code, MCP Inspector) starts this
 * process and talks JSON-RPC through stdin/stdout.
 * IMPORTANT: stdout is the protocol channel. Never use console.log here —
 * it corrupts the messages. Use console.error (stderr) for all logs.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { API_KEY_ENV } from "./companiesHouse.js";
import { SERVER_NAME, createServer } from "./server.js";

async function main() {
  // Warn (on stderr) but still start: postcode tools work without the key.
  // Never print the key itself.
  if (!process.env[API_KEY_ENV]?.trim()) {
    console.error(`[${SERVER_NAME}] ${API_KEY_ENV} is not set: company tools will return an error until it is.`);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} running on stdio`);

  // Close cleanly when the client stops us.
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
