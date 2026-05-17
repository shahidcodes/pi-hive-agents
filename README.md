# 🐝 pi-hive-agents

A pi coding agent extension that turns the main agent into an **orchestrator**, spawning specialized sub-agents in the background to parallelize complex tasks. Sub-agents run **in-process** via the pi SDK, enabling real-time steering, per-agent model selection, and live progress tracking.

## How It Works

```
User: "Build a full-stack app with auth, API, and dashboard"
        ↓
Main Agent (Orchestrator): analyzes task, delegates to specialists
        ↓
   hive_spawn([...])  ← returns immediately
        ↓
   ┌──────────────┬──────────────┬──────────────┐
   │ frontend-dev │  backend-dev │  auth-expert │
   │ (in-process) │  (in-process)│  (in-process)│
   │ model: gpt-5 │ model: sonnet│ model: haiku  │
   └──────────────┴──────────────┴──────────────┘
        ↓                              ↑
   hive_inbox          ←── check which agents finished, read results
   hive_steer          ←── send new instructions mid-task
   hive_followup       ←── queue instructions for after current work
        ↓
   Orchestrator synthesizes all results → delivers final answer
```

## Features

### Core
- **Non-blocking spawn** — `hive_spawn` returns immediately, agents run in background
- **SDK-based sub-agents** — agents run in-process via `createAgentSession()`, not as child processes
- **Orchestrator mode** — system prompt injected every turn tells the LLM to delegate, not do the work itself
- **Shared inbox** — `hive_inbox` tool to check agent progress and read full results

### Steering & Control
- **Mid-task steering** — `hive_steer` sends instructions to a running agent immediately (uses `session.steer()`)
- **Follow-up queuing** — `hive_followup` queues instructions for after the agent finishes current work (uses `session.followUp()`)
- **Per-agent model** — specify `model: "openai/gpt-5.4"` or `model: "claude-sonnet-4-5"` per agent
- **Per-agent thinking level** — specify `thinking: "xhigh"` for complex reasoning, `thinking: "off"` for simple tasks

### Live Monitoring
- **Live agent dashboard** — persistent widget shows all agents above the editor with current activity, model, and cost
- **Interactive viewer** — press `Ctrl+Shift+H` to browse agents, select one to see live output (auto-refreshes every second)
- **Streaming progress** — see what each agent is doing in real-time (tool calls, text output, current activity)

### Notifications
- **Completion notifications** — agents notify the orchestrator immediately when done via `pi.sendMessage({ deliverAs: "steer", triggerTurn: true })`
- **30s polling fallback** — background poll catches any missed notifications, auto-cleans up when all agents finish

## Tools

### `hive_spawn`

Spawn specialized sub-agents in the background. **Returns immediately** — agents run in parallel.

```json
{
  "agents": [
    {
      "name": "frontend-dev",
      "role": "Frontend React specialist",
      "systemPrompt": "You are an expert React developer...",
      "task": "Build the landing page component with responsive layout...",
      "model": "openai/gpt-5.4",
      "thinking": "medium"
    },
    {
      "name": "backend-dev",
      "role": "Express.js API designer",
      "systemPrompt": "You are a senior backend engineer...",
      "task": "Design and implement REST API routes for...",
      "model": "anthropic/claude-sonnet-4-5",
      "thinking": "high"
    },
    {
      "name": "researcher",
      "role": "Technical researcher",
      "systemPrompt": "You are a thorough technical researcher...",
      "task": "Research best practices for...",
      "model": "anthropic/claude-haiku-4",
      "thinking": "off"
    }
  ]
}
```

### `hive_inbox`

Check the shared inbox for agent results.

```
# Check all agents
hive_inbox({})

# Read a specific agent's full result
hive_inbox({ agent: "frontend-dev" })
```

### `hive_steer`

Sends an instruction to a running agent **immediately**. The agent stops what it's doing and follows the new direction.

**Use when:** You see the agent going in the wrong direction and need to correct it now.

```
hive_steer({
  agent: "frontend-dev",
  instruction: "Make this mobile-first. Start with 320px viewport and scale up."
})

hive_steer({
  agent: "backend-dev",
  instruction: "Switch to GraphQL instead. Define the schema with types for User, Post, and Comment."
})

hive_steer({
  agent: "researcher",
  instruction: "Focus on 2025-2026 resources only. Ignore anything before 2025."
})
```

### `hive_followup`

Queues an instruction that the agent will process **after** completing its current work. Use this to add tasks without interrupting the current flow.

**Use when:** The agent is on the right track but you want to add more work after it finishes.

