// Tool definitions for the reMem MCP server. Descriptions are written for the
// model that has to choose between them, so each says when to reach for it.

export const TOOLS = [
  {
    name: "recall",
    description:
      "Retrieve what is known about the user or this project before answering. Returns a compact, ranked context pack plus belief ids. Abstains and returns nothing when no stored memory is relevant, which is a real answer and not a failure.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "What you want to know, in natural language.",
        },
        project: {
          type: "string",
          description:
            "Optional project scope, usually the repository root. Omit to search memory that holds anywhere.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Record something durable the user has told you: a preference, a decision, a correction of something you previously believed. Appends to an immutable ledger; beliefs are derived from it later, so a later contradiction supersedes an earlier value rather than overwriting it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description:
            "The observation, in the user's own terms where possible.",
        },
        project: {
          type: "string",
          description:
            "Optional project scope. Set it when the fact is about this codebase; omit it when the fact is about the user.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "beliefs",
    description:
      "List the currently active beliefs with their ids and time-decayed confidence. Use it to inspect what the memory holds, or to find a belief id to pass to why.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "search",
    description:
      "Search memory by keyword: everything the user has said, every account of past work, and every belief. Use it to answer 'have we done this before', 'what did I say about X', or to find an id to pass to timeline or why. Different from recall, which ranks semantically for context; this is a literal search a person would recognise.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Words to look for." },
        project: {
          type: "string",
          description: "Optional project name to search within.",
        },
        kinds: {
          type: "string",
          description:
            "Comma-separated subset of: observation, episode, belief. Omit for all three.",
        },
        limit: { type: "number", description: "Maximum results (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "history",
    description:
      "Read back what happened around a point in time: the observations and accounts either side of an anchor. Use after search to see the context a single result sat in, rather than judging it alone.",
    inputSchema: {
      type: "object" as const,
      properties: {
        anchor: {
          type: "string",
          description:
            "An observation or episode id from search. Omit to start from the most recent activity.",
        },
        project: { type: "string", description: "Optional project name." },
        before: {
          type: "number",
          description: "How much to show before (default 5).",
        },
        after: {
          type: "number",
          description: "How much to show after (default 5).",
        },
      },
    },
  },
  {
    name: "observation",
    description:
      "Fetch one observation or account in full, with everything derived from it. Use when search returned an excerpt and you need the exact words, or need to know what a statement led memory to believe.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "An observation or episode id, as returned by search.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "why",
    description:
      "Explain a belief: return it with the ledger observations that justify it. Use when the user asks why you think something, or to check a belief before relying on it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        belief_id: {
          type: "string",
          description: "A belief id, as returned by recall or beliefs.",
        },
      },
      required: ["belief_id"],
    },
  },
];
