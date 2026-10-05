import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

type ReviewAdapter = "claude" | "codex" | "copilot" | "opencode" | "antigravity";
type ReviewCheckResult = "failed" | "not-required" | "passed" | "unavailable";
type ReviewExecution = "automatic" | "manual";
type ReviewState = "changes-requested" | "malformed" | "none" | "passed" | "pending";
type ReviewFreshness = "current" | "not-applicable" | "stale" | "unknown";

type ReviewWarningCode =
  | "invalid_review_path"
  | "malformed_review"
  | "unsafe_review_path";

interface ReviewWarning {
  code: ReviewWarningCode;
  message: string;
}

interface IndependentReviewSummary {
  state: ReviewState;
  freshness: ReviewFreshness;
  targetCommit: string | null;
  baseCommit: string | null;
  baseRef: string | null;
  specHash: string | null;
  specSnapshot: string | null;
  preparedBy: ReviewAdapter | null;
  builderModel: string | null;
  requestedReviewer: ReviewAdapter | null;
  requestedModel: string | null;
  requestedExecution: ReviewExecution | null;
  requestedAt: string | null;
  workflow: "continuous" | "regular" | null;
  checkRequired: boolean | null;
  reviewerAdapter: ReviewAdapter | null;
  reviewerModel: string | null;
  reviewerContext: string | null;
  actualExecution: ReviewExecution | null;
  reviewedAt: string | null;
  scope: string | null;
  lenses: string[];
  verdict: "changes-requested" | "passed" | null;
  checkResult: ReviewCheckResult | null;
  warnings: ReviewWarning[];
}

const REVIEW_PATH = path.join("blueprint", "context", "review.md");
const CURRENT_WORK_PATH = path.join("blueprint", "context", "current-feature.md");
const FINDINGS_PATH = path.join("blueprint", "context", "findings.md");
const RESET_MARKER = "_No independent review requested.";
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BASE_REF_PATTERN = /^(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;
const FIELD_PATTERN = /^\*\*([^*]+):\*\*\s*(.*?)\s*$/;
const RUNTIME_DEFAULT_MODEL = "runtime default (exact model not known until reviewer starts)";
const execFileAsync = promisify(execFile);

async function readIndependentReview(
  projectRoot: string
): Promise<IndependentReviewSummary> {
  const reviewPath = path.join(projectRoot, REVIEW_PATH);

  try {
    const stats = await fs.lstat(reviewPath);

    if (stats.isSymbolicLink()) {
      return malformedSummary({
        code: "unsafe_review_path",
        message: "Independent review file is a symbolic link and was not read."
      });
    }

    if (!stats.isFile()) {
      return malformedSummary({
        code: "invalid_review_path",
        message: "Independent review path is not a regular file."
      });
    }

    const parsed = parseIndependentReview(await fs.readFile(reviewPath, "utf8"));
    if (parsed.state === "none" || parsed.state === "malformed") {
      return parsed;
    }

    return {
      ...parsed,
      freshness: await determineFreshness(projectRoot, parsed)
    };
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return emptySummary();
    }

    throw error;
  }
}

