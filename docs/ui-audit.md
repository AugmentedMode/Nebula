# Nebula UI Audit

This document maps the current TUI so design changes stay grounded in the app's actual behavior.

## App Shell

`src/app.tsx` is a thin bootstrap layer. It creates a `NebulaRuntime`, applies CLI options like provider/model/session resume, and renders `Layout`.

`src/init.ts` builds the runtime bundle the UI depends on:
- `orchestrator` for chat/session/provider state
- `executor`, `connectionPool`, `runScheduler`, and `runStore` for task state
- `metricCollector` and `metricStore` for metric ingestion and history
- `resourceCollector` for machine telemetry
- `sleepManager`, `monitorManager`, and `stickyManager` for secondary agent behavior

The UI is therefore not just a renderer. Several visible panels are direct views over long-lived runtime services.

## Main Page

`src/ui/layout.tsx` owns the screen composition and almost all top-level UI state:
- `messages` for the conversation feed
- `tasks` for live and queued work
- `metricData` for metric summaries shown on the dashboard
- `resourceData` for machine CPU/GPU/memory/disk state
- `stickyNotes` for the side rail
- `activeOverlay` for fullscreen task or metric views
- `isStreaming` for assistant output and input disabling

The default screen has three stacked zones.

### 1. Top Strip

The top strip is split in half:
- Left: `MetricsDashboard`
- Right: `TaskListPanel`

This is always visible in the normal layout. It acts like a heads-up display while the conversation continues below it.

### 2. Conversation Body

The middle body is the main working area:
- `ConversationPanel` renders user, assistant, tool, error, and system messages
- `StickyNotesPanel` appears as a right rail only when notes exist

If there are no messages yet, the conversation body is replaced by the Nebula welcome state instead of an empty transcript.

### 3. Bottom Chrome

The bottom area is operational, not decorative:
- `KeyHintRule` shows keyboard shortcuts
- `StatusBar` shows provider/model/reasoning/state/cost/monitor/sleep status
- `InputBar` handles message entry, history, and slash command autocomplete

## Empty State Vs Active State

The main page has two very different modes.

### Empty State

When `messages.length === 0`, the body shows:
- Nebula branding
- version
- `/help` hint
- optional update notice

This is a presentation-only state. It disappears permanently once the transcript begins.

### Active State

Once messages exist, the center becomes a scrollable conversation view. Auto-scroll is maintained during streaming, but users can scroll upward manually. `Layout` contains custom logic to clamp scrolling because `ink-scroll-view` otherwise allows overscrolling into empty space.

## Conversation Surface

`src/ui/panels/conversation.tsx` is the most behavior-coupled part of the UI because it reflects raw orchestrator events.

Message roles render differently:
- `user`: prompt line with the active glyph
- `assistant`: markdown-rendered response text
- `tool`: structured tool call block
- `error`: inline error text
- `system`: dimmed system notices such as OAuth URLs or wake events

Tool messages are not generic logs. They branch by tool name into custom displays for:
- foreground execution
- background execution
- uploads/downloads
- sleep/monitor actions
- task output lookups
- machine listings
- metric inspection
- run comparisons

That means redesigning tool output is higher risk than changing colors or borders; the UI is already encoding tool semantics.

## Tasks UI

The task surface is split between the small dashboard panel and the fullscreen overlay.

### Tasks Panel

`src/ui/panels/task-list.tsx` shows two distinct kinds of information in one panel:
- active or queued tasks
- per-machine resource usage

It shows up to three tasks at the top, then machine telemetry below:
- GPU utilization/memory/temperature
- CPU percentage
- memory usage
- disk usage

If both sections exist, a divider separates them. If neither exists, the panel shows `no tasks`.

### Task Data Flow

`Layout` refreshes task state in a 5-second loop:
1. `runScheduler.tick()` advances queued/scheduled runs.
2. `pollTaskStatuses(executor)` checks whether tracked background processes are still running.
3. Finished tasks are sent to `handleFinishedTasks(...)`.
4. Queued/running scheduler entries are read from `runScheduler.listRuns(...)`.
5. Background process state and scheduler state are merged into one `TaskInfo[]`.

`handleFinishedTasks(...)` in `src/core/task-poller.ts` does real lifecycle work:
- collects final metrics
- reads exit codes from `.exit` files
- updates experiment tracking
- sends notifications
- marks runs finished in `runStore`
- removes metric sources and background-process records

The panel is therefore a compact view over both task execution and scheduler state.

### Task Overlay

`src/ui/overlays/task-overlay.tsx` is the deep inspection view.

It has two panes:
- left: selectable task list
- right: tailed output for the selected task

Behavior:
- `Esc` closes the overlay
- Up/down changes the selected task
- output refreshes every 3 seconds
- the log pane auto-scrolls to bottom when new output arrives

The overlay depends on `RemoteExecutor` log paths. If a process has no tracked log path, output falls back to a placeholder.

## Metrics UI

Like tasks, metrics have both a compact dashboard and a deeper overlay.

### Metrics Panel

