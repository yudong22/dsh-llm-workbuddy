#!/usr/bin/env node

/**
 * 安装/卸载 @yudong22/dsh-llm-workbuddy 到 DSH 的 web 与 headless Profile。
 *
 * 令牌登录已随插件精简一并移除，因此不再提供 `login` 子命令；认证统一在
 * WebUI 的模型设置里填入 WorkBuddy API Key。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";

const PACKAGE = "@yudong22/dsh-llm-workbuddy";
/**
 * 本包是 @axiaohungry/dsh-llm-workbuddy 的 fork。两包插入同一行
 * （`id: llm-workbuddy`）且都声明 `workbuddy-cn`，同时安装会冲突，
 * 因此安装时先移除旧 scope 的包。
 */
const LEGACY_PACKAGES = ["@axiaohungry/dsh-llm-workbuddy"];
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const PACKAGE_SPEC = `${PACKAGE}@${PACKAGE_VERSION}`;
const PROVIDER_PATH = ["llm-pi-ai", "providers", "workbuddy-cn"];
const IGNORED_BUILDS = ["@google/genai", "protobufjs"];
const require = createRequire(import.meta.url);

function dshHome() {
  return resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
}

function profileHasPackage(home, profile, packageName) {
  const file = join(home, "profiles", profile, "package.json");
  if (!existsSync(file)) return false;
  const json = JSON.parse(readFileSync(file, "utf8"));
  return Boolean(json.dependencies?.[packageName] || json.devDependencies?.[packageName]);
}

function dshEnv() {
  const pnpmPackageDir = dirname(require.resolve("pnpm"));
  const pnpmBinDir = join(dirname(pnpmPackageDir), ".bin");
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  return {
    ...process.env,
    [pathKey]: `${pnpmBinDir}${delimiter}${process.env[pathKey] || ""}`,
    npm_config_ignore_workspace_root_check: "true",
  };
}

function runDsh(args) {
  const result = spawnSync(process.platform === "win32" ? "dsh.cmd" : "dsh", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: dshEnv(),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`dsh ${args.join(" ")} 执行失败（退出码 ${result.status}）`);
}

function writeYamlDocument(file, document) {
  const temporary = join(dirname(file), `.workbuddy-${process.pid}.tmp`);
  writeFileSync(temporary, String(document), "utf8");
  renameSync(temporary, file);
}

/** pnpm 会阻止原生构建；临时放行这两个包，结束后恢复原有取值。 */
function withPnpmBuildPolicy(file, action) {
  const document = parseDocument(readFileSync(file, "utf8"));
  if (document.errors.length) throw new Error(`无法解析 ${file}：${document.errors[0].message}`);
  const changes = [];
  for (const packageName of IGNORED_BUILDS) {
    const path = ["allowBuilds", packageName];
    if (typeof document.getIn(path) !== "boolean") {
      changes.push({ packageName, existed: document.hasIn(path), value: document.getIn(path) });
      document.setIn(path, false);
    }
  }
  if (changes.length) writeYamlDocument(file, document);
  try {
    return action();
  } finally {
    if (changes.length) {
      const current = parseDocument(readFileSync(file, "utf8"));
      for (const change of changes) {
        const path = ["allowBuilds", change.packageName];
        if (change.existed) current.setIn(path, change.value);
        else current.deleteIn(path);
      }
      if (current.getIn(["allowBuilds"])?.items?.length === 0) current.deleteIn(["allowBuilds"]);
      writeYamlDocument(file, current);
    }
  }
}

function cleanPnpmWorkspace(file) {
  if (!existsSync(file)) return;
  const document = parseDocument(readFileSync(file, "utf8"));
  if (document.errors.length) throw new Error(`无法解析 ${file}：${document.errors[0].message}`);
  const entries = document.getIn(["minimumReleaseAgeExclude"])?.items;
  if (!entries) return;
  const remaining = entries.map((entry) => entry.value).filter((entry) => !String(entry).startsWith(`${PACKAGE}@`));
  if (remaining.length === entries.length) return;
  if (remaining.length) document.setIn(["minimumReleaseAgeExclude"], remaining);
  else document.deleteIn(["minimumReleaseAgeExclude"]);
  writeYamlDocument(file, document);
}

