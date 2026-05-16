/**
 * Hive Agent Extension for pi
 *
 * Spawns specialized sub-agents in the background to parallelize work.
 * The main LLM decides what agents to spawn and defines their roles,
 * system prompts, and tasks dynamically.
 *
 * Usage:
 *   The LLM calls the hive_spawn tool with agent definitions.
 *   Each agent runs as a separate pi --mode json process.
 *
 * Commands:
 *   /hive        - Open the agent dashboard selector
 *   /hive-kill   - Kill all running agents
 *
 * Shortcut:
 *   Ctrl+Shift+H - Quick view of running agents
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getMarkdownTheme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  matchesKey,
  Key,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types ────────────────────────────────────────────────────────────────

type AgentStatus = "spawning" | "running" | "done" | "failed" | "cancelled";

interface AgentJob {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  task: string;
  status: AgentStatus;
  messages: Message[];
  stderr: string;
  /** What the agent is doing right now (e.g., "bash: npm install", "reading: src/index.ts") */
  currentActivity: string;
  /** Streaming text output (accumulated during the current assistant message) */
  streamingText: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
  };
  model?: string;
  startedAt: number;
  endedAt?: number;
  process?: ChildProcess;
}

interface AgentDefinitionInput {
  name: string;
  role: string;
  systemPrompt: string;
  task: string;
  cwd?: string;
}

// ─── Globals ──────────────────────────────────────────────────────────────

const agents = new Map<string, AgentJob>();
let nextId = 0;
let savedCtx: any = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let notifiedIds = new Set<string>();

// ─── Helpers ──────────────────────────────────────────────────────────────

