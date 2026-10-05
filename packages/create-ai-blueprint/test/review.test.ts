import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  parseIndependentReview,
  readIndependentReview
} from "../lib/review.js";

const execFileAsync = promisify(execFile);
const TARGET = "1".repeat(40);
const BASE = "2".repeat(40);
const SPEC_HASH = "3".repeat(64);

test("parseIndependentReview recognizes the reset stub", () => {
  const review = parseIndependentReview(`# Independent Review

_No independent review requested. Run /audit independent current to prepare one._
`);

  assert.equal(review.state, "none");
  assert.equal(review.freshness, "not-applicable");
  assert.deepEqual(review.warnings, []);
});

test("parseIndependentReview reads pending and completed records", () => {
  const pending = parseIndependentReview(
    reviewRecord("pending", false, { requested: "automatic" })
  );

  assert.equal(pending.state, "pending");
  assert.equal(pending.targetCommit, TARGET);
  assert.equal(pending.requestedReviewer, "claude");
  assert.equal(pending.requestedModel, "claude-opus");
  assert.equal(pending.requestedExecution, "automatic");

  const passed = parseIndependentReview(reviewRecord("passed", true));

  assert.equal(passed.state, "passed");
  assert.equal(passed.reviewerAdapter, "claude");
  assert.equal(passed.reviewerModel, "claude-opus");
  assert.equal(passed.reviewerContext, "fresh session");
  assert.equal(passed.requestedExecution, null);
  assert.equal(passed.actualExecution, null);
  assert.equal(passed.checkResult, "not-required");

  const subagent = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "automatic",
      actual: "automatic",
      context: "fresh subagent"
    })
  );
  assert.equal(subagent.state, "passed");
  assert.equal(subagent.reviewerContext, "fresh subagent");
  assert.equal(subagent.requestedExecution, "automatic");
  assert.equal(subagent.actualExecution, "automatic");
});

test("parseIndependentReview accepts Google Antigravity reviewer metadata", () => {
  const review = parseIndependentReview(
    reviewRecord("passed", true)
      .replace("**Prepared by:** codex", "**Prepared by:** antigravity")
      .replace("**Requested reviewer:** claude", "**Requested reviewer:** antigravity")
      .replace("**Reviewer adapter:** claude", "**Reviewer adapter:** antigravity")
  );

  assert.equal(review.state, "passed");
  assert.equal(review.preparedBy, "antigravity");
  assert.equal(review.requestedReviewer, "antigravity");
  assert.equal(review.reviewerAdapter, "antigravity");
});

test("parseIndependentReview keeps legacy pending and completed reviews manual-only", () => {
  const pending = parseIndependentReview(reviewRecord("pending"));
  assert.equal(pending.state, "pending");
  assert.equal(pending.requestedExecution, null);

  const completed = parseIndependentReview(reviewRecord("passed", true));
  assert.equal(completed.state, "passed");
  assert.equal(completed.reviewerContext, "fresh session");
  assert.equal(completed.requestedExecution, null);
  assert.equal(completed.actualExecution, null);

  const actualAdded = parseIndependentReview(
    reviewRecord("passed", true).replace(
      "**Reviewer context:** fresh session",
      "**Reviewer context:** fresh session\n**Actual execution:** manual"
    )
  );
  assert.equal(actualAdded.state, "malformed");

  const pendingActualAdded = parseIndependentReview(
    reviewRecord("pending").replace(
      "**Requested at:**",
      "**Actual execution:** manual\n**Requested at:**"
    )
  );
  assert.equal(pendingActualAdded.state, "malformed");

  const subagent = parseIndependentReview(
    reviewRecord("passed", true).replace(
      "**Reviewer context:** fresh session",
      "**Reviewer context:** fresh subagent"
    )
  );
  assert.equal(subagent.state, "malformed");
});

test("parseIndependentReview accepts an explicit automatic-to-manual fallback", () => {
  const review = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "automatic",
      actual: "manual",
      context: "fresh session"
    })
  );

  assert.equal(review.state, "passed");
  assert.equal(review.requestedExecution, "automatic");
  assert.equal(review.actualExecution, "manual");
});

test("parseIndependentReview accepts an explicitly bound manual review", () => {
  const review = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "manual",
      actual: "manual",
      context: "fresh session"
    })
  );

  assert.equal(review.state, "passed");
  assert.equal(review.requestedExecution, "manual");
  assert.equal(review.actualExecution, "manual");
});

