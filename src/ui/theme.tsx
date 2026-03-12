import { Box, Text } from "ink";

// ─── Colors ──────────────────────────────────────────
export const C = {
  primary: "cyan" as const,
  bright: "blueBright" as const,
  text: "white" as const,
  dim: "gray" as const,
  error: "red" as const,
  success: "cyanBright" as const,
};

// ─── Glyphs ──────────────────────────────────────────
export const G = {
  brand: "✦",
  section: "✦",
  bullet: "▹",
  active: "▸",
  dot: "✦",
  dotDim: "·",
  rule: "═",
  dash: "╌",
};

// ─── Metric Colors ───────────────────────────────────
export const METRIC_COLORS = [
  "cyanBright",
  "blueBright",
  "whiteBright",
  "cyanBright",
  "greenBright",
  "magentaBright",
  "redBright",
  "cyan",
  "blue",
  "cyan",
  "green",
] as const;

export function nameHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function cols(): number {
  return process.stdout.columns || 80;
}

/** Heavy horizontal rule spanning the terminal */
export function HRule({ dim = false }: { dim?: boolean }) {
  return (
    <Box>
      <Text color={C.primary} dimColor={dim}>
        {G.rule.repeat(cols())}
      </Text>
    </Box>
  );
}
