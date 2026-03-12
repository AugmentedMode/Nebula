import { useState, useCallback, useRef, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { EventEmitter } from "node:events";
import { useScreenSize } from "fullscreen-ink";
import { ScrollView, type ScrollViewRef } from "ink-scroll-view";
import { StatusBar } from "./components/status-bar.js";
import { InputBar } from "./components/input-bar.js";
import { C, G, HRule } from "./theme.js";
import { KeyHintRule } from "./components/key-hint-rule.js";
import { TaskOverlay } from "./overlays/task-overlay.js";
import { MetricsOverlay } from "./overlays/metrics-overlay.js";
import type { MonitorConfig } from "../core/monitor.js";
import type { MouseEvent } from "./mouse-filter.js";
import type { StickyNote } from "../core/stickies.js";
import type { NebulaRuntime } from "../init.js";
import type { Attachment } from "../providers/types.js";
import { StickyNotesPanel } from "./panels/sticky-notes.js";
import { VERSION, checkForUpdate } from "../version.js";
import { handleSlashCommand } from "./commands.js";
import { pollTaskStatuses, handleFinishedTasks, buildMonitorMessage } from "../core/task-poller.js";
import type { Message, ToolData, TaskInfo } from "./types.js";
import type { RunRecord } from "../runs/store.js";
import {
  buildCampaignSummary,
  buildExperimentGroups,
  buildFleetSummary,
  buildNarrative,
  buildTaskEntries,
} from "./campaign.js";
import {
  CampaignOverviewPanel,
  FleetOverviewPanel,
  FrontierPanel,
  ResearchNarrativePanel,
} from "./panels/research-cockpit.js";

interface LayoutProps {
  runtime: NebulaRuntime;
  mouseEmitter?: EventEmitter;
  headless?: boolean;
  initialPrompt?: string;
  initialAttachments?: Attachment[];
}

let messageIdCounter = 0;

export function Layout({ runtime, mouseEmitter, headless, initialPrompt, initialAttachments }: LayoutProps) {
  const {
    orchestrator, sleepManager, connectionPool, executor,
    metricStore, metricCollector, monitorManager, experimentTracker,
    memoryStore, stickyManager, agentName, runScheduler, runStore,
  } = runtime;
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<ScrollViewRef>(null);

  const [userScrolled, setUserScrolled] = useState(false);
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [runRecords, setRunRecords] = useState<RunRecord[]>([]);
  const [metricData, setMetricData] = useState<Map<string, number[]>>(new Map());
  const [stickyNotes, setStickyNotes] = useState<StickyNote[]>([]);
  const [activeOverlay, setActiveOverlay] = useState<"none" | "tasks" | "metrics">("none");
  const [resourceData, setResourceData] = useState<Map<string, import("../metrics/resources.js").MachineResources>>(new Map());
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  const [workingStatus, setWorkingStatus] = useState<string | null>(null);
  const [workingPreview, setWorkingPreview] = useState<string | null>(null);

  // Check for updates on mount (non-blocking)
  useEffect(() => {
    checkForUpdate().then((v) => { if (v) setUpdateAvailable(v); }).catch(() => {});
  }, []);

  // Poll tasks and metrics every 5 seconds
  useEffect(() => {
    const poll = async () => {
      let didCollect = false;
      await runScheduler.tick().catch(() => {});

      if (executor && connectionPool) {
        const { statuses, finished } = await pollTaskStatuses(executor);

        // Build TaskInfo[] for UI state
        const updated: TaskInfo[] = statuses.map(({ proc, running }) => {
          const shortCmd = proc.command.length > 40
            ? proc.command.slice(0, 40) + "..."
            : proc.command;
          return {
            id: `${proc.machineId}:${proc.pid}`,
            name: shortCmd,
            status: running ? "running" as const : "completed" as const,
            machineId: proc.machineId,
            pid: proc.pid,
            logPath: proc.logPath,
            startedAt: proc.startedAt,
          };
        });

        if (finished.length > 0) {
          await handleFinishedTasks(finished, {
            executor, connectionPool, metricCollector, metricStore,
            experimentTracker, notifier: runtime.notifier, runStore,
          });
          didCollect = true;
        }

        const currentRuns = runScheduler.listRuns(100);
        const queuedRuns: TaskInfo[] = currentRuns
          .filter((run) => ["queued", "syncing", "running", "failed", "cancelled"].includes(run.status))
          .map((run) => ({
            id: run.id,
            name: run.command.length > 40 ? run.command.slice(0, 40) + "..." : run.command,
            status: mapRunStatus(run.status),
            machineId: run.machineId ?? "auto",
            pid: run.pid ?? undefined,
            logPath: run.logPath ?? undefined,
            startedAt: run.startedAt ?? run.createdAt,
            details: run.error ?? undefined,
          }));

        const merged = new Map<string, TaskInfo>();
        for (const task of [...updated, ...queuedRuns]) {
          merged.set(task.id, task);
        }
        setRunRecords(currentRuns);
        setTasks(Array.from(merged.values()));
      }

      // Collect metrics from all sources (skip if we already collected for finished tasks above)
      if (metricCollector && metricStore) {
        if (!didCollect) {
          await metricCollector.collectAll().catch(() => {});
        }
        setMetricData(metricStore.getAllSeries(50));
      }

      // Collect resource usage from connected machines
      if (runtime.resourceCollector) {
        const res = await runtime.resourceCollector.collectAll().catch(() => new Map());
        setResourceData(res as Map<string, import("../metrics/resources.js").MachineResources>);
      }
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const loop = async () => {
      await poll();
      if (!stopped) timer = setTimeout(loop, 5000);
    };
    loop();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [executor, connectionPool, metricCollector, metricStore, runScheduler, runStore]);

  // Auto-scroll to bottom when messages change, overlay closes, or user hasn't scrolled up
  useEffect(() => {
    if (!userScrolled) {
      scrollRef.current?.scrollToBottom();
    }
  }, [messages, userScrolled, activeOverlay]);

  // Re-snap to bottom when streaming starts, and keep scrolling during streaming
  useEffect(() => {
    if (isStreaming) {
      setUserScrolled(false);
      // During streaming, content changes faster than React state updates trigger effects.
      // Poll scrollToBottom on a short interval to keep up.
      const timer = setInterval(() => {
        scrollRef.current?.scrollToBottom();
      }, 100);
      return () => clearInterval(timer);
    }
  }, [isStreaming]);

  // Clamped scroll helper — ink-scroll-view's scrollBy has a bug where
  // it clamps to contentHeight instead of contentHeight - viewportHeight,
  // allowing you to scroll past the bottom into empty space.
  const clampedScrollBy = useCallback((delta: number) => {
    const sv = scrollRef.current;
    if (!sv) return;
    const target = Math.max(0, Math.min(sv.getScrollOffset() + delta, sv.getBottomOffset()));
    sv.scrollTo(target);
    return target >= sv.getBottomOffset();
  }, []);

  // Enable SGR mouse reporting and handle scroll via mouseEmitter
  useEffect(() => {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    return () => { process.stdout.write("\x1b[?1006l\x1b[?1000l"); };
  }, []);

  useEffect(() => {
    if (!mouseEmitter) return;
    const handler = (evt: MouseEvent) => {
      if (evt.type === "scroll_up") {
        clampedScrollBy(-3);
        setUserScrolled(true);
      } else if (evt.type === "scroll_down") {
        const atBottom = clampedScrollBy(3);
        if (atBottom) setUserScrolled(false);
      }
    };
    mouseEmitter.on("mouse", handler);
    return () => { mouseEmitter.removeListener("mouse", handler); };
  }, [mouseEmitter, clampedScrollBy]);

  useInput((input, key) => {
    // Toggle overlays — always available
    if (key.ctrl && input === "t") {
      setActiveOverlay((prev) => prev === "tasks" ? "none" : "tasks");
      return;
    }
    if (key.ctrl && input === "g") {
      setActiveOverlay((prev) => prev === "metrics" ? "none" : "metrics");
      return;
    }

    // Esc: close overlay first, then interrupt stream
    if (key.escape) {
      if (activeOverlay !== "none") {
        setActiveOverlay("none");
        return;
      }
      if (isStreaming) {
        orchestrator.interrupt();
        setIsStreaming(false);
        return;
      }
    }

    if (key.ctrl && input === "c") {
      if (activeOverlay !== "none") {
        setActiveOverlay("none");
        return;
      }
      if (isStreaming) {
        orchestrator.interrupt();
        setIsStreaming(false);
      } else {
        exit();
      }
      return;
    }

    // Don't process scroll keys when overlay is active
    if (activeOverlay !== "none") return;

    if (key.pageUp) {
      clampedScrollBy(-10);
      setUserScrolled(true);
    }
    if (key.pageDown) {
      const atBottom = clampedScrollBy(10);
      if (atBottom) setUserScrolled(false);
    }
  });

  const addMessage = useCallback(
    (role: Message["role"], content: string, tool?: ToolData): number => {
      const id = ++messageIdCounter;
      setMessages((prev) => [...prev, { id, role, content, tool }]);
      return id;
    },
    [],
  );

  const updateMessage = useCallback((id: number, updates: Partial<Message>) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    );
  }, []);

  const handleSubmit = useCallback(
    async (input: string, attachments?: Attachment[]) => {
      if (!input.trim()) return;

      if (input.startsWith("/")) {
        await handleSlashCommand(input, {
          orchestrator, addMessage, updateMessage, setMessages, messages: messagesRef.current, setIsStreaming,
          connectionPool, metricStore, metricCollector, memoryStore,
          stickyManager, setStickyNotes, executor, runScheduler,
          restoreMessages: (msgs) =>
            msgs.map((m) => ({
              id: ++messageIdCounter,
              role: m.role as Message["role"],
              content: m.content,
            })),
        });
        return;
      }

      if (sleepManager.isSleeping) {
        addMessage("user", input);
        addMessage("system", "Waking agent...");
        sleepManager.manualWake(input);
        return;
      }

      addMessage("user", input);
      setIsStreaming(true);
      setWorkingStatus("Thinking");
      setWorkingPreview(null);

      try {
        let assistantText = "";
        let assistantMsgId: number | null = null;
        let sawAssistantText = false;
        // Map tool callId -> message id for attaching results
        const toolMsgIds = new Map<string, number>();

        for await (const event of orchestrator.send(input, attachments)) {
          // Feed events to experiment tracker for auto-populating /experiments/
          experimentTracker?.onEvent(event);

          if (event.type === "text" && event.delta) {
            if (!sawAssistantText) {
              sawAssistantText = true;
              setWorkingStatus("Responding");
              setWorkingPreview(null);
            }
            assistantText += event.delta;
            if (assistantMsgId === null) {
              assistantMsgId = addMessage("assistant", assistantText);
            } else {
              updateMessage(assistantMsgId, { content: assistantText });
            }
          }

          if (event.type === "status") {
            setWorkingStatus(event.status);
            if (!sawAssistantText) {
              setWorkingPreview(event.preview ?? null);
            }
          }

          if (event.type === "tool_call") {
            setWorkingStatus(`Using ${event.name}`);
            setWorkingPreview(null);
            const toolData: ToolData = {
              callId: event.id,
              name: event.name,
              args: event.args,
            };
            const msgId = addMessage("tool", "", toolData);
            toolMsgIds.set(event.id, msgId);
            assistantText = "";
            assistantMsgId = null;
          }

          if (event.type === "tool_result") {
            setWorkingStatus("Thinking");
            const msgId = toolMsgIds.get(event.callId);
            if (msgId !== undefined) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msgId && m.tool
                    ? { ...m, tool: { ...m.tool, result: event.result, isError: event.isError } }
                    : m,
                ),
              );
            }
            if (event.isError) {
              addMessage("error", event.result);
            }
          }

          if (event.type === "error") {
            setWorkingStatus(null);
            setWorkingPreview(null);
            addMessage("error", event.error.message);
          }

          if (event.type === "done") {
            setWorkingStatus(null);
            setWorkingPreview(null);
          }
        }
      } catch (err) {
        setWorkingStatus(null);
        setWorkingPreview(null);
        addMessage(
          "error",
          err instanceof Error ? err.message : "Unknown error",
        );
      } finally {
        setIsStreaming(false);
        setWorkingStatus(null);
        setWorkingPreview(null);
      }
    },
    [orchestrator, sleepManager, addMessage, updateMessage, setMessages, connectionPool, metricStore],
  );

  // Auto-submit initial prompt (from --prompt CLI flag)
  const promptSent = useRef(false);
  useEffect(() => {
    if (initialPrompt && !promptSent.current) {
      promptSent.current = true;
      handleSubmit(initialPrompt, initialAttachments);
    }
  }, [initialPrompt, initialAttachments, handleSubmit]);

  // Monitor: auto-invoke model on tick
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;

  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  useEffect(() => {
    if (!monitorManager) return;

    const onTick = (config: MonitorConfig) => {
      if (isStreamingRef.current) return;
      const message = buildMonitorMessage(config, executor, metricStore);
      handleSubmitRef.current(message);
    };

    monitorManager.on("tick", onTick);
    return () => {
      monitorManager.removeListener("tick", onTick);
    };
  }, [monitorManager]);

  // Sleep/wake: auto-resume model when a trigger fires
  const addMessageRef = useRef(addMessage);
  addMessageRef.current = addMessage;

  // Route OpenAI OAuth URL display through the TUI instead of stderr
  useEffect(() => {
    runtime.openaiOAuth.onAuthUrl = (url) => {
      addMessageRef.current("system", url);
    };
    return () => { runtime.openaiOAuth.onAuthUrl = null; };
  }, [runtime.openaiOAuth]);

  useEffect(() => {
    const onWake = (_session: unknown, _reason: string, wakeMessage: string) => {
      if (isStreamingRef.current) return;
      addMessageRef.current("system", "Agent waking up — trigger fired");
      handleSubmitRef.current(wakeMessage);
    };

    sleepManager.on("wake", onWake);
    return () => {
      sleepManager.removeListener("wake", onWake);
    };
  }, [sleepManager]);

  const isSleeping = sleepManager.isSleeping;

  const { height, width } = useScreenSize();
  const taskEntries = buildTaskEntries(tasks, runRecords, executor.getBackgroundProcesses());
  const campaignSummary = buildCampaignSummary(messages, metricData, taskEntries, metricStore);
  const experimentGroups = buildExperimentGroups(taskEntries, metricStore);
  const fleetSummary = buildFleetSummary(connectionPool.getMachineDefinitions(), resourceData, taskEntries);
  const narrative = buildNarrative(messages);
  const stickyWidth = stickyNotes.length > 0 ? Math.min(30, Math.floor(width * 0.25)) : 0;
  const bodyWidth = Math.max(40, width - stickyWidth - 2);

  // ── Fullscreen overlays ───────────────────────────────────────
  if (activeOverlay === "tasks") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <TaskOverlay
          tasks={tasks}
          executor={executor}
          width={width}
          height={height}
          onClose={() => setActiveOverlay("none")}
        />
      </Box>
    );
  }

  if (activeOverlay === "metrics") {
    return (
      <Box flexDirection="column" height={height} width={width}>
        <MetricsOverlay
          metricData={metricData}
          metricStore={metricStore}
          width={width}
          height={height}
          onClose={() => setActiveOverlay("none")}
        />
      </Box>
    );
  }

  // ── Normal layout ─────────────────────────────────────────────
  return (
    <Box flexDirection="column" height={height} width={width}>
        <Box flexShrink={0}>
          {headless && agentName ? (
            <HeadlessHeader agentName={agentName} width={width} />
          ) : (
            <HeaderWithPanels width={width} />
          )}
        </Box>

        <Box flexShrink={0} flexDirection="row">
          <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
            <CampaignOverviewPanel
              summary={campaignSummary}
              width={Math.floor((width - 1) / 2) - 2}
            />
          </Box>
          <Box width={1} flexDirection="column" alignItems="center">
            <Text color={C.primary} wrap="truncate">
              {"│\n│\n│\n│\n│\n│\n│"}
            </Text>
          </Box>
          <Box flexGrow={1} flexBasis={0} flexDirection="column" paddingX={1}>
            <FleetOverviewPanel
              fleet={fleetSummary}
              width={Math.floor((width - 1) / 2) - 2}
            />
          </Box>
        </Box>

        <Box flexShrink={0}><HRule /></Box>

        <Box flexGrow={1} flexShrink={1} flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            {messages.length === 0 && !headless ? (
              <Box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" paddingX={4}>
                <Text color={C.bright} bold>{`${G.brand} ${G.brand} ${G.brand}`}</Text>
                <Text color={C.primary} bold>NEBULA CAMPAIGN COCKPIT</Text>
                <Text color={C.dim}>State a goal. Nebula will turn it into an experiment campaign.</Text>
                <Text color={C.dim}>The default view now emphasizes campaign status, fleet allocation, and frontier movement.</Text>
                <Text color={C.dim}>Use Ctrl+T for raw tasks and Ctrl+G for raw metrics.</Text>
                <Text color={C.dim} dimColor>v{VERSION}</Text>
                {updateAvailable && (
                  <Box marginTop={1}>
                    <Text color={C.bright}>update available: v{updateAvailable} — npm i -g nebula</Text>
                  </Box>
                )}
              </Box>
            ) : (
              <ScrollView ref={scrollRef}>
                <Box flexDirection="column" paddingBottom={1}>
                  <FrontierPanel groups={experimentGroups} width={bodyWidth} />
                  <ResearchNarrativePanel items={narrative} />
                </Box>
              </ScrollView>
            )}
          </Box>
          {stickyNotes.length > 0 && (
            <Box flexShrink={0}>
              <StickyNotesPanel notes={stickyNotes} width={stickyWidth} />
            </Box>
          )}
        </Box>

        {!headless && <Box flexShrink={0}><KeyHintRule /></Box>}
        <Box flexShrink={0}><StatusBar orchestrator={orchestrator} sleepManager={sleepManager} monitorManager={monitorManager} workingStatus={workingStatus} workingPreview={workingPreview} isStreaming={isStreaming} /></Box>
        {!headless && (
          <Box flexShrink={0}>
            <InputBar
              onSubmit={handleSubmit}
              disabled={isStreaming}
              placeholder={
                isSleeping
                  ? "type to wake agent..."
                  : "send a message... (/help for commands)"
              }
            />
          </Box>
        )}
    </Box>
  );
}