function generateId(): string {
  return `hive-${nextId++}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: AgentJob["usage"], model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns}t`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function getElapsed(job: AgentJob): string {
  const end = job.endedAt ?? Date.now();
  return formatDuration(end - job.startedAt);
}

function statusIcon(status: AgentStatus): string {
  switch (status) {
    case "spawning":
    case "running":
      return "⏳";
    case "done":
      return "✅";
    case "failed":
      return "❌";
    case "cancelled":
      return "⏹️";
  }
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

async function writeSystemPrompt(
  name: string,
  content: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-hive-"));
  const safeName = name.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, content, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir: tmpDir, filePath };
}

function cleanupTemp(dir: string | null, file: string | null) {
  if (file) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
  if (dir) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
}

// ─── Widget ───────────────────────────────────────────────────────────────

/**
 * Set or update the persistent widget showing agent status.
 * The widget function reads from the global `agents` map on every render,
 * so it always shows current data whenever the TUI re-renders.
 */
function updateWidget() {
  if (!savedCtx || !savedCtx.hasUI) return;
  if (agents.size === 0) {
    savedCtx.ui.setWidget("hive-agents", undefined);
    return;
  }

  savedCtx.ui.setWidget("hive-agents", (_tui: any, theme: any) => {
    const jobs = Array.from(agents.values());
    const running = jobs.filter(
      (j) => j.status === "running" || j.status === "spawning",
    );
    const done = jobs.filter((j) => j.status === "done");
    const failed = jobs.filter(
      (j) => j.status === "failed" || j.status === "cancelled",
    );
    const totalCost = jobs.reduce((s, j) => s + j.usage.cost, 0);

    const lines: string[] = [];

    // Summary header
    const summary = theme.fg("accent", theme.bold("🐝 Hive"));
    const statusSummary =
      theme.fg("dim", `  ${running.length} running · ${done.length} done · ${failed.length} failed`);
    const costStr =
      totalCost > 0 ? theme.fg("dim", `  $${totalCost.toFixed(4)}`) : "";
    const hint = theme.fg("dim", "  [Ctrl+Shift+H to view]");
    lines.push(summary + statusSummary + costStr + hint);

    // Per-agent lines
    for (const job of jobs) {
      const icon = statusIcon(job.status);
      const statusColor =
        job.status === "running" || job.status === "spawning"
          ? "warning"
          : job.status === "done"
            ? "success"
            : "error";
      const nameStr = theme.fg(
        statusColor,
        `${icon} ${theme.bold(job.name)}`,
      );
      const roleStr = theme.fg("muted", `(${job.role})`);
      const elapsedStr = theme.fg("dim", getElapsed(job));
      const jobCost =
        job.usage.cost > 0
          ? theme.fg("dim", `$${job.usage.cost.toFixed(4)}`)
          : "";
      // Show current activity for running agents
      const activityStr =
        job.status === "running" || job.status === "spawning"
          ? `  ${theme.fg("dim", `› ${job.currentActivity}`)}`
          : "";

      lines.push(`   ${nameStr} ${roleStr}  ${elapsedStr} ${jobCost}${activityStr}`);
    }

    return {
      render: () => lines,
      invalidate: () => {},
    };
  });
}

// ─── Spawn a single agent ─────────────────────────────────────────────────

async function spawnAgentJob(
  cwd: string,
  job: AgentJob,
  signal: AbortSignal | undefined,
): Promise<void> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  let tmpDir: string | null = null;
  let tmpPath: string | null = null;

  try {
    const systemPromptFull =
      `You are a specialized agent with this role: ${job.role}\n\n${job.systemPrompt}`;
    const tmp = await writeSystemPrompt(job.name, systemPromptFull);
    tmpDir = tmp.dir;
    tmpPath = tmp.filePath;
    args.push("--append-system-prompt", tmpPath);
    args.push(job.task);

    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    job.status = "running";
    job.process = proc;
    job.currentActivity = "waiting for model…";
    updateWidget();

    let buffer = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      // Tool call started — update current activity
      if (event.type === "tool_execution_start" && event.message) {
        const msg = event.message;
        const toolCall = msg.content?.find(
          (c: any) => c.type === "tool_use",
        );
        if (toolCall) {
          const toolName = toolCall.name || "unknown";
          const input = toolCall.input || {};
          // Build a human-readable activity string
          let activity = toolName;
          if (toolName === "bash" && input.command) {
            const cmd =
              input.command.length > 50
                ? input.command.slice(0, 50) + "…"
                : input.command;
            activity = `bash: $ ${cmd}`;
          } else if (toolName === "read" && input.path) {
            activity = `read: ${input.path}`;
          } else if (toolName === "write" && input.path) {
            activity = `write: ${input.path}`;
          } else if (toolName === "edit" && input.path) {
            activity = `edit: ${input.path}`;
          } else if (toolName === "grep" && input.pattern) {
            activity = `grep: /${input.pattern}/`;
          } else if (toolName === "find" && input.pattern) {
            activity = `find: ${input.pattern}`;
          } else if (toolName === "ls" && input.path) {
            activity = `ls: ${input.path}`;
          }
          job.currentActivity = activity;
          job.messages.push(msg);
          updateWidget();
        }
      }

      // Tool result — add to messages
      if (event.type === "tool_result_end" && event.message) {
        job.messages.push(event.message as Message);
        updateWidget();
      }

      // Streaming text output
      if (event.type === "message_update" && event.message) {
        const delta = event.message.content?.find(
          (c: any) => c.type === "text" && c.text,
        );
        if (delta) {
          job.streamingText += delta.text;
          // Show first 80 chars of streaming output as activity
          const preview = job.streamingText.slice(0, 80).replace(/\n/g, " ");
          if (!job.currentActivity.startsWith("bash:") && !job.currentActivity.startsWith("read:") && !job.currentActivity.startsWith("write:")) {
            job.currentActivity = preview ? `typing: ${preview}…` : "thinking…";
          }
          updateWidget();
        }
      }

      // Assistant message completed
      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message;
        job.messages.push(msg);
        // Clear streaming text for next turn
        job.streamingText = "";
        job.currentActivity = "thinking…";
        if (msg.role === "assistant") {
          job.usage.turns++;
          const usage = msg.usage;
          if (usage) {
            job.usage.input += usage.input || 0;
            job.usage.output += usage.output || 0;
            job.usage.cacheRead += usage.cacheRead || 0;
            job.usage.cacheWrite += usage.cacheWrite || 0;
            job.usage.cost += usage.cost?.total || 0;
            job.usage.contextTokens = usage.totalTokens || 0;
          }
          if (!job.model && msg.model) job.model = msg.model;
        }
        updateWidget();
      }

      // Agent started
      if (event.type === "agent_start") {
        job.currentActivity = "starting…";
        updateWidget();
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data: Buffer) => {
      job.stderr += data.toString();
    });

    proc.on("close", (code: number | null) => {
      if (buffer.trim()) processLine(buffer);
      job.status = code === 0 ? "done" : "failed";
      job.endedAt = Date.now();
      job.process = undefined;
      cleanupTemp(tmpDir, tmpPath);
      updateWidget();
      // Notify orchestrator immediately
      notifiedIds.add(job.id);
      notifyOrchestrator(job);
    });

    proc.on("error", () => {
      job.status = "failed";
      job.endedAt = Date.now();
      job.process = undefined;
      cleanupTemp(tmpDir, tmpPath);
      updateWidget();
      notifiedIds.add(job.id);
      notifyOrchestrator(job);
    });

    if (signal) {
      const killProc = () => {
        job.status = "cancelled";
        job.endedAt = Date.now();
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
        cleanupTemp(tmpDir, tmpPath);
        updateWidget();
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  } catch (err) {
    job.status = "failed";
    job.endedAt = Date.now();
    job.stderr = String(err);
    cleanupTemp(tmpDir, tmpPath);
    updateWidget();
  }
}