function parseIndependentReview(markdown: string): IndependentReviewSummary {
  if (markdown.includes(RESET_MARKER) && !/^\*\*Status:\*\*/m.test(markdown)) {
    return emptySummary();
  }

  const fields = new Map<string, string>();
  let snapshotFields = 0;
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(FIELD_PATTERN);
    if (match?.[1]) {
      const label = normalizeLabel(match[1]);
      fields.set(label, (match[2] || "").trim());
      if (label === "spec snapshot") snapshotFields += 1;
    }
  }

  const state = normalizeState(fields.get("status"));
  const targetCommit = normalizeHash(fields.get("target commit"), FULL_SHA_PATTERN);
  const baseCommit = normalizeHash(fields.get("base commit"), FULL_SHA_PATTERN);
  const baseRef = normalizeBaseRef(fields.get("base ref"));
  const specHash = normalizeHash(fields.get("spec hash"), HASH_PATTERN);
  const snapshotValue = fields.get("spec snapshot");
  const specSnapshot = targetCommit && specHash &&
    snapshotValue === `blueprint/.state/review-specs/${targetCommit}-${specHash}.md`
    ? snapshotValue
    : null;
  const preparedBy = normalizeAdapter(fields.get("prepared by"));
  const builderModel = normalizeText(fields.get("builder model"));
  const requestedReviewer = normalizeAdapter(fields.get("requested reviewer"));
  const requestedModel = normalizeText(fields.get("requested model"));
  const requestedExecutionValue = fields.get("requested execution");
  const requestedExecution = normalizeExecution(requestedExecutionValue);
  const requestedAt = normalizeTimestamp(fields.get("requested at"));
  const workflow = normalizeWorkflow(fields.get("workflow"));
  const checkRequired = normalizeBoolean(fields.get("check required"));
  const reviewerAdapter = normalizeAdapter(fields.get("reviewer adapter"));
  const reviewerModel = normalizeReviewerModel(fields.get("reviewer model"));
  const reviewerContext = normalizeText(fields.get("reviewer context"));
  const actualExecutionValue = fields.get("actual execution");
  const actualExecution = normalizeExecution(actualExecutionValue);
  const reviewedAt = normalizeText(fields.get("reviewed at"));
  const scope = normalizeText(fields.get("scope"));
  const lenses = normalizeLenses(fields.get("lenses"));
  const verdict = normalizeVerdict(fields.get("verdict"));
  const checkResult = normalizeCheckResult(fields.get("check result"));
  const completedSectionsValid = [
    "commands",
    "evidence",
    "findings",
    "remaining risk"
  ].every((heading) => readSection(markdown, heading) !== null);
  const commonFieldsValid =
    state !== null &&
    targetCommit !== null &&
    baseCommit !== null &&
    baseRef !== null &&
    specHash !== null &&
    (snapshotValue === undefined || (snapshotFields === 1 && specSnapshot !== null)) &&
    preparedBy !== null &&
    builderModel !== null &&
    requestedReviewer !== null &&
    requestedModel !== null &&
    requestedAt !== null &&
    workflow !== null &&
    checkRequired !== null &&
    (requestedExecutionValue === undefined || requestedExecution !== null) &&
    (actualExecutionValue === undefined || actualExecution !== null) &&
    (state !== "pending" || actualExecutionValue === undefined);
  const completedFieldsValid =
    reviewerAdapter !== null &&
    reviewerModel !== null &&
    isValidExecutionPair(
      requestedExecution,
      actualExecution,
      reviewerContext
    ) &&
    normalizeTimestamp(reviewedAt || undefined) !== null &&
    scope?.toLowerCase() === "current" &&
    ["quality", "security", "performance", "tests"].every((lens) =>
      lenses.includes(lens)
    ) &&
    verdict === state &&
    checkResult !== null &&
    completedSectionsValid &&
    (state !== "passed" || !checkRequired || checkResult === "passed") &&
    (state !== "passed" || checkRequired || checkResult === "not-required" || checkResult === "passed");

  if (
    !commonFieldsValid ||
    ((state === "passed" || state === "changes-requested") && !completedFieldsValid)
  ) {
    return malformedSummary({
      code: "malformed_review",
      message: "Independent review record is missing or has invalid required fields."
    });
  }

  return {
    state,
    freshness: "unknown",
    targetCommit,
    baseCommit,
    baseRef,
    specHash,
    specSnapshot,
    preparedBy,
    builderModel,
    requestedReviewer,
    requestedModel,
    requestedExecution,
    requestedAt,
    workflow,
    checkRequired,
    reviewerAdapter,
    reviewerModel,
    reviewerContext,
    actualExecution,
    reviewedAt,
    scope,
    lenses,
    verdict,
    checkResult,
    warnings: []
  };
}

