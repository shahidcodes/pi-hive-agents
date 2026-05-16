# 🐝 pi-hive-agents

A pi coding agent extension that turns the main agent into an **orchestrator**, spawning specialized sub-agents in the background to parallelize complex tasks.

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
   │ (background) │  (background)│  (background)│
   └──────────────┴──────────────┴──────────────┘
        ↓
   hive_inbox        ← check which agents finished, read results
        ↓
   Orchestrator synthesizes all results → delivers final answer
```

## Features

- **Non-blocking spawn** — `hive_spawn` returns immediately, agents run in background
- **Orchestrator mode** — system prompt injected every turn tells the LLM to delegate, not do the work itself
- **Shared inbox** — `hive_inbox` tool to check agent progress and read full results
- **Live agent dashboard** — persistent widget shows all agents above the editor with current activity
- **Interactive viewer** — press `Ctrl+Shift+H` to browse agents, select one to see live output (auto-refreshes every second)
- **Completion notifications** — agents notify the orchestrator immediately when done via `pi.sendMessage()`
- **30s polling fallback** — background poll catches any missed notifications, auto-cleans up when all agents finish

## Tools

### `hive_spawn`

Spawn specialized sub-agents in the background. Returns immediately.

```json
{
  "agents": [
    {
      "name": "frontend-dev",
      "role": "Frontend React specialist",
      "systemPrompt": "You are an expert React developer...",
      "task": "Build the landing page component with responsive layout..."
    },
    {
      "name": "backend-dev",
      "role": "Express.js API designer",
      "systemPrompt": "You are a senior backend engineer...",
      "task": "Design and implement REST API routes for..."
    }
  ]
}
```

### `hive_inbox`

Check the shared inbox for completed agent results. Shows running agents, completed agents, and their full output.

```
# Check all agents
hive_inbox({})

# Read a specific agent's result
hive_inbox({ agent: "frontend-dev" })
```

## Commands & Shortcuts

| Key | Action |
|-----|--------|
| `/hive` | Open the agent dashboard |
| `/hive-kill` | Kill all running agents |
| `Ctrl+Shift+H` | Quick view of running agents |

## Architecture

- Each sub-agent runs as an isolated `pi --mode json` child process
- System prompt injection via `before_agent_start` makes the main agent a pure orchestrator
- Agents report completion via `pi.sendMessage({ deliverAs: "steer", triggerTurn: true })`
- 30s background polling catches missed notifications
- Live output captured by parsing JSON events: `tool_execution_start`, `message_update`, `tool_result_end`

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
3. Synthesize results and deliver final answer

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

This ensures the LLM **always** knows its role, which agents are running, and which results are ready.