// ─── Orchestrator Notifications & Polling ─────────────────────────────────

/**
 * Send a notification message to the orchestrator (main agent) via pi.sendMessage().
 * This injects a message into the main agent's conversation so it knows an agent finished.
 */
function notifyOrchestrator(job: AgentJob) {
  if (!savedCtx || !savedCtx.hasUI) return;

  const output = getFinalOutput(job.messages);
  const preview = output.length > 500 ? output.slice(0, 500) + "…" : output || "(no output)";

  pi.sendMessage(
    {
      customType: "hive-notification",
      content: `🐝 Agent **${job.name}** (${job.role}) has **${job.status}**.\n\n**Task:** ${job.task}\n\n**Output:**\n${preview}\n\nUse \`hive_inbox\` to read the full result.`,
      display: true,
      details: {
        agentName: job.name,
        agentRole: job.role,
        status: job.status,
      },
    },
    { deliverAs: "steer", triggerTurn: true },
  );
}

/**
 * Check all agents and notify the orchestrator about newly completed agents.
 */
function pollAgentStatus() {
  const allAgents = Array.from(agents.values());
  const running = allAgents.filter(
    (j) => j.status === "running" || j.status === "spawning",
  );
  const newlyDone = allAgents.filter(
    (j) => (j.status === "done" || j.status === "failed") && !notifiedIds.has(j.id),
  );

  // Notify orchestrator about newly completed agents
  for (const job of newlyDone) {
    notifiedIds.add(job.id);
    notifyOrchestrator(job);
  }

  // If all agents are done, stop polling
  if (allAgents.length > 0 && running.length === 0) {
    stopPolling();
    savedCtx?.ui.notify("All hive agents have completed.", "info");
  }
}

/**
 * Start the 30s polling loop.
 */
function startPolling(ctx: any) {
  stopPolling(); // Clear any existing timer
  pollTimer = setInterval(() => {
    pollAgentStatus();
  }, 30_000);
}

/**
 * Stop the polling loop.
 */
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ─── Agent Selector Component ─────────────────────────────────────────────

