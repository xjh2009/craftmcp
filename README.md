# craftmcp

MCP (Model Context Protocol) server for Minecraft mod debugging. Launch, download, and run Minecraft through LLM tools.

## Usage

```bash
# Run directly
npx craftmcp

# Or install globally
npm install -g craftmcp
craftmcp
```

## Tools

| Tool | Description |
|------|-------------|
| `get_version_list` | List available Minecraft versions |
| `install_minecraft` | Install a version (with optional version isolation) |
| `install_fabric` | Install Fabric loader |
| `install_forge` | Install Forge loader |
| `list_installed` | List installed versions & isolation status |
| `scan_java` | Find Java installations |
| `launch_minecraft` | Launch Minecraft (supports version isolation) |
| `stop_minecraft` | Stop a running instance |
| `list_running` | List running instances |
| `copy_mod` | Copy a mod jar into a version's mods folder |
| `read_log` | Read latest.log or crash reports |

## MCP Config

Add to your `opencode.json` or MCP client config:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": ["craftmcp"]
    }
  }
}
```

## Environment

- `MC_ROOT` - Override `.minecraft` path (default: `%APPDATA%\.minecraft` on Windows, `~/.minecraft` on others)
