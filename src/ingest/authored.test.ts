import { describe, it, expect } from "vitest";
import { userAuthored, isMachineAuthored, classifyPrompt } from "./authored.js";

describe("what counts as something the user said", () => {
  it("keeps an ordinary prompt untouched", () => {
    expect(userAuthored("use blue for the install blocks")).toBe(
      "use blue for the install blocks",
    );
  });

  it("rejects a background task notification", () => {
    // 27% of one real store was this: a permanent, append-only record of task
    // ids and output paths, consolidated into beliefs about itself.
    const raw = `<task-notification>
<task-id>a151a97d34d6056e3</task-id>
<tool-use-id>toolu_01BpEVNVQSE46YYyfLNvgcT4</tool-use-id>
<output-file>/private/tmp/claude-501/tasks/a151.output</output-file>
</task-notification>`;
    expect(userAuthored(raw)).toBeUndefined();
    expect(isMachineAuthored(raw)).toBe(true);
  });

  it("rejects a system reminder", () => {
    expect(
      userAuthored("<system-reminder>do not mention this</system-reminder>"),
    ).toBeUndefined();
  });

  it("keeps a scheduled run, but does not call it something the user said", () => {
    // A routine's instructions carry real context about what the user is doing
    // and how they want it done. Dropping them loses that; labelling them keeps
    // it without claiming the person typed it this morning.
    const cron = classifyPrompt("[cron:abc-123] Nightly crawl");
    expect(cron?.origin).toBe("scheduled");
    expect(cron?.content).toBe("[cron:abc-123] Nightly crawl");

    expect(classifyPrompt("<<autonomous-loop-dynamic>>")?.origin).toBe(
      "scheduled",
    );
  });

  it("marks a routine that carries no marker of its own", () => {
    // Imported history is the usual case: another tool recorded a cron's
    // instructions as an ordinary prompt, and nothing in the text says so.
    const raw = "Read /Users/me/notes/spec.md and execute it";
    expect(classifyPrompt(raw)?.origin).toBe("user");
    expect(classifyPrompt(raw, ["Read /Users/me/notes/spec.md"])?.origin).toBe(
      "scheduled",
    );
  });

  it("ignores blank entries in the caller's prefix list", () => {
    expect(classifyPrompt("anything", ["", "   "])?.origin).toBe("user");
  });

  it("a typed prompt is a user prompt", () => {
    expect(classifyPrompt("fix the overflow")?.origin).toBe("user");
  });

  it("keeps the human half of a prompt that carries an injected block", () => {
    const raw =
      "fix the overflow on the cards\n<system-reminder>context follows</system-reminder>";
    expect(userAuthored(raw)).toBe("fix the overflow on the cards");
  });

  it("keeps the human half when the block comes first", () => {
    const raw =
      "<system-reminder>injected</system-reminder>\nthen the actual question";
    expect(userAuthored(raw)).toBe("then the actual question");
  });

  it("handles an unclosed block, which is what a truncated injection looks like", () => {
    expect(
      userAuthored("real question\n<system-reminder>runs to the end"),
    ).toBe("real question");
  });

  it("treats an empty or whitespace prompt as nothing said", () => {
    expect(userAuthored("")).toBeUndefined();
    expect(userAuthored("   \n  ")).toBeUndefined();
  });

  it("does not strip text that merely mentions the tags", () => {
    // Conservative on purpose: someone asking about these is asking a real
    // question, and dropping it would lose the thing they actually said.
    const raw = "why does a system-reminder show up in my ledger?";
    expect(userAuthored(raw)).toBe(raw);
  });

  it("keeps a message that arrived through a channel", () => {
    // A Telegram or Slack message is a person talking, just not at a terminal.
    const raw = '<channel source="telegram" user="x">ship it</channel>';
    expect(userAuthored(raw)).toBe(raw);
  });
});
