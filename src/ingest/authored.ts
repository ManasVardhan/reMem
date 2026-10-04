// What counts as something the user said.
//
// A prompt hook does not receive only what a person typed. The harness injects
// blocks into the same channel: notifications when a background task finishes,
// reminders, the stdout of a slash command, the text a scheduled run submits on
// nobody's behalf. All of it arrives shaped like a prompt.
//
// Recording that is worse than useless. The ledger is append-only, so a
// notification written into it is permanent, and consolidation turns it into
// beliefs: a store built this way ends up holding confident opinions about its
// own task ids and output paths rather than about the person.
//
// This is the gate. It is deliberately conservative: it removes only blocks the
// harness itself delimits, and anything it cannot recognise is treated as the
// user's words.

// Blocks that are machine-authored wherever they appear, including in the
// middle of a real prompt. Matched as pairs so the text between them goes too.
const INJECTED_BLOCKS = [
  "system-reminder",
  "task-notification",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
];

// Submitted by a schedule rather than typed by a person. These are kept: a
// routine's instructions carry real context about what the user is doing and
// how they want it done. They are labelled rather than dropped, so the viewer
// can stop calling them something the user said.
const SCHEDULED_PREFIXES = ["<<autonomous-loop", "[cron:"];

function stripBlocks(text: string): string {
  let out = text;
  for (const tag of INJECTED_BLOCKS) {
    // Paired form first, then any stray opener that ran to the end without a
    // closing tag, which is what a truncated injection looks like.
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*$`, "i"), "");
  }
  return out;
}

// Where a prompt came from.
//
//   user      a person typed it
//   scheduled a routine submitted it on their behalf
//
// Both are worth remembering. Only the first is worth calling "you said".
export type PromptOrigin = "user" | "scheduled";

export interface AuthoredPrompt {
  content: string;
  origin: PromptOrigin;
}

// Extra prefixes that mark a scheduled prompt, for routines whose text carries
// no marker of its own. Imported history is the usual case: another tool
// recorded a cron's instructions as an ordinary prompt, and nothing in the text
// says otherwise.
//
// Supplied by the caller so this module stays free of file access; the viewer
// and the hooks read ~/.remem/scheduled.json and pass it in.
export function classifyPrompt(
  raw: string,
  scheduledPrefixes: readonly string[] = [],
): AuthoredPrompt | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  // Blocks come out first. A prompt can open with an injected block and still
  // carry a real question after it, so deciding on the opening tag alone would
  // throw away the thing the person actually asked.
  const kept = stripBlocks(trimmed).trim();
  if (kept === "") return undefined;

  const lowered = kept.toLowerCase();
  const scheduled =
    SCHEDULED_PREFIXES.some((p) => lowered.startsWith(p)) ||
    scheduledPrefixes.some(
      (p) => p.trim() !== "" && lowered.startsWith(p.trim().toLowerCase()),
    );

  return { content: kept, origin: scheduled ? "scheduled" : "user" };
}

// The part a person or their routine actually wrote, or undefined when the text
// is machine plumbing: a notification, a reminder, command output.
export function userAuthored(raw: string): string | undefined {
  return classifyPrompt(raw)?.content;
}

export function isMachineAuthored(raw: string): boolean {
  return classifyPrompt(raw) === undefined;
}
