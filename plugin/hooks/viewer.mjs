#!/usr/bin/env node
// SessionStart: make sure the viewer is up.
//
// A window onto your memory is only useful if it is there when you look. This
// starts one if none is running and does nothing if one is, so the address
// stays valid across reboots, crashes and closed terminals without anyone
// having to remember a command.
//
// It must never delay a session. Everything here is a file read, a signal, and
// a 150ms socket probe; the viewer itself is spawned detached and this exits
// without waiting for it.
//
// Set REMEM_VIEWER=off to stop it starting one.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { kernelRoot, exitIfInternal, survive } from "./_shared.mjs";

exitIfInternal();

const STATE = join(homedir(), ".remem", "viewer.json");

// Where a viewer lives unless told otherwise. Kept in step with the server.
const BASE_PORT = 37800;

function claim() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return undefined;
  }
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A pid can be reused, so being alive is not enough: something has to be
// answering on the port before we believe a viewer is there.
function portAnswers(port, timeoutMs = 150) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

try {
  if (process.env.REMEM_VIEWER === "off") process.exit(0);

  // Two ways to already be running, and the port is the one that matters. The
  // claim file is a hint: it can be stale, and a viewer that stepped aside for
  // an instance it found never wrote one at all. Something answering on the
  // canonical port is the fact.
  const running = claim();
  if (
    running &&
    processAlive(running.pid) &&
    (await portAnswers(running.port))
  ) {
    process.exit(0);
  }
  if (await portAnswers(BASE_PORT)) process.exit(0);

  const root = kernelRoot();
  if (!root) process.exit(0);

  const entry = join(root, "dist", "viewer", "server.js");
  if (!existsSync(entry)) process.exit(0);

  // Detached and unref'd: it outlives this hook, this session, and this
  // terminal. Its output goes nowhere, because a background process writing to
  // a session's stdio corrupts what the user is reading.
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, REMEM_INTERNAL: "" },
  });
  child.unref();
} catch (err) {
  survive(err);
}