test("parseIndependentReview rejects invalid execution and context pairings", () => {
  const manualSubagent = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "manual",
      actual: "automatic",
      context: "fresh subagent"
    })
  );
  assert.equal(manualSubagent.state, "malformed");

  const mismatchedAutomatic = parseIndependentReview(
    reviewRecord("passed", true, {
      requested: "automatic",
      actual: "automatic",
      context: "fresh session"
    })
  );
  assert.equal(mismatchedAutomatic.state, "malformed");

});

test("parseIndependentReview rejects incomplete receipts", () => {
  const review = parseIndependentReview(`# Independent Review

**Status:** passed
**Target commit:** ${TARGET}
`);

  assert.equal(review.state, "malformed");
  assert.equal(review.warnings[0]?.code, "malformed_review");
});

test("parseIndependentReview accepts only one canonical optional spec snapshot", () => {
  const snapshot = `blueprint/.state/review-specs/${TARGET}-${SPEC_HASH}.md`;
  const withSnapshot = (value: string) => reviewRecord("pending").replace(
    "**Prepared by:**", `**Spec snapshot:** ${value}\n**Prepared by:**`
  );
  assert.equal(parseIndependentReview(withSnapshot(snapshot)).specSnapshot, snapshot);
  assert.equal(parseIndependentReview(reviewRecord("pending")).specSnapshot, null);
  for (const value of ["", "/tmp/spec.md", `../${snapshot}`, `${snapshot}/../spec.md`, snapshot.replace(TARGET, BASE)]) {
    assert.equal(parseIndependentReview(withSnapshot(value)).state, "malformed", value);
  }
  assert.equal(parseIndependentReview(withSnapshot(`${snapshot}\n**Spec snapshot:** ${snapshot}`)).state, "malformed");
});

test("parseIndependentReview rejects an unsupported reviewer context", () => {
  const review = parseIndependentReview(
    reviewRecord("passed", true).replace(
      "**Reviewer context:** fresh session",
      "**Reviewer context:** builder session"
    )
  );

  assert.equal(review.state, "malformed");
});

