import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLocalMcpServer } from "./mcp.js";
import { createLocalProductivityStore } from "./local-productivity-store.js";

// The host starts one process per connection and owns its lifetime.
// Preserve the previous executable path so existing AI client configurations
// automatically use the same local catalog as the standalone catalog window.
const store = createLocalProductivityStore();
const server = createLocalMcpServer(store);
server.server.onclose = () => store.close();
try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  store.close();
  throw error;
}
