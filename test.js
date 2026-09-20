import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { __testing } from "./index.js";
import { __testing as creditsTesting, fetchWorkBuddyCredits } from "./workbuddy-credits.js";

test("插件只保留 API Key 认证，不再包含令牌登录入口", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const web = readFileSync(new URL("./workbuddy-web.js", import.meta.url), "utf8");
  const cli = readFileSync(new URL("./cli.js", import.meta.url), "utf8");

  // 胶囊与积分仍在，且注册在 composer dock 上。
  assert.match(client, /workbuddy-credits/);
  assert.match(client, /conversation\.composer\.dock/);
  assert.match(client, /剩余积分/);
  assert.match(client, /WORKBUDDY_PROVIDER_PATTERN/);
  assert.match(client, /display: flex !important/);
  assert.match(client, /dsh-workbuddy-credits-pill/);
  assert.match(client, /CREDIT_CACHE_TTL_MS = 30_000/);

  // 令牌登录、会话级绑定与账号管理必须全部消失。
  for (const removed of [
    "令牌登录", "登录 WorkBuddy", "新会话默认凭证", "会话级账号", "解除绑定",
    "WORKBUDDY_LOGIN_SESSION", "SESSION_ROUTING", "activeAccountId", "loginWorkBuddy",
  ]) {
    assert.doesNotMatch(client, new RegExp(removed), `client.js 仍包含 ${removed}`);
  }
  for (const removed of ["LEGACY_PROVIDER", "codebuddy-cn", "CODEBUDDY_API_KEY", "WORKBUDDY_SESSIONS_REF", "persistDefaultSessionBinding", "sessionScopedStream", "AsyncLocalStorage"]) {
    assert.doesNotMatch(index, new RegExp(removed), `index.js 仍包含 ${removed}`);
  }
  for (const removed of ["/token", "/login", "/api-key", "/routing", "sessionId"]) {
    assert.doesNotMatch(web, new RegExp(removed), `workbuddy-web.js 仍包含 ${removed}`);
  }
  assert.doesNotMatch(cli, /loginWorkBuddy|"login"/, "cli.js 仍包含令牌登录命令");

  // 只注册一条本地路由。
  assert.equal(web.match(/webServer\.register\(/g)?.length, 1);
});

test("API Key 以 x-api-key 头发送模型目录请求", () => {
  assert.deepEqual(__testing.authenticationHeaders("ck_test_key"), { "x-api-key": "ck_test_key" });
  assert.throws(() => __testing.authenticationHeaders(""), /API key/);
});

test("模型请求恢复 WorkBuddy 官方 User-Agent 与流空闲超时", () => {
  const options = __testing.workBuddyRequestOptions({ headers: { "x-extra": "1" } });
  assert.equal(options.headers["user-agent"], "CLI/unknown CodeBuddy/2.137.1");
  assert.equal(options.headers["x-extra"], "1");
  assert.equal(options.timeoutMs, 300_000);
});

test("WorkBuddy 自有认证助手兼容新旧 DSH 的 signal 调用约定", async () => {
  const auth = __testing.workBuddyApiKeyAuth();
  assert.deepEqual(await auth.resolve({ credential: { key: "ck_direct" } }), { auth: { apiKey: "ck_direct" }, source: "DSH credential" });
  // 无 credential 时返回 undefined，而不是抛错。
  assert.equal(await auth.resolve({}), undefined);
  // 旧宿主不传 signal，必须仍然可用。
  assert.equal((await auth.resolve({ credential: { key: "ck_legacy" } })).auth.apiKey, "ck_legacy");
  // 新宿主传入已取消的 signal 时立即中止。
  const aborted = { throwIfAborted() { throw new Error("aborted"); } };
  await assert.rejects(() => auth.resolve({ credential: { key: "ck" }, signal: aborted }), /aborted/);
  await assert.rejects(() => auth.login({ signal: aborted }), /aborted/);
});

test("模型目录保留逐模型思考能力和默认档位", () => {
  const models = __testing.modelsFromConfig({
    agents: [{ name: "cli", models: ["glm-5.2", "hy3"] }],
    models: [
      { id: "glm-5.2", name: "GLM-5.2", maxInputTokens: 1000000, maxOutputTokens: 48000, supportsReasoning: false },
      { id: "hy3", name: "Hy3", maxInputTokens: 192000, maxOutputTokens: 64000, supportsReasoning: true, onlyReasoning: true, reasoning: { effort: "high" }, thinkingLevelMap: { high: "high" } },
    ],
  });
  const byId = new Map(models.map((model) => [model.id, model]));
  assert.equal(byId.get("glm-5.2").reasoning, false);
  assert.equal(byId.get("glm-5.2").contextWindow, 1000000);
  const hy3 = byId.get("hy3");
  assert.equal(hy3.reasoning, true);
  assert.equal(hy3.thinkingLevelMap.off, null);
  assert.equal(hy3.thinkingLevelMap.high, "high");
  assert.equal(hy3.defaultReasoningEffort, "high");
  assert.deepEqual(hy3.input, ["text", "image"]);
});

