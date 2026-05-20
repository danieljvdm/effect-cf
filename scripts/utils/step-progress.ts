const STATUS_STREAM = process.stderr;

export const IS_TTY = STATUS_STREAM.isTTY === true;

export const GREEN = IS_TTY ? "\x1b[32m" : "";
export const RED = IS_TTY ? "\x1b[31m" : "";
export const YELLOW = IS_TTY ? "\x1b[33m" : "";
export const DIM = IS_TTY ? "\x1b[90m" : "";
export const RESET = IS_TTY ? "\x1b[0m" : "";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_INTERVAL_MS = 80;

export type StepStatus =
  | { readonly kind: "running"; readonly note?: string }
  | { readonly kind: "ok"; readonly timing: string; readonly summary?: string }
  | { readonly kind: "fail"; readonly timing: string; readonly reason: string }
  | { readonly kind: "skip"; readonly timing: string; readonly reason: string };

export interface ProgressBoard {
  readonly setStatus: (index: number, status: StepStatus) => void;
  readonly setRunningNote: (index: number, note: string | undefined) => void;
  readonly stop: () => void;
}

export function formatTiming(elapsedMs: number): string {
  const seconds = elapsedMs / 1000;
  const value = seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(2);
  return `${DIM}[${value}s]${RESET}`;
}

function renderRow(label: string, status: StepStatus, frame: number): string {
  switch (status.kind) {
    case "running": {
      const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
      const tail = status.note ? ` ${DIM}${status.note}${RESET}` : "";
      return `${DIM}${spinner}${RESET} ${label}${tail}`;
    }
    case "ok": {
      const tail = status.summary ? ` ${DIM}- ${status.summary}${RESET}` : "";
      return `${GREEN}✓${RESET} ${label}${tail} ${status.timing}`;
    }
    case "fail":
      return `${RED}✗${RESET} ${label} failed ${status.timing}`;
    case "skip":
      return `${YELLOW}!${RESET} ${label} skipped ${status.timing}`;
  }
}

export function startProgressBoard(labels: ReadonlyArray<string>): ProgressBoard {
  const statuses: Array<StepStatus> = labels.map(() => ({ kind: "running" }));
  let frame = 0;

  if (IS_TTY) {
    for (let i = 0; i < labels.length; i += 1) {
      STATUS_STREAM.write(`${renderRow(labels[i]!, statuses[i]!, 0)}\n`);
    }
  }

  const repaint = () => {
    if (!IS_TTY) return;
    STATUS_STREAM.write(`\x1b[${labels.length}A`);
    for (let i = 0; i < labels.length; i += 1) {
      STATUS_STREAM.write(`\r\x1b[2K${renderRow(labels[i]!, statuses[i]!, frame)}\n`);
    }
  };

  const timer: ReturnType<typeof setInterval> | null = IS_TTY
    ? setInterval(() => {
        frame += 1;
        repaint();
      }, FRAME_INTERVAL_MS)
    : null;

  return {
    setStatus(index, status) {
      statuses[index] = status;
      if (IS_TTY) {
        repaint();
        return;
      }
      if (status.kind !== "running") {
        STATUS_STREAM.write(`${renderRow(labels[index]!, status, 0)}\n`);
      }
    },
    setRunningNote(index, note) {
      const current = statuses[index];
      if (!current || current.kind !== "running") return;
      statuses[index] = { kind: "running", note };
      if (IS_TTY) repaint();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (IS_TTY) repaint();
      for (let i = 0; i < statuses.length; i += 1) {
        const status = statuses[i]!;
        if (status.kind === "fail") {
          STATUS_STREAM.write(`${RED}error${RESET} (${labels[i]}): ${status.reason}\n`);
        } else if (status.kind === "skip") {
          STATUS_STREAM.write(`${YELLOW}reason${RESET} (${labels[i]}): ${status.reason}\n`);
        }
      }
    },
  };
}