async function determineFreshness(
  projectRoot: string,
  review: IndependentReviewSummary
): Promise<ReviewFreshness> {
  if (!review.targetCommit || !review.baseCommit || !review.baseRef || !review.specHash) {
    return "unknown";
  }

  if (
    review.reviewerAdapter &&
    review.requestedReviewer &&
    review.reviewerAdapter !== review.requestedReviewer
  ) {
    return "stale";
  }

  if (
    review.reviewerModel &&
    review.requestedModel &&
    review.requestedModel !== RUNTIME_DEFAULT_MODEL &&
    review.reviewerModel !== review.requestedModel
  ) {
    return "stale";
  }

  const [head, currentWork, mergeBase, permittedBaseRefs] = await Promise.all([
    runOptionalGit(projectRoot, ["rev-parse", "HEAD"]),
    review.specSnapshot
      ? readLocalSpecSnapshot(projectRoot, review)
      : readOptionalRegularFile(path.join(projectRoot, CURRENT_WORK_PATH)),
    runOptionalGit(projectRoot, [
      "merge-base",
      review.baseRef,
      review.targetCommit
    ]),
    readPermittedBaseRefs(projectRoot)
  ]);

  if (currentWork === null) {
    return review.specSnapshot ? "stale" : "unknown";
  }

  if (!head) {
    return "unknown";
  }

  if (
    review.baseCommit === review.targetCommit ||
    !permittedBaseRefs.has(review.baseRef) ||
    mergeBase !== review.baseCommit
  ) {
    return "stale";
  }

  const currentSpecHash = createHash("sha256").update(currentWork).digest("hex");
  if (head !== review.targetCommit || currentSpecHash !== review.specHash) {
    return "stale";
  }

  const relevantDiff = await hasRelevantDiff(projectRoot, review.targetCommit);
  return relevantDiff === null ? "unknown" : relevantDiff ? "stale" : "current";
}

async function readLocalSpecSnapshot(
  projectRoot: string,
  review: IndependentReviewSummary
): Promise<Buffer | null> {
  if (!review.specSnapshot || !review.targetCommit || !review.specHash) return null;

  try {
    const root = path.resolve(projectRoot);
    if (!(await fs.lstat(root)).isDirectory()) return null;

    const files = [CURRENT_WORK_PATH, review.specSnapshot];
    for (const file of files) {
      let directory = root;
      for (const part of file.split(/[\\/]/).slice(0, -1)) {
        directory = path.join(directory, part);
        if (!(await fs.lstat(directory)).isDirectory()) return null;
      }
      if (!(await fs.lstat(path.join(root, file))).isFile()) return null;
    }

    const [indexed, committed, ...ignored] = await Promise.all([
      runOptionalGit(root, ["ls-files", "--stage", "--", ...files]),
      runOptionalGit(root, ["ls-tree", "-z", review.targetCommit, "--", ...files]),
      ...files.map((file) => runOptionalGit(root, [
        "check-ignore", "--no-index", "--quiet", "--", file
      ]))
    ]);
    if (indexed !== "" || committed !== "" || ignored.some((result) => result === null)) {
      return null;
    }

    const contents = await Promise.all(files.map((file) => fs.readFile(path.join(root, file))));
    return contents.every((bytes) => createHash("sha256").update(bytes).digest("hex") === review.specHash)
      ? contents[0] ?? null
      : null;
  } catch {
    return null;
  }
}

async function hasRelevantDiff(
  projectRoot: string,
  targetCommit: string
): Promise<boolean | null> {
  try {
    await execFileAsync(
      "git",
      [
        "-C",
        projectRoot,
        "diff",
        "--quiet",
        targetCommit,
        "--",
        ".",
        `:(exclude)${REVIEW_PATH}`,
        `:(exclude)${FINDINGS_PATH}`
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 }
    );
  } catch (error: unknown) {
    if (getErrorCode(error) === "1") {
      return true;
    }

    return null;
  }

  const untracked = await runOptionalGit(projectRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z"
  ]);
  if (untracked === null) {
    return null;
  }

  return untracked
    .split("\0")
    .filter(Boolean)
    .some((file) => file !== REVIEW_PATH && file !== FINDINGS_PATH);
}

