# How to run: copy this file into the root of a checkout of
# HUST-AI-HYZ/MemoryAgentBench at commit 455306d and run it from there. It puts
# its own directory on sys.path and imports the harness's bundled `mem0` and
# `utils.templates`, so it does not work from this repository. Needs
# OPENAI_API_KEY set and MEM0_TELEMETRY=False:
#
#   MEM0_TELEMETRY=False python mem0_replay.py <context file> <output JSON>
#
# <context file> is the factconsolidation_sh_6k context as plain text; the
# output JSON records write-time events, final memories and raw LLM responses.
# The committed mem0-replay-sh_6k-2026-10-03.json is its output.
#
# Replays MemoryAgentBench's mem0 ingestion for factconsolidation_sh_6k with the
# harness's bundled mem0, logging every write-time event (ADD/UPDATE/DELETE/NONE).
import json, os, sys, time, collections
import nltk, tiktoken
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mem0.memory.main import Memory
import mem0, mem0.memory.main as _mm; print("mem0 loaded from:", _mm.__file__)
from utils.templates import get_template

def chunk_text_into_sentences(text, model_name="gpt-4o-mini", chunk_size=4096):
    # Copied from utils/eval_other_utils.py at 455306d (avoids its rouge deps).
    nltk.download('punkt', quiet=True); nltk.download('punkt_tab', quiet=True)
    enc = tiktoken.encoding_for_model(model_name)
    chunks, cur, n = [], [], 0
    for s in nltk.sent_tokenize(text):
        k = len(enc.encode(s, allowed_special={'<|endoftext|>'}))
        if n + k > chunk_size:
            chunks.append(" ".join(cur)); cur, n = [s], k
        else:
            cur.append(s); n += k
    if cur: chunks.append(" ".join(cur))
    return chunks

ctx = open(sys.argv[1]).read()
sub, agent = "factconsolidation_sh_6k", "Structure_rag_mem0"
chunks = chunk_text_into_sentences(ctx, chunk_size=4096)
print("chunks:", len(chunks))
m = Memory()
LLMLOG=[]
_g=m.llm.generate_response
def _wrap(*a,**k):
    r=_g(*a,**k); LLMLOG.append(r); print('LLM>>', str(r)[:400].replace('\n',' ')); return r
m.llm.generate_response=_wrap
print('llm model:', getattr(m.config.llm.config,'model',None) if hasattr(m.config.llm,'config') else m.config.llm)
uid = f"context_0_{sub}"
events = collections.Counter(); log = []
for i, c in enumerate(chunks):
    sysmsg = get_template(sub, 'system', agent)
    tmpl = get_template(sub, 'memorize', agent)
    msg = tmpl.format(context=c, **({'time_stamp': time.strftime("%Y-%m-%d %H:%M:%S")} if '{time_stamp}' in tmpl else {}))
    r = m.add([{"role":"system","content":sysmsg},{"role":"user","content":msg},
               {"role":"assistant","content":"I'll make sure to add the content into the memory."}], user_id=uid)
    res = r["results"] if isinstance(r, dict) else r
    for e in res:
        events[e.get("event")] += 1; log.append({"chunk": i, **e})
    print(f"chunk {i}: {collections.Counter(e.get('event') for e in res)}")
final = m.get_all(user_id=uid)
final = final["results"] if isinstance(final, dict) else final
print("TOTAL events:", dict(events), "| memories stored at end:", len(final))
json.dump({"events": dict(events), "log": log, "final_memories": final, "llm_responses": LLMLOG}, open(sys.argv[2], "w"), indent=1, default=str)