function createAgentSelector(
  theme: any,
  tui: any,
  onSelect: (job: AgentJob) => void,
  onCancel: () => void,
) {
  const jobs = Array.from(agents.values());

  if (jobs.length === 0) {
    return {
      render(width: number): string[] {
        const line = truncateToWidth(
          theme.fg("muted", "  No active agents. Use hive_spawn to spawn agents."),
          width,
        );
        return ["", line, ""];
      },
      invalidate() {},
      handleInput(data: string) {
        if (
          matchesKey(data, Key.enter) ||
          matchesKey(data, Key.escape) ||
          matchesKey(data, "ctrl+c")
        ) {
          onCancel();
        }
      },
    };
  }

  const items: SelectItem[] = jobs.map((job) => ({
    value: job.id,
    label: `${statusIcon(job.status)} ${job.name}`,
    description: `${job.role} · ${job.status} · ${getElapsed(job)}${job.usage.cost > 0 ? ` · $${job.usage.cost.toFixed(4)}` : ""}`,
  }));

  const container = new Container();
  container.addChild(
    new Text(theme.fg("accent", theme.bold("🐝 Hive Agent Dashboard")), 1, 0),
  );
  container.addChild(new Spacer(1));

  const selectList = new SelectList(
    items,
    Math.min(items.length, 10),
    {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    },
  );

  selectList.onSelect = (item) => {
    const job = agents.get(item.value);
    if (job) onSelect(job);
  };
  selectList.onCancel = () => onCancel();

  container.addChild(selectList);
  container.addChild(
    new Text(
      theme.fg("dim", "↑↓ navigate  ·  enter view  ·  esc cancel"),
      1,
      0,
    ),
  );

  return {
    render(width: number): string[] {
      return container.render(width);
    },
    invalidate() {
      container.invalidate();
    },
    handleInput(data: string) {
      selectList.handleInput(data);
      tui.requestRender();
    },
  };
}

// ─── Agent Viewer Component ───────────────────────────────────────────────

function createAgentViewer(
  job: AgentJob,
  theme: any,
  tui: any,
  onBack: () => void,
) {
  // For running agents, auto-refresh every 1s
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  if (job.status === "running" || job.status === "spawning") {
    refreshTimer = setInterval(() => {
      tui.requestRender();
    }, 1000);
  }

  return {
    render(width: number): string[] {
      // Rebuild from scratch on every render — always shows live data
      const container = new Container();

      // Header
      const icon = statusIcon(job.status);
      const header = `${icon} ${theme.fg("accent", theme.bold(job.name))} — ${theme.fg("muted", job.role)}`;
      container.addChild(new Text(header, 1, 0));

      // Status bar with live activity
      const statusLine = `Status: ${job.status}  ·  Elapsed: ${getElapsed(job)}`;
      const usageLine = formatUsage(job.usage, job.model);
      const activityLine =
        (job.status === "running" || job.status === "spawning")
          ? theme.fg("warning", `  ▶ ${job.currentActivity}`)
          : "";
      container.addChild(
        new Text(
          theme.fg("dim", `${statusLine}  ·  ${usageLine}`) + activityLine,
          1,
          0,
        ),
      );
      container.addChild(new Spacer(1));

      // Task
      container.addChild(new Text(theme.fg("muted", "─── Task ───"), 1, 0));
      container.addChild(new Text(theme.fg("dim", job.task), 1, 0));
      container.addChild(new Spacer(1));

      // Output — streaming text for running agents
      container.addChild(new Text(theme.fg("muted", "─── Output ───"), 1, 0));

      if (job.streamingText && (job.status === "running" || job.status === "spawning")) {
        const mdTheme = getMarkdownTheme();
        container.addChild(new Markdown(job.streamingText.trim(), 1, 0, mdTheme));
      }

      // Completed output
      const finalOutput = getFinalOutput(job.messages);
      if (finalOutput) {
        const mdTheme = getMarkdownTheme();
        if (job.streamingText && (job.status === "running" || job.status === "spawning")) {
          container.addChild(new Text(theme.fg("dim", "─── completed turns ───"), 1, 0));
        }
        container.addChild(new Markdown(finalOutput.trim(), 1, 0, mdTheme));
      } else if (!job.streamingText) {
        container.addChild(
          new Text(theme.fg("muted", "(no output yet)"), 1, 0),
        );
      }

      // Tool call history
      const toolCalls = job.messages.filter(
        (m: Message) =>
          m.role === "assistant" &&
          m.content?.some((c: any) => c.type === "tool_use"),
      );
      if (toolCalls.length > 0) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", `─── Tool Calls (${toolCalls.length} turns) ───`), 1, 0),
        );
        for (const msg of toolCalls) {
          for (const content of msg.content) {
            if (content.type === "tool_use") {
              const toolName = content.name || "unknown";
              const input = content.input || {};
              let detail = "";
              if (toolName === "bash" && input.command) {
                detail = input.command.length > 60
                  ? input.command.slice(0, 60) + "…"
                  : input.command;
              } else if (input.path) {
                detail = input.path;
              } else if (input.pattern) {
                detail = input.pattern;
              }
              container.addChild(
                new Text(
                  theme.fg("dim", `  → ${toolName}`) +
                  (detail ? theme.fg("muted", ` ${detail}`) : ""),
                  1,
                  0,
                ),
              );
            }
          }
        }
      }

      // Stderr
      if (job.stderr) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg("muted", "─── Stderr ───"), 1, 0),
        );
        const stderrPreview =
          job.stderr.length > 300
            ? job.stderr.slice(0, 300) + "..."
            : job.stderr;
        container.addChild(
          new Text(theme.fg("error", stderrPreview), 1, 0),
        );
      }

      container.addChild(new Spacer(1));
      const backHint = theme.fg("dim", "esc / backspace — back to agent list");
      const liveHint =
        job.status === "running" || job.status === "spawning"
          ? " " + theme.fg("warning", "[live]")
          : "";
      container.addChild(new Text(backHint + liveHint, 1, 0));

      return container.render(width);
    },
    invalidate() {},
    handleInput(data: string) {
      if (
        matchesKey(data, Key.escape) ||
        matchesKey(data, Key.backspace) ||
        matchesKey(data, "ctrl+c")
      ) {
        if (refreshTimer) clearInterval(refreshTimer);
        onBack();
      }
    },
  };
}

