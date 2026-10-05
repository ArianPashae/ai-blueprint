import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const packageRoot = path.join(repoRoot, "packages", "create-ai-blueprint");
const sandboxRoot = path.join(repoRoot, ".sandbox");

const adapters = ["all", "codex", "claude", "copilot", "opencode", "antigravity"] as const;
type Adapter = (typeof adapters)[number];

export interface SandboxOptions {
  adapter: Adapter | null;
  clean: boolean;
  demoPlan: boolean;
  help: boolean;
  name: string;
  server: boolean;
}

interface PackageJson {
  scripts?: Record<string, string>;
}

const helpText = `Create an inspectable app using the locally packed AI Blueprint.

Usage:
  npm run sandbox
  npm run sandbox:demo
  npm run sandbox -- --name my-run
  npm run sandbox -- --demo-plan
  npm run sandbox -- --adapter codex --no-server --clean

Options:
  --name <name>        Folder name under .sandbox
  --adapter <name>     Skip the installer prompt and use all, codex, claude,
                       copilot, opencode, or antigravity
  --clean              Remove the sandbox after a successful run
  --demo-plan          Add example plans ready for overview and feature work
  --no-server          Skip the final development server
  --help               Show this help
`;

export function parseSandboxArgs(
  args: readonly string[],
  now: Date = new Date()
): SandboxOptions {
  const options: SandboxOptions = {
    adapter: null,
    clean: false,
    demoPlan: false,
    help: false,
    name: `minimal-app-${formatTimestamp(now)}`,
    server: true
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--clean") {
      options.clean = true;
      continue;
    }

    if (argument === "--demo-plan") {
      options.demoPlan = true;
      continue;
    }

    if (argument === "--no-server") {
      options.server = false;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    if (argument === "--name" || argument === "--adapter") {
      const value = args[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }

      index += 1;

      if (argument === "--name") {
        options.name = value;
      } else if (isAdapter(value)) {
        options.adapter = value;
      } else {
        throw new Error(`Unknown adapter: ${value}. Use ${adapters.join(", ")}.`);
      }

      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  assertSafeSegment(options.name, "Sandbox name");

  return options;
}

export function createBlueprintNpxArguments(
  tarball: string,
  adapter: Adapter | null
): string[] {
  const args = ["--yes", "--package", tarball, "create-ai-blueprint"];

  if (adapter) {
    args.push("--", `--${adapter}`, "--yes");
  }

  return args;
}

export function sandboxChildEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false"
  };

  for (const key of [
    "npm_config_adapter",
    "npm_config_clean",
    "npm_config_demo_plan",
    "npm_config_name",
    "npm_config_server"
  ]) {
    delete childEnvironment[key];
  }

  return childEnvironment;
}

