import { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { C, G } from "../theme.js";
import { COMMANDS, type SlashCommand } from "../commands.js";

interface InputBarProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputBar({
  onSubmit,
  disabled = false,
  placeholder = "send a message...",
}: InputBarProps) {
  const [value, setValue] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const isCommandMode = value.startsWith("/");
  const suggestions = useMemo(() => getSuggestions(value), [value]);
  const showMenu = isCommandMode && suggestions.length > 0;
  const activeSuggestion = showMenu ? suggestions[Math.min(selectedIdx, suggestions.length - 1)] : null;

  useInput((input, key) => {
    if (disabled) return;

    if (key.return) {
      if (showMenu && activeSuggestion && value !== activeSuggestion.completion) {
        setValue(activeSuggestion.completion);
        setCursorPos(activeSuggestion.completion.length);
        return;
      }
      if (value.trim()) {
        onSubmit(value.trim());
        setHistory((prev) => [value.trim(), ...prev]);
        setValue("");
        setCursorPos(0);
        setHistoryIdx(-1);
        setSelectedIdx(0);
      }
      return;
    }

    if (key.tab && showMenu) {
      const suggestion = suggestions[selectedIdx];
      if (suggestion) {
        setValue(suggestion.completion);
        setCursorPos(suggestion.completion.length);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        setValue((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
        setCursorPos((prev) => prev - 1);
      }
      setSelectedIdx(0);
      return;
    }

    // Left arrow
    if (key.leftArrow) {
      setCursorPos((prev) => Math.max(0, prev - 1));
      return;
    }

    // Right arrow
    if (key.rightArrow) {
      setCursorPos((prev) => Math.min(value.length, prev + 1));
      return;
    }

    if (key.upArrow) {
      if (showMenu) {
        setSelectedIdx((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1,
        );
      } else if (history.length > 0) {
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(newIdx);
        setValue(history[newIdx]);
        setCursorPos(history[newIdx].length);
      }
      return;
    }

    if (key.downArrow) {
      if (showMenu) {
        setSelectedIdx((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0,
        );
      } else {
        if (historyIdx <= 0) {
          setHistoryIdx(-1);
          setValue("");
          setCursorPos(0);
        } else {
          const newIdx = historyIdx - 1;
          setHistoryIdx(newIdx);
          setValue(history[newIdx]);
          setCursorPos(history[newIdx].length);
        }
      }
      return;
    }

    // Home / Ctrl+A
    if (key.ctrl && input === "a") {
      setCursorPos(0);
      return;
    }

    // End / Ctrl+E
    if (key.ctrl && input === "e") {
      setCursorPos(value.length);
      return;
    }

    // Ctrl+U — clear line
    if (key.ctrl && input === "u") {
      setValue("");
      setCursorPos(0);
      return;
    }

    // Ctrl+W — delete word backward
    if (key.ctrl && input === "w") {
      const before = value.slice(0, cursorPos);
      const after = value.slice(cursorPos);
      const trimmed = before.replace(/\S+\s*$/, "");
      setValue(trimmed + after);
      setCursorPos(trimmed.length);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      setValue((prev) => prev.slice(0, cursorPos) + input + prev.slice(cursorPos));
      setCursorPos((prev) => prev + input.length);
      setHistoryIdx(-1);
      setSelectedIdx(0);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Command autocomplete menu */}
      {showMenu && (
        <Box flexDirection="column" paddingX={1} paddingY={0}>
          {suggestions.map((suggestion, i) => (
            <CommandItem
              key={`${suggestion.label}-${i}`}
              suggestion={suggestion}
              selected={i === selectedIdx}
            />
          ))}
          <Text color={C.dim} dimColor>
            {"  "}↑↓ navigate{"  "}tab complete{"  "}enter complete/run
          </Text>
          {activeSuggestion && (
            <Text color={C.dim} dimColor>
              {"  "}{activeSuggestion.hint}
            </Text>
          )}
        </Box>
      )}

      {/* Input line */}
      <Box paddingX={1}>
        <Text color={C.primary} bold>
          {G.active}{" "}
        </Text>
        {value ? (
          <CursorText text={value} cursorPos={cursorPos} />
        ) : (
          <Text color={C.dim} dimColor>
            {disabled ? "waiting..." : placeholder}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function CursorText({ text, cursorPos }: { text: string; cursorPos: number }) {
  const before = text.slice(0, cursorPos);
  const cursor = text[cursorPos] ?? " ";
  const after = text.slice(cursorPos + 1);

  return (
    <Text>
      <Text color={C.text}>{before}</Text>
      <Text color="black" backgroundColor={C.primary}>{cursor}</Text>
      <Text color={C.text}>{after}</Text>
    </Text>
  );
}

function CommandItem({
  suggestion,
  selected,
}: {
  suggestion: Suggestion;
  selected: boolean;
}) {
  return (
    <Box>
      <Text
        color={selected ? C.primary : C.dim}
        bold={selected}
      >
        {selected ? `${G.active} ` : "  "}{suggestion.label}
      </Text>
      <Text color={C.dim} dimColor>
        {"  "}{suggestion.description}
      </Text>
    </Box>
  );
}

interface Suggestion {
  label: string;
  completion: string;
  description: string;
  hint: string;
  command?: SlashCommand;
}

const SUBCOMMANDS: Record<string, Array<{ name: string; args?: string; description: string }>> = {
  local: [
    { name: "status", description: "Show local provider config and selection" },
    { name: "models", description: "List Ollama/local models you can use" },
    { name: "use", args: "<model-id>", description: "Select the local model" },
    { name: "connect", args: "<base-url> <model> [api-key]", description: "Configure local provider endpoint" },
  ],
  machine: [
    { name: "list", description: "List configured machines" },
    { name: "add", args: "<id> <user@host[:port]>", description: "Add a machine with role/slots/workspace flags" },
    { name: "rm", args: "<id>", description: "Remove a configured machine" },
  ],
  runs: [
    { name: "list", description: "List queued/running/failed runs" },
    { name: "cancel", args: "<id>", description: "Cancel a queued run" },
    { name: "retry", args: "<id>", description: "Retry a failed or cancelled run" },
  ],
  hub: [
    { name: "status", description: "Show hub connection state" },
    { name: "connect", args: "<url> [agent-name]", description: "Register this agent with a hub" },
    { name: "disconnect", description: "Remove the current hub config" },
  ],
};

function getSuggestions(value: string): Suggestion[] {
  if (!value.startsWith("/")) return [];

  const trimmed = value.slice(1);
  const parts = trimmed.split(" ");
  const commandQuery = parts[0] ?? "";
  const hasArgs = trimmed.includes(" ");
  const exactCommand = COMMANDS.find((cmd) => cmd.name === commandQuery);

  if (!hasArgs) {
    const commands = commandQuery === ""
      ? COMMANDS
      : COMMANDS.filter((cmd) => score(cmd.name, commandQuery) > 0);

    return commands
      .sort((a, b) => score(b.name, commandQuery) - score(a.name, commandQuery))
      .map((cmd) => ({
        label: `/${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`,
        completion: `/${cmd.name}${cmd.args ? " " : ""}`,
        description: cmd.description,
        hint: `Usage: /${cmd.name}${cmd.args ? ` ${cmd.args}` : ""}`,
        command: cmd,
      }));
  }

  if (!exactCommand) return [];
  const subcommands = SUBCOMMANDS[exactCommand.name];
  if (!subcommands) return [];

  const subQuery = parts[1] ?? "";
  const matches = subQuery === ""
    ? subcommands
    : subcommands.filter((sub) => score(sub.name, subQuery) > 0);

  return matches
    .sort((a, b) => score(b.name, subQuery) - score(a.name, subQuery))
    .map((sub) => ({
      label: `/${exactCommand.name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}`,
      completion: `/${exactCommand.name} ${sub.name}${sub.args ? " " : ""}`,
      description: sub.description,
      hint: `Usage: /${exactCommand.name} ${sub.name}${sub.args ? ` ${sub.args}` : ""}`,
      command: exactCommand,
    }));
}

function score(candidate: string, query: string): number {
  if (!query) return 1;
  if (candidate === query) return 5;
  if (candidate.startsWith(query)) return 4;
  if (candidate.includes(query)) return 3;
  return fuzzy(candidate, query) ? 2 : 0;
}

function fuzzy(candidate: string, query: string): boolean {
  let j = 0;
  for (let i = 0; i < candidate.length && j < query.length; i++) {
    if (candidate[i] === query[j]) j += 1;
  }
  return j === query.length;
}
