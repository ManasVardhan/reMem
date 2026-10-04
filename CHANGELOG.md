# Changelog

## 0.3.0

The first public release: one command to install, and benchmark claims
corrected to say what was actually measured.

### `npx remem-kernel setup`

Installing the plugin used to be several steps across npm and Claude Code, and
upgrading the package did not upgrade the plugin. `npx remem-kernel setup` adds
the reMem marketplace from GitHub, installs the plugin, fetches the kernel into
`~/.remem/runtime`, and runs `remem-doctor`. It probes what is already there
and does only the rest, so re-running it is safe and is how you upgrade.
`--dry-run` prints the plan and changes nothing. `pnpm smoke:setup` exercises
the real install in a throwaway home directory.

### Corrected benchmark framing

On MemoryAgentBench fact consolidation, the 15/100 row previously labelled
"mem0, append-only" is a no-memory baseline: MemoryAgentBench's reference
adapter extracted no facts from the benchmark's encyclopedic context, so mem0
answered from an empty memory. The README and `docs/FINDINGS.md` (F10) now say
so. The mechanism result is the supersession on/off ablation, 45 against 29
(p = 0.007); 45 against 15 is a margin over no memory. The PrefEval entry now
notes that mem0 retrieved no memories for 48 of the 75 questions under that
harness's ingestion. The Zep comparison and the MemoryBench/LoCoMo mem0 numbers
are unchanged.

### Public release