async function main(): Promise<void> {
  const options = parseSandboxArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(helpText);
    return;
  }

  const runRoot = path.join(sandboxRoot, options.name);
  const projectRoot = path.join(runRoot, "project");
  const artifactsRoot = path.join(runRoot, "artifacts");

  await fs.mkdir(sandboxRoot, { recursive: true });
  const sandboxStats = await fs.lstat(sandboxRoot);

  if (!sandboxStats.isDirectory() || sandboxStats.isSymbolicLink()) {
    throw new Error(`Sandbox root must be a real directory: ${sandboxRoot}`);
  }

  await requireMissing(runRoot);
  await fs.mkdir(runRoot, { recursive: true });

  console.log("\nAI Blueprint sandbox");
  console.log(`Creating ${projectRoot}\n`);

  try {
    task("Creating minimal Node app");
    await scaffoldProject(projectRoot);
    passed("App scaffolded");

    task("Creating initial Git history");
    runQuiet("git", ["init", "-b", "main"], projectRoot);
    runQuiet("git", ["config", "user.email", "sandbox@ai-blueprint.test"], projectRoot);
    runQuiet("git", ["config", "user.name", "Blueprint Sandbox"], projectRoot);
    runQuiet("git", ["add", "."], projectRoot);
    runQuiet("git", ["commit", "-m", "chore: scaffold sandbox app"], projectRoot);
    passed("Initial app committed");

    task("Packing the local AI Blueprint");
    await fs.mkdir(artifactsRoot, { recursive: true });
    runQuiet(
      npmCommand(),
      ["pack", "--silent", "--pack-destination", artifactsRoot],
      packageRoot
    );
    const tarball = await findTarball(artifactsRoot);
    passed("Local package ready");

    console.log("\nInstall AI Blueprint\n");
    console.log("$ npx create-ai-blueprint@local\n");
    runVisible(
      npxCommand(),
      createBlueprintNpxArguments(tarball, options.adapter),
      projectRoot
    );
    await verifyBlueprintInstall(projectRoot);
    await addLocalBlueprintScripts(projectRoot, tarball);

    if (options.demoPlan) {
      await writeDemoPlans(projectRoot);
      console.log("\n✓ Demo project and build plans added");
    }

    console.log("\nVerify generated app");
    const scripts = await readPackageScripts(projectRoot);

    for (const script of ["test", "build"]) {
      if (scripts[script]) {
        task(`Running npm run ${script}`);
        runQuiet(npmCommand(), ["run", script], projectRoot);
        passed(`${script} passed`);
      }
    }

    console.log("\n✓ Sandbox setup and verification passed");
    console.log(`  ${projectRoot}`);
    console.log("\nLocal Blueprint proof");
    console.log("These commands use the package packed from this branch, not a global npm release.");
    console.log("$ npm run blueprint:status");
    console.log("$ npm run blueprint:dashboard");

    if (options.server) {
      console.log("\nStart development server");
      console.log("Press Ctrl+C after inspecting the app.\n");
      await runDevelopmentServer(projectRoot);
      console.log("\nDevelopment server stopped.");
    }

    if (options.clean) {
      await fs.rm(runRoot, { recursive: true, force: true });
      console.log(`Sandbox removed: ${runRoot}`);
      return;
    }

    console.log(`Sandbox preserved: ${runRoot}`);
  } catch (error: unknown) {
    console.error(`\nSandbox failed and was preserved: ${runRoot}`);
    throw error;
  }
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function isAdapter(value: string): value is Adapter {
  return adapters.some((adapter) => adapter === value);
}

function assertSafeSegment(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, and hyphens.`);
  }
}

async function requireMissing(target: string): Promise<void> {
  try {
    await fs.access(target);
  } catch (error: unknown) {
    if (getErrorCode(error) === "ENOENT") {
      return;
    }

    throw error;
  }

  throw new Error(`Sandbox already exists: ${target}`);
}

async function findTarball(directory: string): Promise<string> {
  const tarballs = (await fs.readdir(directory)).filter((file) => file.endsWith(".tgz"));

  if (tarballs.length !== 1) {
    throw new Error(`Expected one packed artifact, found ${tarballs.length}.`);
  }

  return path.join(directory, tarballs[0]);
}

export async function scaffoldProject(projectRoot: string): Promise<void> {
  await fs.mkdir(path.join(projectRoot, "test"), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "blueprint-sandbox-app",
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: {
          dev: "node server.js",
          test: "node --test",
          build: "node --check server.js"
        }
      },
      null,
      2
    )}\n`
  );
  await fs.writeFile(path.join(projectRoot, ".gitignore"), "dist/\n");
  await fs.writeFile(
    path.join(projectRoot, "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Blueprint Sandbox</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7fb; color: #182230; }
      main { max-width: 36rem; padding: 3rem; text-align: center; background: white; border: 1px solid #dfe3eb; border-radius: 1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>AI Blueprint Sandbox</h1>
      <p>The app is running and ready for inspection.</p>
    </main>
  </body>
</html>
`
  );
  await fs.writeFile(
    path.join(projectRoot, "server.js"),
    `import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const page = await readFile(new URL("./index.html", import.meta.url));

const server = createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/index.html") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});

server.listen(port, host, () => {
  console.log("\\n  Local: http://localhost:" + port + "/\\n");
});
`
  );
  await fs.writeFile(
    path.join(projectRoot, "test", "app.test.js"),
    `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("sandbox page is ready", async () => {
  const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(page, /AI Blueprint Sandbox/);
});
`
  );
}

export async function writeDemoPlans(projectRoot: string): Promise<void> {
  const blueprintRoot = path.join(projectRoot, "blueprint");
  await fs.mkdir(blueprintRoot, { recursive: true });
  await fs.writeFile(
    path.join(blueprintRoot, "project-plan.md"),
    `# Project Plan

## 1. Problem - What problem are we solving?

Build a small personal task tracker that makes quick daily tasks easy to add,
complete, review, and remove. The project is also a realistic sandbox for trying
the AI Blueprint workflow from overview through completed features.

## 2. Users - Who is this for?

Individuals who want a lightweight task list in one browser. There are no teams,
accounts, roles, or shared workspaces.

## 3. Features - What does the MVP need?

- Add tasks and see them in a clear list with a useful empty state
- Mark tasks complete and delete tasks
- Persist tasks in the browser and filter by all, active, or completed

## 4. Data - What are we storing?

Tasks are stored in browser localStorage. Each task has an id, text, completed
state, and creation timestamp. No server-side data or personal information is
stored.

## 5. Tech - What stack are we using?

- Node.js built-in HTTP server
- Plain HTML, CSS, and browser JavaScript
- Browser localStorage
- Node.js built-in test runner
- No external runtime dependencies

## 6. Monetize - How will this make money?

It will not be monetized. This is a workflow demonstration project.

## 7. UI/UX - How should this look and feel?

Use a clean, responsive single-column layout with strong contrast, clear focus
states, readable task rows, and obvious controls. Keep the interface practical
and accessible rather than decorative.

## 8. Deployment - Where and how will this ship?

The sandbox is local-only. Use \`npm run dev\` to start the app and \`npm test\`
plus \`npm run build\` for verification. External deployment is out of scope.
`
  );
  await fs.writeFile(
    path.join(blueprintRoot, "build-plan.md"),
    `# Build Plan

- [ ] 1. **Task list foundation** - add tasks, render the list, validate input, and show an empty state
- [ ] 2. **Task actions** - mark tasks complete, delete tasks, and show remaining task count
- [ ] 3. **Persistence and filters** - save tasks in localStorage and filter all, active, or completed tasks
`
  );
}

export async function addLocalBlueprintScripts(
  projectRoot: string,
  tarball: string
): Promise<void> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(
    await fs.readFile(packageJsonPath, "utf8")
  ) as PackageJson & Record<string, unknown>;
  const packageSpec = path.relative(projectRoot, tarball).split(path.sep).join("/");
  const localCommand = `npx --yes --package ${packageSpec} create-ai-blueprint`;

  packageJson.scripts = {
    ...(packageJson.scripts || {}),
    "blueprint:status": `${localCommand} status`,
    "blueprint:dashboard": `${localCommand} dashboard`
  };

  await fs.writeFile(
    packageJsonPath,
    `${JSON.stringify(packageJson, null, 2)}\n`
  );
}

