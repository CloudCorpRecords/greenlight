# Cline install

Cline reads MCP servers from `mcpSettings` in its settings. The portable
file form is:

    .cline/mcp_settings.json

Copy the `cline_mcp_settings.json` file in this folder there (merging with
any servers you already have), then check the Cline "MCP Servers" panel:
the `greenlight` server should list 12 tools. The `disabled: false` field is
Cline's way of keeping the server enabled without deleting it.

Workflow: see the integrations README — your agent checks Greenlight
before it opens a PR.
