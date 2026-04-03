#!/usr/bin/env bun
// [gstuck] Cross-tool session scanning disabled.
console.log(JSON.stringify({
  window: "0d", start_date: new Date().toISOString().split("T")[0],
  repos: [], tools: { claude_code: { total_sessions: 0, repos: 0 }, codex: { total_sessions: 0, repos: 0 }, gemini: { total_sessions: 0, repos: 0 } },
  total_sessions: 0, total_repos: 0,
}, null, 2));
