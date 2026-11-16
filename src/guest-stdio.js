import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGuestMcpServer } from "./mcp.js";

// The host starts one process per connection and owns its lifetime.
await createGuestMcpServer().connect(new StdioServerTransport());