// ─── Tool Schema ──────────────────────────────────────────────────────────

const AgentDefinitionSchema = Type.Object({
  name: Type.String({
    description:
      "Short unique name for this agent (e.g., frontend-expert, backend-scout, security-auditor)",
  }),
  role: Type.String({
    description:
      "One-line description of this agent's expertise (e.g., 'Frontend UI/UX specialist')",
  }),
  systemPrompt: Type.String({
    description:
      "Detailed system prompt defining the agent's behavior, expertise, constraints, and output format. Be specific about what this agent should do and how. This replaces the default assistant instructions for this agent.",
  }),
  task: Type.String({
    description:
      "The specific task or question for this agent. Include relevant context, file paths, requirements, and expected output format.",
  }),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for this agent (defaults to current project root)",
    }),
  ),
});

const HiveSpawnParams = Type.Object({
  agents: Type.Array(AgentDefinitionSchema, {
    description:
      "Array of specialized agent definitions. Define each agent's name, role, system prompt, and specific task. Agents run in parallel with isolated context windows. Think about what specialized roles would best parallelize this work.",
    minItems: 1,
    maxItems: 8,
  }),
});

// ─── Dashboard ────────────────────────────────────────────────────────────

async function showHiveDashboard(ctx: any): Promise<void> {
  if (agents.size === 0) {
    ctx.ui.notify("No agents running. Use hive_spawn to spawn agents.", "info");
    return;
  }

  // Phase 1: Show agent selector
  const selectedJob = await new Promise<AgentJob | null>((resolve) => {
    ctx.ui.custom<AgentJob | null>(
      (tui, theme, _kb, done) =>
        createAgentSelector(
          theme,
          tui,
          (job) => done(job),
          () => done(null),
        ),
      { overlay: true },
    );
  });

  if (!selectedJob) return;

  // Phase 2: Show agent detail viewer with live updates
  await new Promise<void>((resolve) => {
    ctx.ui.custom<void>(
      (tui, theme, _kb, done) => {
        const component = createAgentViewer(selectedJob, theme, tui, () =>
          done(),
        );
        return component;
      },
      { overlay: true },
    );
  });
}