async function readOptionalRegularFile(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return null;
    }

    return await fs.readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function runOptionalGit(
  projectRoot: string,
  args: readonly string[]
): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function readPermittedBaseRefs(projectRoot: string): Promise<Set<string>> {
  const refs = new Set<string>();
  const remotes = await runOptionalGit(projectRoot, ["remote"]);

  for (const remote of remotes?.split(/\r?\n/).filter(Boolean) || []) {
    const remoteDefault = await runOptionalGit(projectRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`
    ]);
    if (remoteDefault) {
      refs.add(remoteDefault);
    }
  }

  for (const localDefault of ["main", "master"]) {
    if (await runOptionalGit(projectRoot, [
      "rev-parse",
      "--verify",
      `${localDefault}^{commit}`
    ])) {
      refs.add(localDefault);
    }
  }

  return refs;
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeState(value: string | undefined): Exclude<ReviewState, "malformed" | "none"> | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "pending" ||
    normalized === "passed" ||
    normalized === "changes-requested"
    ? normalized
    : null;
}

function normalizeAdapter(value: string | undefined): ReviewAdapter | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "claude" ||
    normalized === "codex" ||
    normalized === "copilot" ||
    normalized === "opencode" ||
    normalized === "antigravity"
    ? normalized
    : null;
}

function normalizeHash(value: string | undefined, pattern: RegExp): string | null {
  const normalized = value?.trim().toLowerCase() || "";
  return pattern.test(normalized) ? normalized : null;
}

function normalizeBaseRef(value: string | undefined): string | null {
  const normalized = value?.trim() || "";
  return BASE_REF_PATTERN.test(normalized) ? normalized : null;
}

function normalizeText(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeReviewerModel(value: string | undefined): string | null {
  const normalized = normalizeText(value);
  return normalized === RUNTIME_DEFAULT_MODEL ? null : normalized;
}

function normalizeTimestamp(value: string | undefined): string | null {
  const normalized = normalizeText(value);
  return normalized && !Number.isNaN(Date.parse(normalized)) ? normalized : null;
}

function normalizeWorkflow(value: string | undefined): "continuous" | "regular" | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "continuous" || normalized === "regular"
    ? normalized
    : null;
}

function normalizeBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "yes" ? true : normalized === "no" ? false : null;
}

function normalizeLenses(value: string | undefined): string[] {
  return value
    ? value.split(",").map((lens) => lens.trim().toLowerCase()).filter(Boolean)
    : [];
}

function normalizeVerdict(
  value: string | undefined
): "changes-requested" | "passed" | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "changes-requested" || normalized === "passed"
    ? normalized
    : null;
}

function normalizeCheckResult(value: string | undefined): ReviewCheckResult | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "failed" ||
    normalized === "not-required" ||
    normalized === "passed" ||
    normalized === "unavailable"
    ? normalized
    : null;
}

function normalizeExecution(value: string | undefined): ReviewExecution | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "automatic" || normalized === "manual"
    ? normalized
    : null;
}

function isValidExecutionPair(
  requested: ReviewExecution | null,
  actual: ReviewExecution | null,
  context: string | null
): boolean {
  const normalizedContext = context?.toLowerCase();

  if (requested === null && actual === null) {
    return normalizedContext === "fresh session";
  }

  if (requested === "manual") {
    return actual === "manual" && normalizedContext === "fresh session";
  }

  if (requested === "automatic") {
    return (actual === "automatic" && normalizedContext === "fresh subagent") ||
      (actual === "manual" && normalizedContext === "fresh session");
  }

  return false;
}

function readSection(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().toLowerCase() === `## ${heading}`
  );

  if (start === -1) {
    return null;
  }

  const content: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] || "";
    if (/^##\s+/.test(line)) {
      break;
    }
    content.push(line);
  }

  const normalized = content.join("\n").trim();
  return normalized ? normalized : null;
}

function emptySummary(): IndependentReviewSummary {
  return {
    state: "none",
    freshness: "not-applicable",
    targetCommit: null,
    baseCommit: null,
    baseRef: null,
    specHash: null,
    specSnapshot: null,
    preparedBy: null,
    builderModel: null,
    requestedReviewer: null,
    requestedModel: null,
    requestedExecution: null,
    requestedAt: null,
    workflow: null,
    checkRequired: null,
    reviewerAdapter: null,
    reviewerModel: null,
    reviewerContext: null,
    actualExecution: null,
    reviewedAt: null,
    scope: null,
    lenses: [],
    verdict: null,
    checkResult: null,
    warnings: []
  };
}

function malformedSummary(warning: ReviewWarning): IndependentReviewSummary {
  return {
    ...emptySummary(),
    state: "malformed",
    freshness: "unknown",
    warnings: [warning]
  };
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (typeof error.code === "string" || typeof error.code === "number")
    ? String(error.code)
    : undefined;
}

export {
  REVIEW_PATH,
  parseIndependentReview,
  readIndependentReview
};

export type {
  IndependentReviewSummary,
  ReviewAdapter,
  ReviewCheckResult,
  ReviewExecution,
  ReviewFreshness,
  ReviewState,
  ReviewWarning,
  ReviewWarningCode
};
