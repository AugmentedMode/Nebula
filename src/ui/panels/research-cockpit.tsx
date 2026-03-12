import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { C, G } from "../theme.js";
import { formatMetricValue, truncate } from "../format.js";
import {
  type CampaignSummary,
  type ExperimentGroup,
  type FleetSummary,
  type NarrativeItem,
  formatMetricSummary,
} from "../campaign.js";

interface CampaignOverviewPanelProps {
  summary: CampaignSummary;
  width: number;
}

interface FleetOverviewPanelProps {
  fleet: FleetSummary;
  width: number;
}

interface FrontierPanelProps {
  groups: ExperimentGroup[];
  width: number;
}

interface ResearchNarrativePanelProps {
  items: NarrativeItem[];
}

export function CampaignOverviewPanel({ summary, width }: CampaignOverviewPanelProps) {
  const bodyWidth = Math.max(24, width - 4);

  return (
    <Card title="Campaign" width={width}>
      <KeyValue label="Objective" value={truncate(summary.objective, bodyWidth, true)} />
      <KeyValue label="Status" value={`${summary.activeRuns} active, ${summary.queuedRuns} queued, ${summary.failedRuns} failed`} />
      <KeyValue label="Best" value={truncate(formatMetricSummary(summary.bestMetric), bodyWidth, true)} />
      <KeyValue label="Lead" value={summary.leadingGroup ?? "No experiment groups yet"} />
      <KeyValue label="Attention" value={truncate(summary.attention, bodyWidth, true)} />
      <Box marginTop={1} flexDirection="column">
        <Text color={C.dim}>Live metrics</Text>
        {summary.liveMetrics.length === 0 ? (
          <Text color={C.dim}>  no active metrics</Text>
        ) : (
          summary.liveMetrics.map((metric) => (
            <Box key={metric.name}>
              <Text color={trendColor(metric.trend)}>{trendGlyph(metric.trend)} </Text>
              <Text color={C.text}>{metric.name}</Text>
              <Text color={C.dim}> </Text>
              <Text color={C.bright}>{metric.latest === null ? "--" : formatMetricValue(metric.latest)}</Text>
            </Box>
          ))
        )}
      </Box>
    </Card>
  );
}

export function FleetOverviewPanel({ fleet, width }: FleetOverviewPanelProps) {
  return (
    <Card title="Fleet" width={width}>
      <KeyValue label="Capacity" value={`${fleet.slotsUsed}/${fleet.slotsTotal} slots active`} />
      <KeyValue label="Backlog" value={`${fleet.queuedRuns} queued`} />
      <Box marginTop={1} flexDirection="column">
        <Text color={C.dim}>Allocation</Text>
        {fleet.strategyMix.length === 0 ? (
          <Text color={C.dim}>  no active allocation</Text>
        ) : (
          fleet.strategyMix.map((item) => (
            <Box key={item.label}>
              <Text color={C.primary}>{G.dot} </Text>
              <Text color={C.text}>{item.label}</Text>
              <Text color={C.dim}> {item.count} run{item.count === 1 ? "" : "s"}</Text>
            </Box>
          ))
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={C.dim}>Machines</Text>
        {fleet.machines.map((machine) => (
          <Box key={machine.machineId} flexDirection="column" marginTop={1}>
            <Text color={C.text}>
              {machine.machineId} <Text color={C.dim}>{machine.slotsUsed}/{machine.slotsTotal} slots</Text>
            </Text>
            <Text color={C.dim}>
              {machine.roles.join(", ") || "general"} • {machine.summary}
              {machine.queuedRuns > 0 ? ` • ${machine.queuedRuns} queued` : ""}
            </Text>
          </Box>
        ))}
      </Box>
    </Card>
  );
}

export function FrontierPanel({ groups, width }: FrontierPanelProps) {
  return (
    <Card title="Frontier" width={width}>
      {groups.length === 0 ? (
        <Text color={C.dim}>No experiment groups yet.</Text>
      ) : (
        groups.slice(0, 6).map((group) => (
          <Box key={group.key} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={verdictColor(group.verdict)}>{verdictGlyph(group.verdict)} </Text>
              <Text color={C.text}>{truncate(group.label, Math.max(18, width - 24), true)}</Text>
              <Text color={C.dim}> [{group.strategy}]</Text>
            </Box>
            <Text color={C.dim}>
              {group.activeRuns} active • {group.queuedRuns} queued • {group.failedRuns} failed
              {group.bestMetric ? ` • ${group.bestMetric.metric} ${formatMetricValue(group.bestMetric.value)}` : ""}
              {group.machines.length > 0 ? ` • ${group.machines.join(", ")}` : ""}
            </Text>
          </Box>
        ))
      )}
    </Card>
  );
}

export function ResearchNarrativePanel({ items }: ResearchNarrativePanelProps) {
  return (
    <Card title="Research Narrative">
      {items.length === 0 ? (
        <Text color={C.dim}>No narrative yet. Start by stating a research objective.</Text>
      ) : (
        items.map((item, index) => (
          <Box key={`${item.title}-${index}`} marginBottom={1}>
            <Text color={toneColor(item.tone)}>{item.icon} </Text>
            <Text color={C.text}>{item.title}</Text>
            <Text color={C.dim}> - {item.detail}</Text>
          </Box>
        ))
      )}
    </Card>
  );
}

function Card({
  title,
  width,
  children,
}: {
  title: string;
  width?: number;
  children: ReactNode;
}) {
  const borderWidth = width ? Math.max(10, width - title.length - 4) : 18;
  return (
    <Box flexDirection="column" paddingX={1} paddingBottom={1}>
      <Box>
        <Text color={C.primary} bold>{title}</Text>
        <Text color={C.primary}> {G.dash.repeat(borderWidth)}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text color={C.dim}>{label.padEnd(9)}</Text>
      <Text color={C.text}>{value}</Text>
    </Box>
  );
}

function verdictGlyph(verdict: ExperimentGroup["verdict"]): string {
  switch (verdict) {
    case "frontier":
      return G.active;
    case "active":
      return G.dot;
    case "staged":
      return "+";
    case "blocked":
      return "!";
    case "settled":
    default:
      return G.bullet;
  }
}

function verdictColor(verdict: ExperimentGroup["verdict"]): string {
  switch (verdict) {
    case "frontier":
      return C.success;
    case "active":
      return C.primary;
    case "staged":
      return C.bright;
    case "blocked":
      return C.error;
    case "settled":
    default:
      return C.dim;
  }
}

function trendGlyph(trend: "up" | "down" | "flat"): string {
  switch (trend) {
    case "up":
      return "^";
    case "down":
      return "v";
    case "flat":
    default:
      return "-";
  }
}

function trendColor(trend: "up" | "down" | "flat"): string {
  switch (trend) {
    case "up":
      return C.bright;
    case "down":
      return C.success;
    case "flat":
    default:
      return C.dim;
  }
}

function toneColor(tone: NarrativeItem["tone"]): string {
  switch (tone) {
    case "good":
      return C.success;
    case "warn":
      return C.error;
    case "neutral":
    default:
      return C.primary;
  }
}