The README now links the paper,
[Measurable by Construction](https://openreview.net/forum?id=CLGN0pqSQK), and
only the public documentation (DESIGN, BENCHMARKS, FINDINGS, DATA).

## 0.2.2

A diagnostic, a safety fix, and the metadata the package should always have
carried.

### `remem-doctor`

Hooks never break a session, so they fail quietly, and a broken install looks
exactly like a working one until someone notices reMem has not learned anything
in a fortnight. `remem-doctor` reads the same kernel path the hooks read and
says what they would find: a missing kernel, a plugin copy older than the
package, a ledger that stopped growing, observations with no beliefs behind
them, no model provider, an embedder that will not load, a viewer that died
holding its port. Every finding that is not ok carries the command that fixes
it, `--json` for scripts, and a non-zero exit when something is broken.

### A viewer on another store can no longer answer for this one

The viewer announces itself in a single file, and that claim used to be a port
and nothing else. Starting a second viewer against a fixture, which is what the
demo instructions ask for, took the claim over. The hooks then used it: recall
returned another store's memories, and the write path embedded with that store's
model and wrote the vector here, into a table that is append-only. The claim now
names the store it serves and the hooks decline anything else.

### The plugin fetches its own kernel

Installing the plugin used to leave hooks that could not load anything until you
separately ran `npm i -g remem-kernel`, and nothing said so. A plugin with no
kernel now fetches one into `~/.remem/runtime` and tells you it is doing it.

### Also

- `mcpName`, plus `repository`, `homepage`, `bugs` and `keywords`. Without the
  first, the official MCP registry cannot accept the package; without the rest,
  npmjs.com cannot render the README banner or link back to the source.
- The MCP server reports the real version instead of a hardcoded `0.1.0` that
  had been wrong for three releases.
- `scripts/demo-store.mjs` builds a synthetic store, so a screenshot of the
  viewer need not be a screenshot of someone's actual memory.
- README corrections: a context-token figure that contradicted its own cited
  source, a hook that no longer exists, an unclosed code fence.

## 0.2.1

0.2.0 went to npm mid-session, before the last three changes below landed. The
registry does not allow republishing a version, so this is that same release
with the parts that missed the boat:

- memory arrives with the prompt, not only at session start
- `remem-reembed`, and recall that is about meaning rather than shared words
- the hooks borrow the viewer's warm model, 1.22s per prompt down to 0.42s

Anyone on 0.2.0 wants this one. Nothing in it is a fix to 0.2.0; it is the rest
of the same work.

## 0.2.0

reMem could form beliefs but could not show its work, and the plugin did not
survive being installed the documented way. This release fixes both.

### The viewer opens on the ledger

The page now leads with what you actually said, newest first, with what memory
currently believes folded above it. Clicking anything you said shows the words
in full, what memory made of them, and the accounts drawn from them. Clicking a
belief shows the observations that justify it and the value it superseded.

Filters for everything, only what you said, or only what happened. Search across
all three. Project selector. Light and dark. It stays a read-only window bound
to loopback that makes no network requests of its own.

### Porting from claude-mem

`remem-import` finds a claude-mem database and moves it across in one command
with no flags. Running it twice imports nothing the second time.

The mapping respects that the two systems mean different things by
"observation". Prompts become ledger observations, because they are the only
thing in that store a person actually said. claude-mem's observations are a
model's account of work written after the fact, so they become episodes, linked
to the turn that produced them rather than to the whole session.

Beliefs are not imported, because they were never there. `remem-consolidate`
derives them from the ledger you just brought across.

### Sessions and episodes

Two layers between the ledger and the belief layer, neither claiming to be
truth. A session is which observations arrived together. An episode is a
structured account of one unit of work: title, subtitle, narrative, facts,
concepts, files. Both are derived and rebuildable, and an episode must resolve
to the observations behind it.

Episodes are written once per session, not once per tool call. Memory layers
that summarise every tool call spend a model call each time; here the ledger is
written with no model at all and the account is derived at session end from
observations already recorded. That is what keeps saving a memory free.

### Search

FTS5 over the ledger and the episodes, with a LIKE fallback so a SQLite built
without FTS5 still answers. Results are balanced across kinds, so a small page
cannot be filled entirely with accounts of work while the words you typed are
pushed off it.

New MCP tools `search`, `history` and `observation` join `recall`, `remember`,
`beliefs` and `why`. `search` is what a person types into a box; `recall` is
what an agent asks before replying, and still abstains.

### Fixes

- Consolidation re-read the entire ledger at every session end, so it got
  slower for exactly the people with the most in their store. It is now
  incremental against a cursor, batched, and scoped to the session that ended.
- The cursor is the ledger's own append order. A previous attempt compared
  timestamps and then ids; ids are random, so roughly half of all
  same-millisecond appends sorted before the mark and were never consolidated.
- Claude Code copies only the plugin directory into its cache, so the hooks
  could not resolve the kernel and the MCP server pointed at a path that did
  not exist. Both now locate the installed package and remember where it was.
- Consolidation required the Agent SDK, a devDependency that ships with
  nothing, so an installed plugin never formed a belief. The `claude` CLI is
  now a provider, which is the one a plugin user already has.
- Consolidation reaches a model by launching Claude, which fired reMem's own
  hooks, so the ledger recorded reMem's consolidation prompts as things the
  user said. Both provider paths now mark the child and the hooks stand down.
- Beliefs were scoped by project name while hooks matched on the full path, so
  session start injected nothing. There is one project key now and it is the
  name, which also means a belief survives its repository moving.
- The same statement arriving twice created a duplicate belief whenever the
  model attached a slightly different scope. A CREATE matching something
  already held now reinforces it and adds its evidence.

### The ledger records the user's words, and nothing else

A scheduled run is the exception, and it is kept. A routine's instructions say
real things about what the user is doing, so they consolidate into beliefs like
anything else; they are labelled `scheduled run` rather than presented as
something the person typed. `~/.remem/scheduled.json` names routines whose text
carries no marker of its own, which is what an import from another tool leaves
behind.

Not the agent's replies, not its tool calls, and not the blocks a harness
injects into the prompt channel: task notifications, system reminders, command
output, the text a scheduled run submits on nobody's behalf.

On one real store those injections were 27% of the ledger, and had been
consolidated into confident beliefs about task ids and output paths. The agent's
own tool calls were another 388 rows.

Enforced in `observe()` rather than left to callers, because the ledger is
append-only: a mistaken row is permanent and every belief derived from it
inherits the mistake. A genuine multi-speaker corpus opts in with `ledgerActors`.
The `PostToolUse` hook is gone.

### Recall can be about meaning rather than shared words

The default embedder is a hashing trick: it matches on words in common and has
no sense of what any of them mean. Asked "when do I finish university" it could
not find a belief called `graduation_date`, and with nothing to match on the
ranking fell back to confidence and recency, so an unrelated question returned
whatever the store was most sure about.

`remem-reembed` moves a store to a local sentence model. About a minute for a
few thousand rows, entirely on the machine, and the store records which
embedder wrote it so a reader can never compare vectors from two different
ones: that does not fail, it silently returns noise.

The embedder alone was not enough. Recall blends keyword and vector scores
evenly, which is right when the vectors are hashes and wrong when they carry
meaning, so injection now leans on meaning when the store has it.

The hooks borrow the viewer's warm model over loopback rather than loading one
each. A model costs a second to load and two milliseconds to run, and every
hook is a fresh process: measured on a real store that was 1.22s per prompt,
and is now 0.42s. With no viewer running they load their own and take about
twice as long, because this is an optimisation and never a dependency.

### Memory arrives with the prompt

`UserPromptSubmit` now recalls against each prompt and prepends what bears on
it, with belief ids for `why()`. Previously memory was injected only at session
start, which means whatever was relevant before the conversation had a subject;
everything after depended on the model choosing to call a tool.

Model-free, so it costs nothing per message. It abstains unless a belief shares
a real word with the prompt, because the default embedder has no semantic
signal and would otherwise return the same high-confidence beliefs on every
turn regardless of subject. `REMEM_RECALL=off` disables it.

### One viewer, one address

`SessionStart` starts the viewer if none is running, detached, so it outlives
the session and is there the next time you look. `~/.remem/viewer.json` records
the port.

A second viewer no longer drifts onto the next free port. That is how a
bookmark ends up on a stale instance: the page still loads, so nothing looks
wrong, while it serves an older build against the same store.

### Repairing a store written before this release

A store used with 0.1.x has reMem's own consolidation prompts in its ledger,
recorded as things the user said. The ledger is append-only, so nothing in
normal operation can remove them:

```bash
node scripts/repair-self-observations.mjs          # report
node scripts/repair-self-observations.mjs --apply  # remove, after a backup
```

It uses the privileged erasure path the design reserves for data that should
never have been recorded, takes a backup first, drops anything left
unsupported, and puts the append-only triggers back inside the same
transaction.

### Also

- A statusline script, and `/remember` and `/recall` commands.
- Long snake_case predicates wrapped inside their card instead of running out
  through the border.
- 238 tests.

## 0.1.3

The redesigned viewer and current install docs.