function mapRunStatus(status: string): TaskInfo["status"] {
  switch (status) {
    case "queued":
    case "syncing":
    case "running":
    case "failed":
    case "cancelled":
      return status;
    case "succeeded":
      return "completed";
    default:
      return "queued";
  }
}

/** Compact header for headless mode — shows agent name prominently. */
function HeadlessHeader({ agentName, width }: { agentName: string; width: number }) {
  const label = ` ${G.brand} ${agentName} `;
  const fill = Math.max(0, width - label.length);
  return (
    <Box>
      <Text color={C.bright} bold>{label}</Text>
      <Text color={C.primary}>{G.rule.repeat(fill)}</Text>
    </Box>
  );
}

/** Single header line: logo on the left, panel labels right-aligned in each half. */
function HeaderWithPanels({ width }: { width: number }) {
  const logo = ` ✦·. ${G.brand} NEBULA .·✦ `;
  const ver = `${VERSION} `;
  const metricsLabel = " CAMPAIGN ";
  const tasksLabel = " FLEET ";

  const half = Math.floor(width / 2);
  const leftFill = Math.max(0, half - logo.length - ver.length - metricsLabel.length - 1);
  const rightFill = Math.max(0, width - half - tasksLabel.length - 1);

  return (
    <Box>
      <ShimmerLogo text={logo} />
      <Text color={C.dim}>{ver}</Text>
      <Text color={C.primary}>{G.rule.repeat(leftFill)}</Text>
      <Text color={C.primary}>{metricsLabel}</Text>
      <Text color={C.primary}>{G.rule}</Text>
      <Text color={C.primary}>{G.rule.repeat(rightFill)}</Text>
      <Text color={C.primary}>{tasksLabel}</Text>
      <Text color={C.primary}>{G.rule}</Text>
    </Box>
  );
}

const SHIMMER_INTERVAL = 80;
const SHIMMER_PAUSE = 20; // extra frames of pause after sweep

function ShimmerLogo({ text }: { text: string }) {
  const [frame, setFrame] = useState(0);
  const len = text.length;
  const cycleLen = len + 6 + SHIMMER_PAUSE; // 6 = shimmer tail width

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % cycleLen), SHIMMER_INTERVAL);
    return () => clearInterval(timer);
  }, [cycleLen]);

  const shimmerPos = frame - 3; // center of the bright spot

  // Group consecutive chars by color into segments for fewer <Text> nodes
  const segments: Array<{ color: string; chars: string }> = [];
  for (let i = 0; i < len; i++) {
    const dist = Math.abs(i - shimmerPos);
    const color = dist <= 1 ? C.bright : C.primary;

    const prev = segments[segments.length - 1];
    if (prev && prev.color === color) {
      prev.chars += text[i];
    } else {
      segments.push({ color, chars: text[i] });
    }
  }

  return (
    <Text>
      {segments.map((seg, i) => (
        <Text key={i} color={seg.color} bold>{seg.chars}</Text>
      ))}
    </Text>
  );
}
