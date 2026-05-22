import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { MinecraftFolder, launch, createMinecraftProcessWatcher, Version } from "@xmcl/core";
import {
  getVersionList,
  install,
  installFabric,
  installForge,
  installLibraries,
  installAssets,
  scanLocalJava,
  getForgeVersionList,
} from "@xmcl/installer";
import { existsSync, readdirSync, readFileSync, statSync, cpSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { homedir, platform } from "os";

const MC_ROOT = process.env.MC_ROOT ||
  (platform() === "win32"
    ? join(process.env.APPDATA!, ".minecraft")
    : join(homedir(), ".minecraft"));

function getInstalledVersions(): string[] {
  const dir = join(MC_ROOT, "versions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((v) =>
    existsSync(join(dir, v, `${v}.json`))
  );
}

function isVersionIsolated(versionId: string): boolean {
  const verDir = join(MC_ROOT, "versions", versionId);
  if (!existsSync(verDir)) return false;
  return existsSync(join(verDir, "mods")) ||
    existsSync(join(verDir, "config")) ||
    existsSync(join(verDir, "saves")) ||
    existsSync(join(verDir, "resourcepacks"));
}

function gameDir(versionId: string, isolated: boolean): string {
  return isolated ? join(MC_ROOT, "versions", versionId) : MC_ROOT;
}

interface RunningProcess {
  process: import("child_process").ChildProcess;
  pid: number;
  launchTime: number;
}

const runningProcesses: Map<string, RunningProcess> = new Map();

const server = new Server(
  { name: "minecraft-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "get_version_list",
      description: "List available Minecraft versions from Mojang manifest",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["release", "snapshot", "old_beta", "old_alpha"],
            description: "Filter by version type",
          },
        },
      },
    },
    {
      name: "install_minecraft",
      description: "Install a specific Minecraft version (jar + libraries + assets). Version data is always stored under .minecraft/versions/<id>/",
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "string", description: "Minecraft version id (e.g. 1.20.4)" },
          isolated: { type: "boolean", description: "Enable version isolation: mods/config/saves will be stored INSIDE .minecraft/versions/<id>/ instead of .minecraft root. Recommended for mod debugging." },
        },
        required: ["version"],
      },
    },
    {
      name: "install_fabric",
      description: "Install Fabric mod loader for a Minecraft version",
      inputSchema: {
        type: "object",
        properties: {
          minecraftVersion: { type: "string", description: "Minecraft version id (e.g. 1.20.4)" },
          loaderVersion: { type: "string", description: "Fabric loader version (optional, auto-detected)" },
          isolated: { type: "boolean", description: "Enable version isolation" },
        },
        required: ["minecraftVersion"],
      },
    },
    {
      name: "install_forge",
      description: "Install Forge mod loader for a Minecraft version",
      inputSchema: {
        type: "object",
        properties: {
          minecraftVersion: { type: "string", description: "Minecraft version id (e.g. 1.20.1)" },
          forgeVersion: { type: "string", description: "Forge version (optional, auto-detected)" },
          isolated: { type: "boolean", description: "Enable version isolation" },
        },
        required: ["minecraftVersion"],
      },
    },
    {
      name: "list_installed",
      description: "List installed versions and their isolation status",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "scan_java",
      description: "Scan for available Java installations on this system",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "launch_minecraft",
      description: "Launch Minecraft. When isolated=true, the game reads/writes mods/config/saves from .minecraft/versions/<version>/ instead of .minecraft root, preventing cross-version mod conflicts",
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "string", description: "Version id (e.g. 1.21.11-Fabric 0.19.2). Auto-detected if omitted." },
          isolated: { type: "boolean", description: "Enable version isolation. Default: auto-detect based on whether version has its own mods/config folder" },
          javaPath: { type: "string", description: "Path to java executable (auto-detected if omitted)" },
          maxMemory: { type: "number", description: "Max memory in MB (default: 2048)" },
          minMemory: { type: "number", description: "Min memory in MB" },
          resolution: {
            type: "object",
            properties: {
              width: { type: "number" },
              height: { type: "number" },
              fullscreen: { type: "boolean" },
            },
            description: "Window resolution",
          },
          server: {
            type: "object",
            properties: {
              ip: { type: "string" },
              port: { type: "number" },
            },
            description: "Auto-connect to a server",
          },
          username: { type: "string", description: "Player name (default: DevPlayer)" },
          extraJVMArgs: { type: "array", items: { type: "string" }, description: "Extra JVM arguments" },
          extraMCArgs: { type: "array", items: { type: "string" }, description: "Extra Minecraft arguments" },
        },
      },
    },
    {
      name: "stop_minecraft",
      description: "Stop a running Minecraft instance by version id",
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "string", description: "Version id to stop" },
        },
        required: ["version"],
      },
    },
    {
      name: "list_running",
      description: "List currently running Minecraft versions",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "copy_mod",
      description: "Copy a mod jar into a version's mods folder. If the version has isolation enabled, mod goes to .minecraft/versions/<version>/mods/. Otherwise, mod goes to .minecraft/mods/",
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "string", description: "Version id (e.g. 1.21.11-Fabric 0.19.2)" },
          sourcePath: { type: "string", description: "Absolute path to the mod jar file" },
        },
        required: ["version", "sourcePath"],
      },
    },
    {
      name: "read_log",
      description: "Read Minecraft logs. For isolated versions, reads from .minecraft/versions/<version>/logs/. For non-isolated versions, reads from .minecraft/logs/. Also supports crash reports.",
      inputSchema: {
        type: "object",
        properties: {
          version: { type: "string", description: "Version id (required for isolated versions, optional for shared logs)" },
          type: {
            type: "string",
            enum: ["latest", "crash-report", "all"],
            description: "Log type: latest.log, most recent crash report, or all logs listing (default: latest)",
          },
          lines: { type: "number", description: "Number of lines to show from the end (tail). Default: all lines." },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_version_list":
        return await handleGetVersionList(args);
      case "install_minecraft":
        return await handleInstallMinecraft(args);
      case "install_fabric":
        return await handleInstallFabric(args);
      case "install_forge":
        return await handleInstallForge(args);
      case "list_installed":
        return await handleListInstalled();
      case "scan_java":
        return await handleScanJava();
      case "launch_minecraft":
        return await handleLaunchMinecraft(args);
      case "stop_minecraft":
        return await handleStopMinecraft(args);
      case "list_running":
        return await handleListRunning();
      case "copy_mod":
        return await handleCopyMod(args);
      case "read_log":
        return await handleReadLog(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error: any) {
    if (error instanceof McpError) throw error;
    return {
      content: [{ type: "text", text: `Error: ${error.message || error}` }],
      isError: true,
    };
  }
});

async function handleGetVersionList(args: any) {
  const list = await getVersionList();
  const filtered = args?.type ? list.versions.filter((v: any) => v.type === args.type) : list.versions;

  const lines = [
    `Minecraft root: ${MC_ROOT}`,
    `Latest release: ${list.latest.release}`,
    `Latest snapshot: ${list.latest.snapshot}`,
    `Total versions: ${filtered.length}`,
    "",
    ...filtered.slice(0, 100).map((v: any) => `${v.id} (${v.type}) - ${v.releaseTime}`),
  ];

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleInstallMinecraft(args: any) {
  const versionId = args.version;
  const isolated = !!args.isolated;

  const list = await getVersionList();
  const versionMeta = list.versions.find((v: any) => v.id === versionId);
  if (!versionMeta) throw new Error(`Version ${versionId} not found in manifest`);

  const resolved = await install(versionMeta, MC_ROOT);

  if (isolated) {
    mkdirSync(join(MC_ROOT, "versions", resolved.id, "mods"), { recursive: true });
  }

  return {
    content: [{
      type: "text",
      text: [
        `Installed Minecraft ${resolved.id}`,
        `Minecraft root: ${MC_ROOT}`,
        `Version isolation: ${isolated ? "ON" : "OFF"}`,
        isolated ? `  Game dir: ${MC_ROOT}\\versions\\${resolved.id} (mods/config/saves isolated)` : `  Game dir: ${MC_ROOT} (shared)`,
      ].join("\n"),
    }],
  };
}

async function handleInstallFabric(args: any) {
  const mcVersion = args.minecraftVersion;
  const isolated = !!args.isolated;

  const list = await getVersionList();
  const versionMeta = list.versions.find((v: any) => v.id === mcVersion);
  if (!versionMeta) throw new Error(`Minecraft version ${mcVersion} not found`);

  await install(versionMeta, MC_ROOT);

  const versionId = await installFabric({
    minecraftVersion: mcVersion,
    version: args.loaderVersion || "",
    minecraft: MC_ROOT,
    side: "client",
  });

  const mcFolder = MinecraftFolder.from(MC_ROOT);
  try {
    const resolved = await Version.parse(mcFolder, versionId);
    await installLibraries(resolved);
    await installAssets(resolved);
  } catch { /* ignore */ }

  if (isolated) {
    mkdirSync(join(MC_ROOT, "versions", versionId, "mods"), { recursive: true });
  }

  return {
    content: [{
      type: "text",
      text: [
        `Installed Fabric ${mcVersion}`,
        `Fabric version: ${versionId}`,
        `Minecraft root: ${MC_ROOT}`,
        `Version isolation: ${isolated ? "ON" : "OFF"}`,
        isolated ? `  Game dir: ${MC_ROOT}\\versions\\${versionId}\\` : `  Game dir: ${MC_ROOT} (shared)`,
      ].join("\n"),
    }],
  };
}

async function handleInstallForge(args: any) {
  const mcVersion = args.minecraftVersion;
  const isolated = !!args.isolated;

  const list = await getVersionList();
  const versionMeta = list.versions.find((v: any) => v.id === mcVersion);
  if (!versionMeta) throw new Error(`Minecraft version ${mcVersion} not found`);

  await install(versionMeta, MC_ROOT);

  let forgeVersion = args.forgeVersion;
  if (!forgeVersion) {
    const forgeVersions: any[] = await getForgeVersionList({ minecraft: mcVersion }) as any;
    if (!forgeVersions || forgeVersions.length === 0) {
      throw new Error(`No Forge version available for Minecraft ${mcVersion}`);
    }
    const target = forgeVersions.find((v: any) => v.type === "Recommended") || forgeVersions[0];
    forgeVersion = target.version;
  }

  const versionId = await installForge(
    { mcversion: mcVersion, version: forgeVersion },
    MC_ROOT,
    { side: "client" }
  );

  if (isolated) {
    mkdirSync(join(MC_ROOT, "versions", versionId, "mods"), { recursive: true });
  }

  return {
    content: [{
      type: "text",
      text: [
        `Installed Forge ${mcVersion}`,
        `Forge version: ${forgeVersion}`,
        `Minecraft root: ${MC_ROOT}`,
        `Version isolation: ${isolated ? "ON" : "OFF"}`,
        isolated ? `  Game dir: ${MC_ROOT}\\versions\\${versionId}\\` : `  Game dir: ${MC_ROOT} (shared)`,
      ].join("\n"),
    }],
  };
}

async function handleListInstalled() {
  const versions = getInstalledVersions();

  const lines = [
    `Minecraft root: ${MC_ROOT}`,
    "",
    `Installed versions (${versions.length}):`,
  ];

  if (versions.length === 0) {
    lines.push("  (none)");
  }

  for (const v of versions) {
    const verDir = join(MC_ROOT, "versions", v);
    const isolated = isVersionIsolated(v);
    const hasMods = existsSync(join(verDir, "mods"));
    const hasConfig = existsSync(join(verDir, "config"));
    const hasSaves = existsSync(join(verDir, "saves"));

    let flags = "";
    if (isolated) flags = ` [${[
      hasMods ? "mods" : "",
      hasConfig ? "config" : "",
      hasSaves ? "saves" : "",
    ].filter(Boolean).join(",")}]`;

    lines.push(`  ${v}${flags}`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleScanJava() {
  const javas = await scanLocalJava([]);

  if (javas.length === 0) {
    return {
      content: [{ type: "text", text: "No Java installations found. Please install Java 17+." }],
    };
  }

  const lines = ["Found Java installations:"];
  for (const j of javas) {
    lines.push(`  ${j.path} - version ${j.version} (major: ${j.majorVersion})`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleLaunchMinecraft(args: any) {
  const versions = getInstalledVersions();
  if (versions.length === 0) {
    throw new Error("No versions installed. Use install_minecraft first.");
  }

  const versionId = args.version || (
    versions.includes(args.version) ? args.version : versions[0]
  );

  if (!versions.includes(versionId)) {
    throw new Error(`Version '${versionId}' is not installed. Available: ${versions.join(", ")}`);
  }

  const isolated = args.isolated ?? isVersionIsolated(versionId);
  const gDir = gameDir(versionId, isolated);

  if (runningProcesses.has(versionId)) {
    throw new Error(`Version '${versionId}' is already running. Stop it first.`);
  }

  let javaPath = args.javaPath;
  if (!javaPath) {
    const javas = await scanLocalJava([]);
    const suitable = javas.find((j: any) => j.majorVersion >= 17) || javas[0];
    if (!suitable) {
      throw new Error("No Java found. Install Java 17+ or specify javaPath.");
    }
    javaPath = suitable.path;
  }

  const child = await launch({
    version: versionId,
    resourcePath: MC_ROOT,
    gamePath: gDir,
    javaPath: javaPath,
    accessToken: "mcp-dev-token",
    userType: "mojang",
    gameProfile: {
      name: args.username || "DevPlayer",
      id: "00000000-0000-0000-0000-000000000000",
    },
    maxMemory: args.maxMemory || 2048,
    minMemory: args.minMemory,
    resolution: args.resolution,
    server: args.server,
    extraJVMArgs: args.extraJVMArgs,
    extraMCArgs: args.extraMCArgs,
  });

  const watcher = createMinecraftProcessWatcher(child);

  const procEntry: RunningProcess = {
    process: child,
    pid: child.pid!,
    launchTime: Date.now(),
  };
  runningProcesses.set(versionId, procEntry);

  watcher.on("minecraft-exit", (event: any) => {
    if (runningProcesses.has(versionId)) {
      const duration = ((Date.now() - runningProcesses.get(versionId)!.launchTime) / 1000).toFixed(1);
      console.error(`[minecraft-mcp] ${versionId} exited after ${duration}s (code: ${event.code})`);
      runningProcesses.delete(versionId);
    }
  });

  watcher.on("error", (err: any) => {
    runningProcesses.delete(versionId);
    console.error(`[minecraft-mcp] ${versionId} error:`, err);
  });

  return {
    content: [{
      type: "text",
      text: [
        `Launched Minecraft ${versionId}`,
        `PID: ${child.pid}`,
        `Java: ${javaPath}`,
        `Memory: ${args.maxMemory || 2048}MB`,
        `Username: ${args.username || "DevPlayer"}`,
        `Version isolation: ${isolated ? "ON" : "OFF"}`,
        ``,
        `Resource root (shared): ${MC_ROOT}`,
        `  ├─ assets/`,
        `  ├─ libraries/`,
        `  └─ versions/${versionId}/ (json + jar)`,
        ``,
        `Game directory: ${gDir}`,
        isolated
          ? `  ├─ mods/          ← isolated per-version`
          : `  ├─ mods/          ← shared with all versions`,
        isolated
          ? `  ├─ config/        ← isolated per-version`
          : `  ├─ config/        ← shared with all versions`,
        isolated
          ? `  ├─ saves/         ← isolated per-version`
          : `  ├─ saves/         ← shared with all versions`,
        isolated
          ? `  └─ resourcepacks/ ← isolated per-version`
          : `  └─ resourcepacks/ ← shared with all versions`,
        ``,
        `Use list_running to check status, stop_minecraft to kill it.`,
      ].join("\n"),
    }],
  };
}

async function handleStopMinecraft(args: any) {
  const versionId = args.version;
  const entry = runningProcesses.get(versionId);

  if (!entry) {
    return { content: [{ type: "text", text: `Version '${versionId}' is not running.` }] };
  }

  const pid = entry.pid;
  entry.process.kill("SIGTERM");
  setTimeout(() => {
    if (runningProcesses.has(versionId)) {
      try { entry.process.kill("SIGKILL"); } catch {}
      runningProcesses.delete(versionId);
    }
  }, 5000);

  return { content: [{ type: "text", text: `Stopped Minecraft version '${versionId}' (PID: ${pid})` }] };
}

async function handleListRunning() {
  if (runningProcesses.size === 0) {
    return { content: [{ type: "text", text: "No Minecraft instances currently running." }] };
  }

  const lines = ["Running instances:"];
  for (const [versionId, entry] of runningProcesses) {
    const uptime = ((Date.now() - entry.launchTime) / 1000).toFixed(1);
    lines.push(`  ${versionId} (PID: ${entry.pid}, uptime: ${uptime}s)`);
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

const LOG_HEAD_LINES = 5;

async function handleReadLog(args: any) {
  const versionId = args.version;
  const logType = args.type || "latest";
  const maxLines = args.lines;

  const logDir = versionId && isVersionIsolated(versionId)
    ? join(MC_ROOT, "versions", versionId, "logs")
    : join(MC_ROOT, "logs");

  if (logType === "all") {
    if (!existsSync(logDir)) {
      return { content: [{ type: "text", text: `No logs directory found at ${logDir}` }] };
    }
    const files = readdirSync(logDir, { withFileTypes: true }).map((e) => {
      const size = e.isFile() ? statSync(join(logDir, e.name)).size : 0;
      return `  ${e.name}${e.isDirectory() ? "/" : ""} (${size} bytes)`;
    });
    return {
      content: [{
        type: "text",
        text: [`Logs in ${logDir}:`, ...files].join("\n"),
      }],
    };
  }

  if (logType === "crash-report") {
    const crashDir = versionId && isVersionIsolated(versionId)
      ? join(MC_ROOT, "versions", versionId, "crash-reports")
      : join(MC_ROOT, "crash-reports");

    if (!existsSync(crashDir)) {
      return { content: [{ type: "text", text: "No crash-reports directory found." }] };
    }

    const reports = readdirSync(crashDir)
      .filter((f) => f.endsWith(".txt") || f.endsWith(".log"))
      .sort()
      .reverse();

    if (reports.length === 0) {
      return { content: [{ type: "text", text: "No crash reports found." }] };
    }

    const latestReport = join(crashDir, reports[0]);
    const content = readFileSync(latestReport, "utf-8");
    const lines = content.split(/\r?\n/);
    const tail = maxLines ? lines.slice(-maxLines) : lines;

    return {
      content: [{
        type: "text",
        text: [
          `Crash report: ${reports[0]}`,
          `Path: ${latestReport}`,
          `Total lines: ${lines.length}, showing ${tail.length}`,
          "",
          ...tail,
        ].join("\n"),
      }],
    };
  }

  const logFile = join(logDir, "latest.log");
  if (!existsSync(logFile)) {
    return { content: [{ type: "text", text: `latest.log not found at ${logFile}. Game may not have been launched yet.` }] };
  }

  const content = readFileSync(logFile, "utf-8");
  const lines = content.split(/\r?\n/);
  const tail = maxLines ? lines.slice(-maxLines) : lines;
  const headSummary = lines.length > tail.length
    ? `[${lines.length - tail.length} earlier lines omitted]`
    : "";

  return {
    content: [{
      type: "text",
      text: [
        `Log: ${logFile}`,
        `Total lines: ${lines.length}`,
        headSummary,
        "",
        ...tail,
      ].filter(Boolean).join("\n"),
    }],
  };
}

async function handleCopyMod(args: any) {
  const versionId = args.version;
  const sourcePath = resolve(args.sourcePath);

  if (!existsSync(sourcePath)) {
    throw new Error(`Mod file not found: ${sourcePath}`);
  }

  const isolated = isVersionIsolated(versionId);
  const modsDir = isolated
    ? join(MC_ROOT, "versions", versionId, "mods")
    : join(MC_ROOT, "mods");

  if (!existsSync(modsDir)) {
    mkdirSync(modsDir, { recursive: true });
  }

  const fileName = sourcePath.split(/[\\/]/).pop()!;
  cpSync(sourcePath, join(modsDir, fileName));

  return {
    content: [{
      type: "text",
      text: `Copied ${fileName} to mods/\nPath: ${join(modsDir, fileName)}\nVersion isolation: ${isolated ? "ON (per-version mods)" : "OFF (shared mods)"}`,
    }],
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[minecraft-mcp] Server running. MC root: ${MC_ROOT}`);
}

main().catch((err) => {
  console.error("[minecraft-mcp] Fatal error:", err);
  process.exit(1);
});