test("parseIndependentReview requires completed evidence and a passing required Check", () => {
  const withoutEvidence = parseIndependentReview(
    reviewRecord("passed", true).replace(/\n## Commands[\s\S]*$/, "\n")
  );
  assert.equal(withoutEvidence.state, "malformed");

  const failedRequiredCheck = parseIndependentReview(
    reviewRecord("passed", true)
      .replace("**Check required:** no", "**Check required:** yes")
      .replace("**Check result:** not-required", "**Check result:** failed")
  );
  assert.equal(failedRequiredCheck.state, "malformed");

  const passedRequiredCheck = parseIndependentReview(
    reviewRecord("passed", true)
      .replace("**Check required:** no", "**Check required:** yes")
      .replace("**Check result:** not-required", "**Check result:** passed")
  );
  assert.equal(passedRequiredCheck.state, "passed");

  const unresolvedReviewerModel = parseIndependentReview(
    reviewRecord("passed", true)
      .replace(
        "**Requested model:** claude-opus",
        "**Requested model:** runtime default (exact model not known until reviewer starts)"
      )
      .replace(
        "**Reviewer model:** claude-opus",
        "**Reviewer model:** runtime default (exact model not known until reviewer starts)"
      )
  );
  assert.equal(unresolvedReviewerModel.state, "malformed");
});

test("readIndependentReview marks product changes stale but ignores review evidence", async (t) => {
  const projectRoot = await createProject(t);
  const currentWorkPath = path.join(
    projectRoot,
    "blueprint",
    "context",
    "current-feature.md"
  );
  const currentWork = await fs.readFile(currentWorkPath, "utf8");
  const target = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  const base = await runGit(projectRoot, ["rev-parse", "main"]);
  const specHash = createHash("sha256").update(currentWork).digest("hex");
  const reviewPath = path.join(projectRoot, "blueprint", "context", "review.md");
  const findingsPath = path.join(projectRoot, "blueprint", "context", "findings.md");

  await fs.writeFile(
    reviewPath,
    reviewRecord("passed", true)
      .replaceAll(TARGET, target)
      .replaceAll(BASE, base)
      .replaceAll(SPEC_HASH, specHash)
  );
  await fs.appendFile(findingsPath, "\nReview evidence.\n");

  const current = await readIndependentReview(projectRoot);
  assert.equal(current.state, "passed");
  assert.equal(current.freshness, "current");

  await fs.writeFile(
    reviewPath,
    (await fs.readFile(reviewPath, "utf8")).replace(
      "**Reviewer adapter:** claude",
      "**Reviewer adapter:** codex"
    )
  );
  const mismatched = await readIndependentReview(projectRoot);
  assert.equal(mismatched.freshness, "stale");
  await fs.writeFile(
    reviewPath,
    (await fs.readFile(reviewPath, "utf8")).replace(
      "**Reviewer adapter:** codex",
      "**Reviewer adapter:** claude"
    )
  );

  await fs.appendFile(path.join(projectRoot, "src.ts"), "export const changed = true;\n");

  const stale = await readIndependentReview(projectRoot);
  assert.equal(stale.freshness, "stale");
});

test("readIndependentReview rejects an incorrect base and reviewer model", async (t) => {
  const projectRoot = await createProject(t);
  const currentWorkPath = path.join(
    projectRoot,
    "blueprint",
    "context",
    "current-feature.md"
  );
  const currentWork = await fs.readFile(currentWorkPath, "utf8");
  const target = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  const base = await runGit(projectRoot, ["rev-parse", "main"]);
  const specHash = createHash("sha256").update(currentWork).digest("hex");
  const reviewPath = path.join(projectRoot, "blueprint", "context", "review.md");
  const completed = reviewRecord("passed", true)
    .replaceAll(TARGET, target)
    .replaceAll(BASE, base)
    .replaceAll(SPEC_HASH, specHash);

  await fs.writeFile(
    reviewPath,
    completed.replace("**Base commit:** " + base, "**Base commit:** " + BASE)
  );
  assert.equal((await readIndependentReview(projectRoot)).freshness, "stale");

  await fs.writeFile(
    reviewPath,
    completed.replace("**Reviewer model:** claude-opus", "**Reviewer model:** claude-sonnet")
  );
  assert.equal((await readIndependentReview(projectRoot)).freshness, "stale");

  await fs.writeFile(
    reviewPath,
    completed.replace("**Base ref:** main", "**Base ref:** feature/review")
  );
  assert.equal((await readIndependentReview(projectRoot)).freshness, "stale");

  await fs.writeFile(
    reviewPath,
    completed.replace(
      "**Requested model:** claude-opus",
      "**Requested model:** runtime default (exact model not known until reviewer starts)"
    )
  );
  assert.equal((await readIndependentReview(projectRoot)).freshness, "current");
});

test("readIndependentReview binds an ignored Unicode CRLF spec to exact local bytes", async (t) => {
  const fixture = await createLocalReview(t);
  const review = await readIndependentReview(fixture.projectRoot);

  assert.equal(review.state, "passed");
  assert.equal(review.freshness, "current");
  assert.equal(review.specSnapshot, fixture.snapshot);
  assert.deepEqual(await fs.readFile(fixture.snapshotPath), fixture.spec);
  assert.equal(await runGit(fixture.projectRoot, ["ls-files", "--", fixture.specPath, fixture.snapshotPath]), "");
  assert.equal(await runGit(fixture.projectRoot, ["ls-tree", fixture.target, "--", "blueprint/context/current-feature.md", fixture.snapshot]), "");

  await fs.writeFile(fixture.reviewPath, fixture.record.replace(`**Spec snapshot:** ${fixture.snapshot}\n`, ""));
  assert.equal((await readIndependentReview(fixture.projectRoot)).freshness, "current", "legacy no-snapshot acceptance is unchanged");
});

test("readIndependentReview rejects changed or missing snapshot inputs", async (t) => {
  for (const input of ["specPath", "snapshotPath"] as const) {
    for (const change of ["mutated", "missing", "directory"]) {
      await t.test(`${input} ${change}`, async (t) => {
        const fixture = await createLocalReview(t);
        if (change === "mutated") {
          await fs.writeFile(fixture[input], fixture.spec.toString("utf8").replaceAll("\r\n", "\n"));
        } else {
          await fs.unlink(fixture[input]);
          if (change === "directory") await fs.mkdir(fixture[input]);
        }
        assert.equal((await readIndependentReview(fixture.projectRoot)).freshness, "stale");
      });
    }
  }
});

test("readIndependentReview rejects symbolic-link local inputs and parents", async (t) => {
  const inputs = [
    ["spec", "blueprint/context/current-feature.md", "file"],
    ["snapshot", "snapshot", "file"],
    ["context", "blueprint/context", "dir"],
    ["state", "blueprint/.state", "dir"],
    ["review-specs", "blueprint/.state/review-specs", "dir"],
    ["root", "", "dir"],
    ["dangling", "snapshot", "file"]
  ] as const;
  for (const [input, relative, type] of inputs) {
    await t.test(input, async (t) => {
      const fixture = await createLocalReview(t);
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-review-outside-"));
      t.after(() => fs.rm(outside, { recursive: true, force: true }));
      const original = relative === "snapshot" ? fixture.snapshotPath : path.join(fixture.projectRoot, relative);
      if (input === "root") {
        const alias = path.join(outside, "project");
        await fs.symlink(original, alias, "dir");
        assert.equal((await readIndependentReview(alias)).freshness, "stale");
      } else {
        const moved = path.join(outside, "input");
        await fs.rename(original, moved);
        await fs.symlink(input === "dangling" ? path.join(outside, "absent") : moved, original, type);
        assert.equal((await readIndependentReview(fixture.projectRoot)).freshness, "stale");
      }
    });
  }
});

test("readIndependentReview requires ignored and untracked snapshot inputs", async (t) => {
  for (const input of ["specPath", "snapshotPath"] as const) {
    await t.test(`indexed ${input}`, async (t) => {
      const fixture = await createLocalReview(t);
      await runGit(fixture.projectRoot, ["add", "-f", "--", fixture[input]]);
      assert.equal((await readIndependentReview(fixture.projectRoot)).freshness, "stale");
    });
    await t.test(`unignored ${input}`, async (t) => {
      const fixture = await createLocalReview(t);
      await fs.writeFile(path.join(fixture.projectRoot, ".git", "info", "exclude"),
        input === "specPath" ? "/blueprint/.state/review-specs/\n" : "/blueprint/context/current-feature.md\n");
      assert.equal((await readIndependentReview(fixture.projectRoot)).freshness, "stale");
    });
  }
});

test("readIndependentReview rejects a spec contained in the product checkpoint", async (t) => {
  const projectRoot = await createProject(t, true);
  await runGit(projectRoot, ["add", "-f", "blueprint/context/current-feature.md"]);
  await runGit(projectRoot, ["commit", "-m", "test: tracked local spec"]);
  const fixture = await writeLocalReview(projectRoot, "passed");
  await runGit(projectRoot, ["rm", "--cached", "blueprint/context/current-feature.md"]);

  assert.equal(await runGit(projectRoot, ["ls-files", "--", fixture.specPath]), "");
  assert.notEqual(await runGit(projectRoot, ["ls-tree", fixture.target, "--", "blueprint/context/current-feature.md"]), "");
  assert.equal((await readIndependentReview(projectRoot)).freshness, "stale");
});

test("local spec-only rereview uses a new snapshot and request at the same product HEAD", async (t) => {
  const original = await createLocalReview(t);
  await fs.appendFile(original.specPath, "\r\nRequire accessible labels.\r\n");
  assert.equal((await readIndependentReview(original.projectRoot)).freshness, "stale");
  const pending = await writeLocalReview(original.projectRoot, "pending");
  assert.equal(pending.target, original.target);
  assert.notEqual(pending.snapshot, original.snapshot);
  assert.deepEqual(await fs.readFile(original.snapshotPath), original.spec);
  assert.equal((await readIndependentReview(original.projectRoot)).state, "pending");
  assert.equal((await readIndependentReview(original.projectRoot)).freshness, "current");

  const passed = reviewRecord("passed", true)
    .replaceAll(TARGET, pending.target).replaceAll(BASE, pending.base).replaceAll(SPEC_HASH, pending.specHash)
    .replace("**Prepared by:**", `**Spec snapshot:** ${pending.snapshot}\n**Prepared by:**`);
  await fs.writeFile(pending.reviewPath, passed);
  assert.equal((await readIndependentReview(original.projectRoot)).freshness, "current");
  await fs.appendFile(path.join(original.projectRoot, "src.ts"), "export const drift = true;\n");
  assert.equal((await readIndependentReview(original.projectRoot)).freshness, "stale");
  await runGit(original.projectRoot, ["add", "src.ts"]);
  await runGit(original.projectRoot, ["commit", "-m", "test: later product work"]);
  assert.equal((await readIndependentReview(original.projectRoot)).freshness, "stale");
});

test("a local snapshot does not bypass changed base evidence or Git failures", async (t) => {
  const fixture = await createLocalReview(t);
  await runGit(fixture.projectRoot, ["update-ref", "refs/heads/main", fixture.target]);
  assert.equal((await readIndependentReview(fixture.projectRoot)).freshness, "stale");
  await runGit(fixture.projectRoot, ["update-ref", "refs/heads/main", fixture.base]);
  await fs.rename(path.join(fixture.projectRoot, ".git"), path.join(fixture.projectRoot, "git-unavailable"));
  assert.notEqual((await readIndependentReview(fixture.projectRoot)).freshness, "current");
});

function reviewRecord(
  status: "changes-requested" | "passed" | "pending",
  completed = false,
  execution?: {
    requested: "automatic" | "manual";
    actual?: "automatic" | "manual";
    context?: "fresh session" | "fresh subagent";
  }
): string {
  return `# Independent Review

**Status:** ${status}
**Target commit:** ${TARGET}
**Base commit:** ${BASE}
**Base ref:** main
**Spec hash:** ${SPEC_HASH}
**Prepared by:** codex
**Builder model:** gpt-builder
**Requested reviewer:** claude
**Requested model:** claude-opus
${execution ? `**Requested execution:** ${execution.requested}\n` : ""}**Requested at:** 2026-08-31T11:00:00Z
**Workflow:** regular
**Check required:** no
${completed ? `**Reviewer adapter:** claude
**Reviewer model:** claude-opus
**Reviewer context:** ${execution?.context || "fresh session"}
${execution?.actual ? `**Actual execution:** ${execution.actual}\n` : ""}**Reviewed at:** 2026-08-31T12:00:00Z
**Scope:** current
**Lenses:** quality, security, performance, tests
**Verdict:** ${status}
**Check result:** not-required

## Commands

- \`npm test\`: passed

## Evidence

- Unit test output reviewed.

## Findings

- None

## Remaining risk

- None identified
` : ""}`;
}

async function createLocalReview(t: TestContext) {
  const projectRoot = await createProject(t, true);
  return writeLocalReview(projectRoot, "passed");
}

async function writeLocalReview(projectRoot: string, state: "passed" | "pending") {
  const specPath = path.join(projectRoot, "blueprint/context/current-feature.md");
  const spec = await fs.readFile(specPath);
  const specHash = createHash("sha256").update(spec).digest("hex");
  const target = await runGit(projectRoot, ["rev-parse", "HEAD"]);
  const base = await runGit(projectRoot, ["rev-parse", "main"]);
  const snapshot = `blueprint/.state/review-specs/${target}-${specHash}.md`;
  const snapshotPath = path.join(projectRoot, snapshot);
  const reviewPath = path.join(projectRoot, "blueprint/context/review.md");
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
  await fs.writeFile(snapshotPath, spec, { flag: "wx" });
  const record = reviewRecord(state, state === "passed")
    .replaceAll(TARGET, target).replaceAll(BASE, base).replaceAll(SPEC_HASH, specHash)
    .replace("**Prepared by:**", `**Spec snapshot:** ${snapshot}\n**Prepared by:**`);
  await fs.writeFile(reviewPath, record);
  return { projectRoot, specPath, spec, specHash, target, base, snapshot, snapshotPath, reviewPath, record };
}

async function createProject(t: TestContext, localSpec = false): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blueprint-review-"));
  const contextRoot = path.join(projectRoot, "blueprint", "context");
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));

  await fs.mkdir(contextRoot, { recursive: true });
  await fs.writeFile(
    path.join(contextRoot, "current-feature.md"),
    localSpec
      ? "# Feature: Résumé export\r\n\r\n**Status:** verified\r\n\r\n- [x] Preserve café ☕ labels.\r\n"
      : "# Feature: Review receipt\n\n**Status:** in progress\n"
  );
  await fs.writeFile(path.join(contextRoot, "findings.md"), "# Findings\n");
  await fs.writeFile(
    path.join(contextRoot, "review.md"),
    "# Independent Review\n\n_No independent review requested.\n"
  );
  await fs.writeFile(path.join(projectRoot, "src.ts"), "export {};\n");
  await runGit(projectRoot, ["init", "-b", "main"]);
  await runGit(projectRoot, ["config", "user.email", "review@example.com"]);
  await runGit(projectRoot, ["config", "user.name", "Review Test"]);
  await runGit(projectRoot, ["config", "core.autocrlf", "false"]);
  await runGit(projectRoot, ["config", "commit.gpgsign", "false"]);
  await runGit(projectRoot, ["config", "core.hooksPath", path.join(projectRoot, "no-hooks")]);
  if (localSpec) {
    await fs.writeFile(path.join(projectRoot, ".git", "info", "exclude"),
      "/blueprint/context/current-feature.md\n/blueprint/.state/review-specs/\n");
  }
  await runGit(projectRoot, ["add", "."]);
  await runGit(projectRoot, ["commit", "-m", "chore: create review fixture"]);
  await runGit(projectRoot, ["switch", "-c", "feature/review"]);
  await fs.appendFile(path.join(projectRoot, "src.ts"), "export const feature = true;\n");
  await runGit(projectRoot, ["add", "src.ts"]);
  await runGit(projectRoot, ["commit", "-m", "feat: add review target"]);
  return projectRoot;
}

async function runGit(projectRoot: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
    encoding: "utf8"
  });
  return result.stdout.trim();
}