/** 卸载时删除 settings.yaml 里的 WorkBuddy provider 段，并留一份备份。 */
function cleanSettings(file) {
  if (!existsSync(file)) return undefined;
  const source = readFileSync(file, "utf8");
  const document = parseDocument(source);
  if (document.errors.length) throw new Error(`无法解析 ${file}：${document.errors[0].message}`);
  if (!document.hasIn(PROVIDER_PATH)) return undefined;

  document.deleteIn(PROVIDER_PATH);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.workbuddy-backup-${stamp}`;
  const temporary = join(dirname(file), `.settings-workbuddy-${process.pid}.tmp`);
  copyFileSync(file, backup);
  writeFileSync(temporary, String(document), "utf8");
  renameSync(temporary, file);
  return backup;
}

function install() {
  for (const profile of ["web", "headless"]) {
    runDsh(["plugin", "--profile", profile, "list", "--depth", "0"]);
    const workspace = join(dshHome(), "profiles", profile, "pnpm-workspace.yaml");
    withPnpmBuildPolicy(workspace, () => {
      // 先从旧 scope 迁移：两个包会争夺同一个 `llm-workbuddy` 组合行。
      for (const legacy of LEGACY_PACKAGES) {
        if (profileHasPackage(dshHome(), profile, legacy)) {
          runDsh(["plugin", "--profile", profile, "remove", legacy]);
        }
      }
      runDsh(["plugin", "--profile", profile, "add", PACKAGE_SPEC]);
    });
  }
  console.log("WorkBuddy Provider 已安装。请重启 DSH 后在 设置 → 模型 里填入 API Key。");
}

function uninstall(home = dshHome()) {
  const backup = cleanSettings(join(home, "settings.yaml"));
  for (const profile of ["web", "headless"]) {
    const workspace = join(home, "profiles", profile, "pnpm-workspace.yaml");
    const installed = [PACKAGE, ...LEGACY_PACKAGES].filter((packageName) => profileHasPackage(home, profile, packageName));
    if (installed.length) {
      withPnpmBuildPolicy(workspace, () => {
        for (const packageName of installed) {
          runDsh(["plugin", "--profile", profile, "remove", packageName]);
        }
      });
    }
    cleanPnpmWorkspace(workspace);
  }
  console.log(backup ? `WorkBuddy 配置已清理，备份：${backup}` : "未发现 WorkBuddy Provider 配置。");
  console.log("插件已卸载，DSH 凭据服务中的 API Key 保持不变。请重启 DSH。");
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "dsh-workbuddy-cli-"));
  try {
    const file = join(root, "settings.yaml");
    writeFileSync(file, "llm-pi-ai:\n  providers:\n    opencode-go:\n      apiKeyEnv: OPENCODE_GO_API_KEY\n    workbuddy-cn:\n      apiKeyEnv: WORKBUDDY_CN_API_KEY\n      models:\n        - id: legacy-model\n", "utf8");
    const backup = cleanSettings(file);
    const result = parseDocument(readFileSync(file, "utf8"));
    if (!backup || !existsSync(backup) || result.hasIn(PROVIDER_PATH) || !result.hasIn(["llm-pi-ai", "providers", "opencode-go"])) {
      throw new Error("uninstall settings cleanup self-test failed");
    }
    if (cleanSettings(file) !== undefined) throw new Error("uninstall idempotence self-test failed");

    const workspace = join(root, "pnpm-workspace.yaml");
    writeFileSync(workspace, "packages:\n  - .\nallowBuilds:\n  '@google/genai': true\n  protobufjs: pending\n", "utf8");
    withPnpmBuildPolicy(workspace, () => {
      const active = parseDocument(readFileSync(workspace, "utf8"));
      if (active.getIn(["allowBuilds", "@google/genai"]) !== true || active.getIn(["allowBuilds", "protobufjs"]) !== false) {
        throw new Error("pnpm build policy activation self-test failed");
      }
    });
    const restored = parseDocument(readFileSync(workspace, "utf8"));
    if (restored.getIn(["allowBuilds", "@google/genai"]) !== true || restored.getIn(["allowBuilds", "protobufjs"]) !== "pending") {
      throw new Error("pnpm build policy self-test failed");
    }
    restored.setIn(["minimumReleaseAgeExclude"], ["other@1.0.0", `${PACKAGE}@1.3.1`]);
    writeYamlDocument(workspace, restored);
    cleanPnpmWorkspace(workspace);
    const cleaned = parseDocument(readFileSync(workspace, "utf8")).getIn(["minimumReleaseAgeExclude"])?.items?.map((entry) => entry.value);
    if (cleaned?.join(",") !== "other@1.0.0") throw new Error("pnpm workspace cleanup self-test failed");

    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
    if (!dshEnv()[pathKey].split(delimiter)[0].endsWith(join("node_modules", ".bin"))) {
      throw new Error("bundled pnpm PATH self-test failed");
    }
    console.log("CLI-SELF-TEST-OK");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const command = process.argv[2];
if (command === "install") install();
else if (command === "uninstall") uninstall();
else if (command === "--self-test") selfTest();
else {
  console.log("用法：dsh-llm-workbuddy <install|uninstall>");
  process.exitCode = 1;
}
