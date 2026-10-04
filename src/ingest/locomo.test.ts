import { describe, it, expect } from "vitest";
import { ReMemKernel } from "../kernel.js";
import { locomoToObservations, type LocomoDialogue } from "./locomo.js";

// A synthetic LoCoMo-shaped dialogue: two sessions, a few turns each. Small,
// deterministic, committed as a fixture so this test is hermetic (DATA.md).
const fixture: LocomoDialogue = {
  id: "dlg-1",
  sessions: [
    {
      session_id: 1,
      timestamp: 1_000,
      turns: [
        { speaker: "Caroline", text: "I just moved to Seattle." },
        { speaker: "Assistant", text: "Welcome to Seattle!" },
      ],
    },
    {
      session_id: 2,
      timestamp: 2_000,
      turns: [
        { speaker: "Caroline", text: "I fly out of SEA now, not SFO." },
        { speaker: "Assistant", text: "Noted, SEA it is." },
        { speaker: "Caroline", text: "" },
      ],
    },
  ],
};

describe("LoCoMo ingest (Phase 1 exit criterion)", () => {
  it("maps sessions and turns into ordered observations", () => {
    const obs = locomoToObservations(fixture);
    // Empty turn is skipped -> 4 observations.
    expect(obs).toHaveLength(4);
    expect(obs[0]?.content).toBe("I just moved to Seattle.");
    expect(obs[0]?.actor).toBe("user");
    expect(obs[1]?.actor).toBe("assistant");
    expect(obs[0]?.contextSnapshot?.session).toBe("1");
    expect(obs[2]?.contextSnapshot?.session).toBe("2");
    expect(obs[0]?.meta?.dataset).toBe("locomo");
  });

  it("ingests a full dialogue into the ledger in order", async () => {
    // A two-speaker dialogue, which is why this opts in.
    const kernel = new ReMemKernel({
      ledgerActors: ["user", "assistant", "system"],
    });
    const inputs = locomoToObservations(fixture);
    await kernel.observeMany(inputs);

    const stored = kernel.observations();
    expect(stored).toHaveLength(4);
    expect(stored.map((o) => o.content)).toEqual([
      "I just moved to Seattle.",
      "Welcome to Seattle!",
      "I fly out of SEA now, not SFO.",
      "Noted, SEA it is.",
    ]);
    kernel.close();
  });
});
