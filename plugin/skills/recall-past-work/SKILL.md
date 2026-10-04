---
name: recall-past-work
description: Search reMem's memory of past sessions - what the user said, what was done, and what memory believes. Use when the user asks "did we already do this", "what did I say about X", "how did we solve this last time", or when a belief needs checking before you rely on it.
---

# Recalling past work

reMem holds three different things, and knowing which one answers the question
saves both time and tokens.

| What you need                          | Where it is                             | Tool                         |
| -------------------------------------- | --------------------------------------- | ---------------------------- |
| Something the user stated              | the ledger, verbatim and permanent      | `search`, then `observation` |
| What happened in a past session        | episodes, a written account of the work | `search`                     |
| What memory currently holds to be true | beliefs, with confidence and provenance | `recall`, `beliefs`, `why`   |

## Searching

Start with `search`. It returns ids first on every line, because the next call
is almost always `observation(id)`.

```
search(query="deployment", project="widget-svc", limit=20)
```

Filter the result yourself, then fetch only what you actually need:

```
observation(id="<id from search>")
```

That returns the exact words, plus what memory made of them. Do not fetch every
result; the whole point of the two steps is that you read the index first.

To see what surrounded a result rather than judging it alone:

```
history(anchor="<id>", before=5, after=5)
```

## Beliefs, and checking them

`recall(query)` is different from `search`. It ranks semantically and returns a
compact context pack for answering, and it abstains when nothing is relevant.
An empty answer is a real answer, not a failure: prefer it to guessing.

Before relying on a belief, check it:

```
why(belief_id="<id>")
```

That returns the observations that justify it. A belief whose evidence does not
support it should be reported to the user, not quietly used.

## What not to do

- Do not use these tools for anything in the current conversation. You already
  have that. These are for sessions that have ended.
- Do not treat an episode as ground truth. An episode is a model's account of
  work, written after the fact. The ledger is what was actually said, and
  `observation` will show it.
- Do not present a superseded belief as current. Status is on every result for
  a reason.