```
hive_followup({
  agent: "frontend-dev",
  instruction: "After the layout is done, also add a dark mode toggle component."
})

hive_followup({
  agent: "backend-dev",
  instruction: "Once the routes are done, write integration tests for each endpoint."
})
```

### Steering vs Followup — Quick Guide

| Situation | Use | Why |
|-----------|-----|-----|
| Agent is going in the wrong direction | `hive_steer` | Stop it now, redirect |
| Agent needs additional requirements | `hive_followup` | Let it finish, then add more |
| Agent misunderstood the task | `hive_steer` | Clarify immediately |
| You thought of a bonus task | `hive_followup` | Queue it for after completion |
| Agent's output quality is poor | `hive_steer` | Correct the approach mid-flight |

## Commands & Shortcuts

| Key | Action |
|-----|--------|
| `/hive-mode on` | Enable orchestrator mode — main agent delegates via hive_spawn |
| `/hive-mode off` | Disable orchestrator mode — main agent works normally |
| `/hive-mode` | Show current orchestrator mode status |
| `/hive` | Open the agent dashboard |
| `/hive-kill` | Kill all running agents |
| `Ctrl+Shift+H` | Quick view of running agents |

### Orchestrator Mode

By default, **orchestrator mode is OFF**. The main agent works normally — the hive tools are available but it won't be forced to delegate.

- **Quick tasks** — just type normally, the main agent handles it directly
- **Complex tasks** — the main agent can still choose to use `hive_spawn` based on the tool descriptions
- **Strict delegation** — run `/hive-mode on` to force the main agent to always delegate to sub-agents

The mode resets to `off` on every new session.

## Per-Agent Model & Thinking

Each agent can use its own model and thinking level:

| Field | Format | Example |
|-------|--------|---------|
| `model` | `"provider/id"` or just `"id"` | `"openai/gpt-5.4"`, `"claude-sonnet-4-5"` |
| `thinking` | Level string | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |

**Model resolution:**
- `"openai/gpt-5.4"` → looks for `gpt-5.4` on the `openai` provider
- `"claude-sonnet-4-5"` → searches all available providers for a match
- If the model isn't found, the agent falls back to the default

**Cost optimization tip:** Use cheaper models (haiku) for research/scouting, smarter models (sonnet/opus) for complex reasoning and code generation.

## Architecture

```
┌─────────────────────────────────────────┐
│           Main pi Session               │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │ Orchestrator Agent                │  │
│  │ (system prompt injected per turn) │  │
│  └───────────────────────────────────┘  │
│           ↕ tools                       │
│  ┌────────────┬────────────┬─────────┐  │
│  │ Agent SDK  │ Agent SDK  │ SDK     │  │
│  │ Session 1  │ Session 2  │ Session3│  │
│  │ (in-proc)  │ (in-proc)  │ (in-proc)  │
│  └────────────┴────────────┴─────────┘  │
│                                         │
│  Widget: live status above editor       │
│  Poll: 30s check for missed completions │
│  Notify: pi.sendMessage() on completion │
└─────────────────────────────────────────┘
```

- **In-process SDK sessions** — each sub-agent is an `AgentSession` created via `createAgentSession()`, running in the same process
- **Real-time event subscription** — `session.subscribe()` captures tool calls, streaming text, and completion events
- **Steering** — `session.steer()` and `session.followUp()` enable mid-task course correction
- **System prompt injection** via `before_agent_start` makes the main agent a pure orchestrator
- **Completion notifications** via `pi.sendMessage({ deliverAs: "steer", triggerTurn: true })`
- **30s background polling** catches missed notifications, auto-cleans up when all agents finish

## Installation

```bash
# Project-local
cp -r src .pi/extensions/hive-agent/

# Or global
cp -r src ~/.pi/agent/extensions/hive-agent/

# Or direct load
pi -e ./src/index.ts
```

## Orchestrator System Prompt

Every turn, the extension injects:

```
## 🐝 HIVE ORCHESTRATOR MODE

You are a pure ORCHESTRATOR — you do NOT do the work yourself.

1. Delegate work via hive_spawn
2. Monitor via hive_inbox
3. Steer running agents via hive_steer
4. Queue follow-ups via hive_followup
5. Synthesize results and deliver final answer

### Current Hive Status
| Total spawned | 3 |
| Running | 1 |
| Completed | 2 |

### Running Agents
  - `backend-dev` (Express API): ⏳ read: src/routes/api.ts

### Completed (results in inbox)
  - `frontend-dev` (React UI): ✅ result ready — use hive_inbox to read
  - `auth-expert` (Auth flow): ✅ result ready — use hive_inbox to read
```

This ensures the LLM **always** knows its role, which agents are running, which have completed, and what tools are available for steering.