// ─── Extension ────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    savedCtx = ctx;

    // Kill any stale agents from previous session
    for (const job of agents.values()) {
      if (job.process) {
        try {
          job.process.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
    agents.clear();
    nextId = 0;
    notifiedIds.clear();

    // Start the 30s polling loop
    startPolling(ctx);

    updateWidget();
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    // Kill all running agents
    for (const job of agents.values()) {
      if (job.process) {
        try {
          job.process.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
    // Stop polling
    stopPolling();
  });

  // ── Inject orchestrator system prompt every turn ──────────────────────

  pi.on("before_agent_start", async (event, _ctx) => {
    const running = Array.from(agents.values()).filter(
      (j) => j.status === "running" || j.status === "spawning",
    );
    const completed = Array.from(agents.values()).filter(
      (j) => j.status === "done",
    );

    const runningLines =
      running.length > 0
        ? running
            .map((j) => `  - \`${j.name}\` (${j.role}): ⏳ ${j.currentActivity}`)
            .join("\n")
        : "  (none)";
    const completedLines =
      completed.length > 0
        ? completed
            .map(
              (j) =>
                `  - \`${j.name}\` (${j.role}): ✅ result ready — use hive_inbox to read`,
            )
            .join("\n")
        : "  (none yet)";

    const orchestratorPrompt = `

## 🐝 HIVE ORCHESTRATOR MODE

You are a pure ORCHESTRATOR — you do NOT do the work yourself. Your job:

1. **Delegate** the user's request to specialized agents via \`hive_spawn\`.
2. **Monitor** progress via \`hive_inbox\` — check which agents have finished.
3. **Synthesize** completed agent results and deliver the final answer.

### Rules
- NEVER do work you assigned to an agent. Delegate it.
- After \`hive_spawn\` returns, call \`hive_inbox\` to check for completed results.
- Once all agents are done, read every result and produce a single synthesized answer.
- If agents are still running you may call \`hive_inbox\` again, or wait.
- NEVER duplicate work an agent already completed.

### Current Hive Status
| | Count |
|---|---|
| Total spawned | ${agents.size} |
| Running | ${running.length} |
| Completed | ${completed.length} |

### Running Agents
${runningLines}

### Completed (results in inbox)
${completedLines}
`;

    return {
      systemPrompt: event.systemPrompt + orchestratorPrompt,
    };
  });

  // ── Register the hive_spawn tool ──────────────────────────────────────

  pi.registerTool({
    name: "hive_spawn",
    label: "Hive Spawn Agents",
    description: [
      "Spawn specialized sub-agents to work in the BACKGROUND. Returns IMMEDIATELY — agents keep running.",
      "Define each agent's name, role, system prompt, and task.",
      "After spawning, use hive_inbox to check which agents have finished and read their results.",
      "You are the ORCHESTRATOR — delegate, monitor via inbox, and synthesize.",
    ].join(" "),
    promptGuidelines: [
      "hive_spawn returns immediately. Agents run in the background.",
      "Call hive_inbox after spawning to check for completed results.",
      "Once all agents report, read every result and SYNTHESIZE a final answer.",
      "NEVER redo work an agent already completed.",
    ],
    parameters: HiveSpawnParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const agentDefs: AgentDefinitionInput[] = params.agents;

      for (const def of agentDefs) {
        const id = generateId();
        const job: AgentJob = {
          id,
          name: def.name,
          role: def.role,
          systemPrompt: def.systemPrompt,
          task: def.task,
          status: "spawning",
          messages: [],
          stderr: "",
          currentActivity: "initializing…",
          streamingText: "",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
          startedAt: Date.now(),
        };
        agents.set(id, job);

        // Spawn each agent in background (non-blocking)
        spawnAgentJob(ctx.cwd, job, undefined).catch((err) => {
          job.status = "failed";
          job.stderr = String(err);
          job.endedAt = Date.now();
          updateWidget();
        });
      }

      updateWidget();

      const names = agentDefs.map((a) => a.name).join(", ");
      return {
        content: [
          {
            type: "text",
            text: [
              `✅ ${agentDefs.length} agent(s) spawned in background: ${names}`,
              "",
              "Agents are running. Use `hive_inbox` to check progress and read results.",
            ].join("\n"),
          },
        ],
        details: {
          spawned: agentDefs.map((a) => ({ name: a.name, role: a.role })),
        },
      };
    },

    renderCall(args: any, theme: any) {
      let text =
        theme.fg("toolTitle", theme.bold("hive_spawn ")) +
        theme.fg("accent", `${args.agents.length} agents (background)`);
      for (const agent of args.agents) {
        const preview =
          agent.task.length > 50
            ? agent.task.slice(0, 50) + "…"
            : agent.task;
        text += `\n  ${theme.fg("accent", agent.name)} ${theme.fg("muted", `(${agent.role})`)} — ${theme.fg("dim", preview)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result: any, _options: any, theme: any) {
      const details = result.details as
        | { spawned: Array<{ name: string; role: string }> }
        | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(
          text?.type === "text" ? text.text : "(no output)",
          0,
          0,
        );
      }

      const container = new Container();
      container.addChild(
        new Text(
          theme.fg("success", theme.bold("✅ agents spawned (running in background)")),
          0,
          0,
        ),
      );
      for (const agent of details.spawned) {
        const job = Array.from(agents.values()).find((j) => j.name === agent.name);
        const icon = job ? statusIcon(job.status) : "⏳";
        container.addChild(
          new Text(
            `  ${icon} ${theme.fg("accent", agent.name)} ${theme.fg("muted", `(${agent.role})`)}`,
            0,
            0,
          ),
        );
      }
      return container;
    },
  });

  // ── Register the hive_inbox tool ──────────────────────────────────────

  pi.registerTool({
    name: "hive_inbox",
    label: "Hive Inbox — Check Agent Results",
    description: [
      "Check the shared inbox for completed agent results.",
      "Shows which agents are still running, which have finished, and their full output.",
      "Call this after hive_spawn to read agent results.",
    ].join(" "),
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({
          description:
            "Name of a specific agent to read. If omitted, shows status of all agents.",
        }),
      ),
    }),
    promptGuidelines: [
      "Call hive_inbox after hive_spawn to check for completed results.",
      "Once all agents report done, read every result and SYNTHESIZE a final answer for the user.",
      "NEVER redo work an agent already completed.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const filterName = (params as any).agent as string | undefined;
      const allAgents = Array.from(agents.values());

      if (filterName) {
        // Return single agent's full result
        const job = allAgents.find((j) => j.name === filterName);
        if (!job) {
          return {
            content: [
              {
                type: "text",
                text: `No agent named "${filterName}". Use hive_inbox without a name to see all agents.`,
              },
            ],
            details: {},
          };
        }

        const output = getFinalOutput(job.messages);
        const resultText = [
          `## Agent: ${job.name} (${job.role})`,
          `Status: ${job.status}`,
          `Elapsed: ${getElapsed(job)}`,
          `Usage: ${formatUsage(job.usage, job.model)}`,
          `Current activity: ${job.currentActivity}`,
          "",
          "---",
          "",
          output || "(no output produced yet)",
        ].join("\n");

        return {
          content: [{ type: "text", text: resultText }],
          details: {
            agent: {
              name: job.name,
              status: job.status,
              cost: job.usage.cost,
            },
          },
        };
      }

      // Return inbox summary of all agents
      const running = allAgents.filter(
        (j) => j.status === "running" || j.status === "spawning",
      );
      const completed = allAgents.filter((j) => j.status === "done");
      const failed = allAgents.filter(
        (j) => j.status === "failed" || j.status === "cancelled",
      );
      const totalCost = allAgents.reduce((s, j) => s + j.usage.cost, 0);

      const sections: string[] = [];
      sections.push(
        `## 🐝 Hive Inbox: ${completed.length} done, ${running.length} running, ${failed.length} failed | Total cost: $${totalCost.toFixed(4)}`,
      );
      sections.push("");

      if (running.length > 0) {
        sections.push("### ⏳ Still Running");
        for (const job of running) {
          sections.push(
            `**${job.name}** (${job.role}) — ${job.currentActivity} | ${getElapsed(job)} | $${job.usage.cost.toFixed(4)}`,
          );
        }
        sections.push("");
      }

      if (failed.length > 0) {
        sections.push("### ❌ Failed / Cancelled");
        for (const job of failed) {
          sections.push(
            `**${job.name}** (${job.role}) — ${job.status} | ${getElapsed(job)}`,
          );
          if (job.stderr) {
            sections.push(`Stderr: ${job.stderr.slice(0, 300)}`);
          }
        }
        sections.push("");
      }

      if (completed.length > 0) {
        sections.push("### ✅ Completed — Full Results Below");
        sections.push("");
        for (const job of completed) {
          const output = getFinalOutput(job.messages);
          sections.push(`--- **${job.name}** (${job.role}) ---`);
          sections.push(`Task: ${job.task}`);
          sections.push(`Usage: ${formatUsage(job.usage, job.model)}`);
          sections.push("");
          sections.push(output || "(no output produced)");
          sections.push("");
        }
      }

      if (allAgents.length === 0) {
        sections.push("No agents spawned yet. Use hive_spawn to delegate work.");
      }

      return {
        content: [{ type: "text", text: sections.join("\n") }],
        details: {
          summary: {
            total: allAgents.length,
            running: running.length,
            completed: completed.length,
            failed: failed.length,
            allDone: running.length === 0 && allAgents.length > 0,
          },
        },
      };
    },

    renderCall(_args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("hive_inbox ")) +
          theme.fg("accent", "checking agent results"),
        0,
        0,
      );
    },

    renderResult(result: any, _options: any, theme: any) {
      const details = result.details as
        | { summary?: { total: number; running: number; completed: number; failed: number; allDone: boolean }; agent?: { name: string; status: string; cost: number } }
        | undefined;

      if (!details) {
        return new Text(result.content[0]?.text || "(no output)", 0, 0);
      }

      const container = new Container();

      if (details.agent) {
        // Single agent view
        const icon = statusIcon(details.agent.status as AgentStatus);
        container.addChild(
          new Text(
            `${icon} ${theme.fg("accent", theme.bold(details.agent.name))} — ${theme.fg("dim", details.agent.status)}`,
            0,
            0,
          ),
        );
      } else if (details.summary) {
        // Summary view
        const s = details.summary;
        const statusText = s.allDone
          ? theme.fg("success", "all done")
          : `${s.running} running`;
        container.addChild(
          new Text(
            theme.fg("toolTitle", theme.bold("hive_inbox")) +
              theme.fg("dim", `  ${s.total} agents — ${statusText}`),
            0,
            0,
          ),
        );
      }

      return container;
    },
  });

  // ── Register /hive command ────────────────────────────────────────────

  pi.registerCommand("hive", {
    description: "Open the Hive agent dashboard",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Hive dashboard requires interactive mode", "warning");
        return;
      }
      await showHiveDashboard(ctx);
    },
  });

  // ── Register /hive-kill command ───────────────────────────────────────

  pi.registerCommand("hive-kill", {
    description: "Kill all running hive agents",
    handler: async (_args, ctx) => {
      let killed = 0;
      for (const job of agents.values()) {
        if (
          (job.status === "running" || job.status === "spawning") &&
          job.process
        ) {
          job.process.kill("SIGTERM");
          job.status = "cancelled";
          job.endedAt = Date.now();
          killed++;
        }
      }
      ctx.ui.notify(
        killed > 0
          ? `Killed ${killed} running agent${killed > 1 ? "s" : ""}`
          : "No running agents to kill",
        "info",
      );
      updateWidget();
    },
  });

  // ── Register shortcut ─────────────────────────────────────────────────

  pi.registerShortcut("ctrl+shift+h", {
    description: "Quick view of running hive agents",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      await showHiveDashboard(ctx);
    },
  });
}