`src/ui/panels/metrics-dashboard.tsx` shows one row per metric:
- metric name
- sparkline
- latest value

This panel is intentionally compressed. It is designed for fast scanning, not deep analysis.

### Metrics Data Flow

Metrics come from stdout/log parsing, not direct instrumentation hooks in the UI.

Flow:
1. A task is launched with a log path and metric parsing patterns.
2. `MetricCollector` tracks that source.
3. Every poll, the collector counts log lines, reads only newly appended lines, and parses them with metric patterns.
4. Parsed points are written into `MetricStore`, backed by SQLite.
5. The dashboard reads recent per-metric series via `metricStore.getAllSeries(...)`.
6. The metrics overlay can read richer merged history across tasks via `metricStore.getSeriesAcrossTasks(...)`.

This matters for redesign because the metric views are only as fresh and as rich as the collector/store pipeline.

### Metrics Overlay

`src/ui/overlays/metrics-overlay.tsx` is the inspection view for historical series.

For each metric it shows:
- name and sparkline
- latest value
- min/max
- standard deviation
- trend classification

The selected metric also expands into a larger ASCII chart using `asciichart`.

Behavior:
- `Esc` closes
- Up/down changes selection
- empty state reads `no metrics recorded`

Trend analysis is computed through `analyzeMetric(...)`, so the overlay is analytical, not just visual.

## Machine Resource Telemetry

Machine telemetry is separate from task metrics.

`src/metrics/resources.ts` collects:
- GPU info
- CPU load
- memory usage
- disk usage

`Layout` requests this from `resourceCollector.collectAll()` on the same 5-second loop used for task/metric refresh.

Important constraints:
- GPU support differs by platform
- Linux prefers `nvidia-smi`
- macOS prefers `macmon`, then falls back to static `system_profiler` data
- unreachable machines still produce placeholder rows with `null` resource values

This is why the tasks panel can show machine health even if there is no active training metric stream.

## Input And Interaction Model

`src/ui/components/input-bar.tsx` is a custom line editor, not a plain text input.

It supports:
- inline cursor movement
- history navigation
- command autocomplete
- tab completion
- command hints
- line clearing and word deletion shortcuts

If the current value starts with `/`, the input switches into slash-command mode and suggestions come from `COMMANDS` in `src/ui/commands.ts`.

In `Layout`, submissions split into two paths:
- Slash commands are handled locally through `handleSlashCommand(...)`.
- Normal text is sent through `orchestrator.send(...)`.

That means the input bar is a behavior boundary, not just a visual footer.

## Orchestrator Event Flow

The conversation UI is driven by the async stream from `orchestrator.send(...)` in `src/core/orchestrator.ts`.

`Layout` turns provider events into UI messages:
- streaming text accumulates into assistant messages
- tool calls create tool blocks
- tool results attach back onto the corresponding tool block
- provider errors create error messages

Other systems can inject conversation messages too:
- monitor ticks build and submit automatic status prompts
- sleep wake events inject a wake message and re-trigger the agent
- OpenAI OAuth URLs are surfaced into the transcript instead of stderr

This is why the chat area is the real control surface of the app, not just a log.

## Status Bar

`src/ui/components/status-bar.tsx` reflects current runtime state:
- provider
- model
- reasoning effort
- orchestrator state
- sleep animation and elapsed time
- active monitoring interval
- total spend

This bar is one of the few places where multiple subsystems are visible at once. It is the best summary line for "what the agent is doing right now."

## Sticky Notes

Sticky notes are visually simple but behaviorally important.

They appear as a side panel when notes exist, but they also feed into model prompts. `Orchestrator.send(...)` prepends formatted stickies to the outgoing user message before it reaches the provider.

Changing sticky-note behavior affects both:
- what the user sees
- what the model is conditioned on

That makes stickies a higher-risk redesign area than a normal sidebar.

## Fullscreen Modes

`Layout` has three top-level render modes:
- normal dashboard + conversation layout
- task overlay
- metrics overlay

When an overlay is open:
- it takes the whole terminal
- normal scroll/input behavior is suspended
- `Esc` closes the overlay first before interrupting the assistant

This is important if we later want modals, drawers, or more layered UI. Right now the model is simple: one fullscreen overlay at a time.

## Safe Vs Risky Design Changes

### Safer Changes

These are mostly presentational:
- colors, glyphs, and branding
- header styling
- welcome state visuals
- spacing and separators
- panel framing and labels
- typography choices within Ink's terminal constraints

### Higher-Risk Changes

These are behavior-coupled and need more care:
- conversation/tool-call rendering
- slash-command UX
- task polling cadence or merge logic
- metric collection/storage assumptions
- task overlay log refresh behavior
- sticky notes, because they affect prompts
- status bar content, because it reflects multiple live runtime services

## Current Mental Model

Nebula is effectively one terminal screen with:
- a live telemetry header
- a working conversation core
- two fullscreen inspector views
- a smart input footer

The app is not a set of disconnected pages. It is one always-on operations console where tasks, metrics, and conversation all update around the same orchestrator loop.