test("自定义模型可覆盖自己的思考档位", () => {
  const models = __testing.selectWorkBuddyModels(
    [{ id: "hy3", name: "Hy3", contextWindow: 192000, maxTokens: 64000, reasoning: true, thinkingLevelMap: { off: null, high: "high" } }],
    [{ id: "hy3", reasoningEfforts: { high: "high", low: "low" } }],
  );
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[0].thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
});

test("未配置 apiKeyEnv 时给出 provider 默认引用与地址", () => {
  const defaults = __testing.WORKBUDDY_DEFAULT_PROFILE;
  assert.equal(defaults.baseURL, "https://copilot.tencent.com/v2");
  assert.equal(defaults.api, "openai-completions");
  assert.equal(defaults.apiKeyEnv, "WORKBUDDY_API_KEY");
  assert.equal(defaults.displayName, "WorkBuddy 中国区");
});

test("组合条目缺省时 settings base 层仍带地址与协议默认值", () => {
  // Cordis 在无显式配置时传入 {}，而不是 undefined；早期实现用 `??` 兜底，
  // 导致 base 层为空、模型设置页的“提供方默认”不显示地址。这里锁住该行为。
  for (const entry of [undefined, {}, { providers: {} }]) {
    const profile = __testing.settingsEntry(entry).providers["workbuddy-cn"];
    assert.equal(profile.baseURL, "https://copilot.tencent.com/v2", `entry=${JSON.stringify(entry)} 缺少 baseURL`);
    assert.equal(profile.api, "openai-completions");
    assert.equal(profile.apiKeyEnv, "WORKBUDDY_API_KEY");
  }
  // 用户已显式配置的字段优先于默认值。
  const overridden = __testing.settingsEntry({
    providers: { "workbuddy-cn": { baseURL: "https://proxy.example/v2", models: [{ id: "hy3" }] } },
  }).providers["workbuddy-cn"];
  assert.equal(overridden.baseURL, "https://proxy.example/v2");
  assert.equal(overridden.api, "openai-completions");
  assert.deepEqual(overridden.models, [{ id: "hy3" }]);
});

test("插件继续代理非 WorkBuddy 的 pi-ai 路由", () => {
  // 插件在 cordis.patch.yml 里禁用了宿主 llm-pi-ai 行，因此它必须接管宿主
  // 原有的全部职责。曾经只保留 workbuddy-cn，导致用户的其它 pi-ai provider
  // （如 codex20x）随之失效。
  const builtins = new Map([["openai", { id: "openai", name: "OpenAI" }]]);
  // 1) WorkBuddy 自身
  assert.equal(__testing.ownsProvider("workbuddy-cn", builtins, {}), true);
  // 2) pi-ai 内置目录里的 provider
  assert.equal(__testing.ownsProvider("openai", builtins, {}), true);
  // 3) settings.yaml 里手写的通用 provider（协议 + 地址 + 模型齐备）
  assert.equal(__testing.ownsProvider("codex20x", new Map(), {
    api: "openai-responses", baseURL: "https://cpa.crzidea.com/v1", models: [{ id: "gpt-6-astra" }],
  }), true);
  // 4) 信息不全的手写条目不属于本插件
  assert.equal(__testing.ownsProvider("incomplete", new Map(), { api: "openai-responses" }), false);
  assert.equal(__testing.ownsProvider("unrelated", new Map(), {}), false);

  // 三种协议都必须被识别，否则对应路由会静默消失。
  assert.deepEqual(Object.keys(__testing.GENERIC_APIS).sort(), ["anthropic-messages", "openai-completions", "openai-responses"]);
});

test("通用 provider 生成可直接注册的 pi-ai provider", () => {
  const provider = __testing.genericProvider("codex20x", {
    api: "openai-responses",
    baseURL: "https://cpa.crzidea.com/v1",
    displayName: "Codex 20x",
    models: [{ id: "gpt-6-astra", contextWindow: 1050000, maxTokens: 128000 }],
  });
  assert.equal(provider.id, "codex20x");
  assert.equal(provider.name, "Codex 20x");
  const models = provider.getModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "gpt-6-astra");
  assert.equal(models[0].contextWindow, 1050000);
  assert.equal(models[0].maxTokens, 128000);
  // 缺地址或缺模型时不应生成 provider。
  assert.equal(__testing.genericProvider("x", { api: "openai-responses", models: [{ id: "m" }] }), undefined);
  assert.equal(__testing.genericProvider("y", { api: "openai-responses", baseURL: "https://e.com", models: [] }), undefined);
});

