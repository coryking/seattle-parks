/**
 * seattle-activities — remote MCP server over the ActiveCommunities
 * (ActiveNet) recreation catalog. Streamable HTTP at POST /mcp; no REST API
 * of its own. Upstream reference: docs/activenet-api.md. Tool definitions:
 * src/tools/*. Pure reshaping logic: src/lib.js.
 */

import { createMcpHandler } from "agents/mcp";
import { createServer, TOOLS } from "./server.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // A fresh server per request (MCP SDK >=1.26 requirement — avoids
      // cross-client response leaks in a stateless handler).
      return createMcpHandler(createServer())(request, env, ctx);
    }
    // Point humans (and health checks) at the endpoint.
    const info = {
      service: "seattle-activities",
      protocol: "Model Context Protocol (Streamable HTTP)",
      endpoint: "/mcp",
      tools: TOOLS.map((t) => t.name),
      repo: "https://github.com/coryking/seattle-parks",
    };
    return new Response(JSON.stringify(info, null, 2), {
      status: url.pathname === "/" ? 200 : 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  },
};
