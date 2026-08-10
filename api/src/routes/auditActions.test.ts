import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The frontend maps each audit action to a human label and falls back to the raw string, so a
// new action added on the server shows up in the activity log as "proposed_change.revised" until
// someone notices. This test fails the moment the two lists drift apart.
const API_DIR = resolve(__dirname, "..");
// The label map lives with the other formatting helpers, not in App.
const WEB_FORMAT = resolve(__dirname, "../../../web/src/lib/format.ts");

function auditActionsWrittenByApi() {
  const sources = ["routes/documents.ts", "routes/workspaces.ts", "routes/editor.ts"].map((file) =>
    readFileSync(resolve(API_DIR, file), "utf8")
  );

  const actions = new Set<string>();
  for (const source of sources) {
    // Anchored on `action:` so unrelated dotted strings (a "document.docx" filename, say) are not
    // mistaken for actions. The window covers the ternary form used for conditional actions.
    for (const site of source.matchAll(/action:\s*([^,\n]*(?:\n[^,\n]*)?)/g)) {
      for (const literal of site[1].matchAll(/"([a-z_]+\.[a-z_]+)"/g)) {
        actions.add(literal[1]);
      }
    }
  }

  return actions;
}

function auditActionsLabelledByWeb() {
  const source = readFileSync(WEB_FORMAT, "utf8");
  const start = source.indexOf("const AUDIT_ACTION_LABELS");
  const end = source.indexOf("};", start);
  const block = source.slice(start, end);

  const labelled = new Set<string>();
  for (const match of block.matchAll(/"([a-z_]+\.[a-z_]+)":/g)) {
    labelled.add(match[1]);
  }

  return labelled;
}

describe("audit action labels", () => {
  it("gives every action the API writes a human-readable label", () => {
    const written = auditActionsWrittenByApi();
    const labelled = auditActionsLabelledByWeb();

    expect(written.size).toBeGreaterThan(0);

    const unlabelled = [...written].filter((action) => !labelled.has(action)).sort();
    expect(unlabelled).toEqual([]);
  });

  it("does not label actions the API never writes", () => {
    const written = auditActionsWrittenByApi();
    const labelled = auditActionsLabelledByWeb();

    const stale = [...labelled].filter((action) => !written.has(action)).sort();
    expect(stale).toEqual([]);
  });
});
