/**
 * MCP server assembly: registers every tool module. Handlers return plain
 * objects; the JSON envelope is applied here so tools stay MCP-agnostic.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { version as VERSION } from "../package.json";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import searchActivities from "./tools/search-activities.js";
import activityDetail from "./tools/activity-detail.js";
import dropins from "./tools/dropins.js";
import filters from "./tools/filters.js";
import listOrgs from "./tools/list-orgs.js";

export const TOOLS = [searchActivities, activityDetail, dropins, filters, listOrgs];

export function createServer() {
  const server = new McpServer(
    { name: "seattle-activities", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );
  for (const tool of TOOLS) {
    server.registerTool(tool.name, tool.config, async (args) => {
      // Skim-tier handlers return compact markdown strings; the rest return
      // objects that get the JSON envelope.
      const result = await tool.handler(args ?? {});
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { content: [{ type: "text", text }] };
    });
  }
  return server;
}