async function verifyBlueprintInstall(projectRoot: string): Promise<void> {
  for (const relativePath of [
    "AGENTS.md",
    "blueprint/config.json",
    "blueprint/.state/manifest.json"
  ]) {
    await fs.access(path.join(projectRoot, ...relativePath.split("/")));
  }
}

async function readPackageScripts(projectRoot: string): Promise<Record<string, string>> {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(projectRoot, "package.json"), "utf8")
  ) as PackageJson;
  return packageJson.scripts || {};
}

async function runDevelopmentServer(cwd: string): Promise<void> {
  const child = spawn(npmCommand(), ["run", "dev"], {
    cwd,
    env: sandboxChildEnvironment(process.env),
    stdio: "inherit"
  });

  await new Promise<void>((resolve, reject) => {
    let interrupted = false;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      process.off("SIGINT", handleInterrupt);
      process.off("SIGTERM", handleTerminate);

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const handleInterrupt = () => {
      interrupted = true;
      child.kill("SIGINT");
    };
    const handleTerminate = () => {
      interrupted = true;
      child.kill("SIGTERM");
    };

    process.on("SIGINT", handleInterrupt);
    process.on("SIGTERM", handleTerminate);
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (
        code === 0 ||
        code === 130 ||
        interrupted ||
        signal === "SIGINT" ||
        signal === "SIGTERM"
      ) {
        finish();
        return;
      }

      finish(new Error(`Development server failed with status ${code}.`));
    });
  });
}

function runVisible(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    env: sandboxChildEnvironment(process.env),
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status}.`);
  }
}

function runQuiet(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: sandboxChildEnvironment(process.env),
    maxBuffer: 64 * 1024 * 1024
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr]
      .map((output) => output.trim())
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status}.${details ? `\n${details}` : ""}`
    );
  }
}

function task(message: string): void {
  console.log(`\n◇ ${message}`);
}

function passed(message: string): void {
  console.log(`✓ ${message}`);
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";

if (invokedPath === scriptPath) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