test("内置目录路由沿用 pi-ai 元数据并套用用户改写", () => {
  const base = {
    id: "openai",
    getModels: () => [
      { id: "gpt-5", name: "GPT-5", contextWindow: 400000, maxTokens: 128000 },
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000, maxTokens: 16000 },
    ],
  };
  // 未配置时原样返回内置目录。
  assert.equal(__testing.selectBuiltinModels(base, undefined), base);
  const selected = __testing.selectBuiltinModels(base, [
    { id: "gpt-5", name: "自定义名称", maxTokens: 64000 },
    { id: "does-not-exist" },
  ]);
  const models = selected.getModels();
  // 不存在的 id 被丢弃，内置的能力字段在未改写时保留。
  assert.equal(models.length, 1);
  assert.equal(models[0].name, "自定义名称");
  assert.equal(models[0].maxTokens, 64000);
  assert.equal(models[0].contextWindow, 400000);
});

test("积分汇总只累加剩余量，忽略已耗尽的资源包", () => {
  const accounts = [
    { CycleCapacityRemainPrecise: 30.1000003, CycleCapacitySizePrecise: 100, PackageName: "个人版" },
    { CycleCapacityRemainPrecise: 100, CycleCapacitySizePrecise: 100, PackageName: "个人版" },
    { CycleCapacityRemainPrecise: 0, CycleCapacitySizePrecise: 100, PackageName: "过期包" },
  ];
  const credits = accounts.reduce((sum, account) => sum + (creditsTesting.firstNumber(account, ["CycleCapacityRemainPrecise"]) ?? 0), 0);
  assert.equal(Number(credits.toFixed(2)), 130.1);
  // 同一到期时间/来源的条目合并为一条，已耗尽的资源包被丢弃。
  const segments = creditsTesting.mergeSegments(creditsTesting.extractCreditSegments(accounts));
  assert.equal(segments.length, 1);
  assert.equal(segments.reduce((sum, segment) => sum + segment.remaining, 0), 130.1);
});

test("积分查询复用 WorkBuddy billing 接口并汇总有效资源", async () => {
  const calls = [];
  const result = await fetchWorkBuddyCredits("ck_test", {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            code: 0,
            data: { Response: { Data: { TotalDosage: 5040, Accounts: [{ CycleCapacityRemainPrecise: 42.5, CycleCapacitySizePrecise: 100, PackageName: "个人版", ExpiredTime: "2026-09-25 09:04:43" }] } } },
          });
        },
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.codebuddy.cn/v2/billing/meter/get-user-resource");
  assert.equal(calls[0].options.method, "POST");
  // 与模型请求一致：Authorization 与 X-API-Key 同时发送。
  assert.equal(calls[0].options.headers.authorization, "Bearer ck_test");
  assert.equal(calls[0].options.headers["x-api-key"], "ck_test");
  assert.equal(result.credits, 42.5);
  assert.equal(result.totalDosage, 5040);
  assert.equal(result.creditError, null);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].source, "个人版");
});

test("积分接口失败时返回暂不可用而不是抛出", async () => {
  const result = await fetchWorkBuddyCredits("ck_test", {
    fetchImpl: async () => ({ ok: false, status: 401, async text() { return "unauthorized"; } }),
  });
  assert.equal(result.credits, null);
  assert.deepEqual(result.segments, []);
  assert.match(result.creditError, /401/);
});

test("积分查询只请求受信任的 WorkBuddy billing 域名", async () => {
  const seen = [];
  await fetchWorkBuddyCredits("ck_test", {
    fetchImpl: async (url) => {
      seen.push(String(url));
      return { ok: true, status: 200, async text() { return JSON.stringify({ code: 0, data: { Response: { Data: { Accounts: [] } } } }); } };
    },
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^https:\/\/www\.codebuddy\.cn\//);
});

test("积分请求体覆盖全部有效状态并列出资源包", () => {
  const body = creditsTesting.buildCreditResourceBody(new Date("2026-09-20T10:00:00"));
  assert.equal(body.PageNumber, 1);
  assert.equal(body.PageSize, 100);
  assert.equal(body.ProductCode, "p_tcaca");
  assert.deepEqual(body.Status, [0, 3]);
  assert.match(body.PackageEndTimeRangeBegin, /^2026-09-20 /);
});

test("客户端不再为 API Key 模式渲染额外面板", () => {
  const client = readFileSync(new URL("./client.js", import.meta.url), "utf8");
  // 认证面板依赖的 DOM 注入与输入框改写必须消失。
  assert.doesNotMatch(client, /MutationObserver/);
  assert.doesNotMatch(client, /aria-label="API 密钥"/);
  assert.doesNotMatch(client, /data-workbuddy-auth-switch/);
  assert.doesNotMatch(client, /document\.createElement\("input"\)/);
  // 只保留一个 slot 注册。
  assert.equal(client.match(/ctx\.slots\.register\(/g)?.length, 1);
});
