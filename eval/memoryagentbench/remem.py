"""ReMem method for MemoryAgentBench.

ReMem is an external HTTP service, same shape as Zep (see methods/zep.py):
the harness ingests chunks into it and later queries it for relevant
memories, which are then handed to an LLM to answer the question. Unlike
Zep, the wire contract is mem0-OSS-compatible (POST /memories, POST
/search, DELETE /memories), documented in ReMem's
src/eval/mem0-adapter-server.ts. This module only serializes requests
against that contract; it does not interpret or re-rank the results.
"""

import os
import re
import requests


def get_retrieval_query(query: str) -> str:
    """Strip dataset instruction boilerplate from a formatted query, leaving
    the part worth sending to /search. Mirrors methods/zep.py's
    get_retrieval_query, minus the 400-character clamp Zep needs that this
    adapter does not.
    """
    match = re.search(r"Now Answer the Question:\s*(.*)", query, re.DOTALL)
    if match:
        return match.group(1).strip()

    match = re.search(r"Here is the conversation:\s*(.*)", query, re.DOTALL)
    if match:
        return match.group(1).strip()

    return query


def compose_search_context(results: list) -> str:
    """Format ReMem /search results into a context block for the answering
    LLM. Each result is {id, memory, score, confidence, evidence_count,
    status, created_at} per the mem0-compatible /search contract; only
    `memory` goes into the prompt. The other fields are kept in the
    retrieval log written to disk, not shown to the LLM, so the answer is
    not biased by ReMem-specific signals that other methods do not expose.
    """
    if not results:
        return "(no memories retrieved)"

    lines = [f"- {result.get('memory', '')}" for result in results]
    return "\n".join(lines)


class ReMemClient:
    """Thin HTTP client for the ReMem mem0-compatible adapter server.

    Talks to the three endpoints exposed by src/eval/mem0-adapter-server.ts:
    POST /memories, POST /search, DELETE /memories. See that file for the
    exact request and response contract. This client only serializes
    requests and raises on non-2xx responses; it adds no retry logic or
    other behavior of its own.
    """

    # POST /memories runs the LLM consolidator synchronously (observe +
    # consolidate) before responding; a single 4096-char chunk measured
    # 115-180s end to end against gpt-4o-mini, well past a 120s timeout,
    # which crashed the harness mid-memorization with no output written.
    # 600s gives headroom without hiding a genuinely stuck request forever.
    def __init__(self, base_url=None, timeout=600):
        self.base_url = (base_url or os.environ.get("REMEM_BASE_URL", "http://localhost:8899")).rstrip("/")
        self.timeout = timeout

    def health(self):
        response = requests.get(f"{self.base_url}/health", timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def add(self, user_id, timestamp, messages):
        payload = {"user_id": user_id, "timestamp": timestamp, "messages": messages}
        response = requests.post(f"{self.base_url}/memories", json=payload, timeout=self.timeout)
        response.raise_for_status()
        return response.json()

    def search(self, user_id, query, limit):
        payload = {"user_id": user_id, "query": query, "limit": limit}
        response = requests.post(f"{self.base_url}/search", json=payload, timeout=self.timeout)
        response.raise_for_status()
        return response.json().get("results", [])

    def delete(self, user_id):
        response = requests.delete(f"{self.base_url}/memories", params={"user_id": user_id}, timeout=self.timeout)
        response.raise_for_status()
        return response.json()
