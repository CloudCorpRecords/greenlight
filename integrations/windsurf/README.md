# Windsurf install

Windsurf's global MCP config lives at:

    ~/.codeium/windsurf/mcp_config.json

Copy the `mcp_config.json` file in this folder there (merging with any
servers you already have), then restart Windsurf and check its MCP panel:
the `greenlight` server should list 8 tools. Newer Windsurf versions also
accept a project-level `.windsurf/mcp.json` file using the same
`mcpServers` format.

Workflow: see the integrations README — your agent checks Greenlight
before it opens a PR.
