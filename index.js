import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { LlmError, assertUsableApiKey, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { Config, PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import * as dshSettings from "@deepseek-ai/dsh-settings";
import { createProvider } from "@earendil-works/pi-ai";
import * as openAICompletionsApi from "@earendil-works/pi-ai/api/openai-completions";
import * as openAIResponsesApi from "@earendil-works/pi-ai/api/openai-responses";
import * as anthropicMessagesApi from "@earendil-works/pi-ai/api/anthropic-messages";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { installWorkBuddyCredits } from "./workbuddy-web.js";

export { Config };

export const name = "llm-workbuddy";
export const inject = ["llm"];

const NS = typeof dshSettings.settingsNamespace === "function" ? dshSettings.settingsNamespace("llm-pi-ai") : "llm-pi-ai";
const PROVIDER = "workbuddy-cn";
const DISPLAY_NAME = "WorkBuddy 中国区";
const API_KEY_ENV = "WORKBUDDY_API_KEY";
const BASE_URL = "https://copilot.tencent.com/v2";
const CONFIG_URL = "https://copilot.tencent.com/v3/config";
const USER_AGENT = "CLI/unknown CodeBuddy/2.137.1";
const STREAM_IDLE_TIMEOUT_MS = 300_000;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVELS = ["off", ...EFFORTS];
const COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: true,
  maxTokensField: "max_tokens",
  thinkingFormat: "openai",
};

/**
 * 本插件禁用宿主 `llm-pi-ai` 行后接管它原有的全部职责，因此除了
 * WorkBuddy 自身，还要继续代理两类非 WorkBuddy 路由：
 *
 * 1. pi-ai 内置目录里带 API Key 的 provider（直接复用内置模型元数据）；
 * 2. settings.yaml 里手写的通用 provider（`api` + `baseURL` + `models`）。
 *
 * 少了这一层，用户的其它 pi-ai provider 会随宿主行一起消失。
 */
const GENERIC_APIS = Object.freeze({
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
});
const GENERIC_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 注册进 settings base 层的 WorkBuddy 默认 profile。
 *
 * 配置界面把这一层显示为“提供方默认”：用户不必手填 API 地址与协议，添加
 * provider 时地址、协议和兼容开关已经就位，只需粘贴 API Key。
 */
const WORKBUDDY_DEFAULT_PROFILE = {
  displayName: DISPLAY_NAME,
  api: "openai-completions",
  baseURL: BASE_URL,
  apiKeyEnv: API_KEY_ENV,
  compat: { ...COMPAT },
};

/**
 * 组合条目 → settings base 值。
 *
 * Cordis 在没有显式配置时传入的是 `{}` 而不是 undefined，所以不能用 `??`
 * 兜底：必须始终把 WorkBuddy 默认 profile 合并进 base 层，否则模型设置页的
 * “提供方默认”为空，用户仍要手填 API 地址。
 * @param config - 组合条目里的插件配置。
 * @returns 含 WorkBuddy 默认 profile 的 settings 条目。
 */
function settingsEntry(config) {
  const providers = config?.providers ?? {};
  return {
    ...config,
    providers: {
      ...providers,
      [PROVIDER]: { ...WORKBUDDY_DEFAULT_PROFILE, ...providers[PROVIDER] },
    },
  };
}

function workBuddyRequestOptions(options) {
  return {
    ...options,
    timeoutMs: options?.timeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    headers: { ...(options?.headers ?? {}), "user-agent": USER_AGENT },
  };
}

const workBuddyApi = {
  ...openAICompletionsApi,
  stream: (model, context, options) => openAICompletionsApi.stream(model, context, workBuddyRequestOptions(options)),
  streamSimple: (model, context, options) => openAICompletionsApi.streamSimple(model, context, workBuddyRequestOptions(options)),
};

const FALLBACK_MODELS = [
  ["hy3", "Hy3", 192000, 64000, true],
  ["glm-5.2", "GLM-5.2", 1000000, 48000, false],
  ["glm-5.1", "GLM-5.1", 200000, 48000, false],
  ["glm-5v-turbo", "GLM-5v-Turbo", 200000, 64000, true],
  ["minimax-m3-pay", "MiniMax-M3", 512000, 128000, true],
  ["minimax-m2.7", "MiniMax-M2.7", 200000, 48000, true],
  ["kimi-k3-2", "Kimi-K3", 1000000, 32000, true],
  ["kimi-k2.7", "Kimi-K2.7-Code", 256000, 32000, true],
  ["kimi-k2.6", "Kimi-K2.6", 256000, 32000, true],
  ["deepseek-v4-pro", "DeepSeek V4 Pro", 1000000, 50000, true],
  ["deepseek-v4-flash", "DeepSeek V4 Flash", 1000000, 50000, true],
].map(([id, modelName, contextWindow, maxTokens, images]) =>
  workBuddyModel({ id, name: modelName, contextWindow, maxTokens, images }),
);

function workBuddyModel({ provider = PROVIDER, id, name: modelName, contextWindow, maxTokens, images, reasoning = true, thinkingLevelMap = { off: null }, defaultReasoningEffort, thinkingFormat }) {
  return {
    id,
    name: modelName,
    api: "openai-completions",
    provider,
    baseUrl: BASE_URL,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: { ...thinkingLevelMap } } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    input: images ? ["text", "image"] : ["text"],
    cost: { ...NO_COST },
    contextWindow,
    maxTokens,
    compat: { ...COMPAT, ...(thinkingFormat ? { thinkingFormat } : {}) },
  };
}

function remoteReasoning(raw, fallback) {
  const reasoning = raw.supportsReasoning ?? fallback?.reasoning ?? raw.onlyReasoning === true;
  if (!reasoning) return { reasoning: false };
  const declared = raw.thinkingLevelMap && typeof raw.thinkingLevelMap === "object" ? raw.thinkingLevelMap : undefined;
  const thinkingLevelMap = declared
    ? Object.fromEntries(THINKING_LEVELS.map((level) => [level,
        Object.hasOwn(declared, level) && (typeof declared[level] === "string" || declared[level] === null) ? declared[level] : null]))
    : { ...(fallback?.thinkingLevelMap ?? {}), ...(raw.onlyReasoning === true ? { off: null } : {}) };
  const effort = raw.reasoning?.effort;
  const defaultReasoningEffort = EFFORTS.includes(effort) && thinkingLevelMap[effort] !== null ? effort : undefined;
  return {
    reasoning: true,
    thinkingLevelMap,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(typeof raw.thinkingFormat === "string" ? { thinkingFormat: raw.thinkingFormat } : {}),
  };
}

function configuredReasoning(entry, base) {
  if (entry.reasoningEfforts === false) return { reasoning: false };
  if (!entry.reasoningEfforts || typeof entry.reasoningEfforts !== "object") {
    return base ? {
      reasoning: base.reasoning,
      thinkingLevelMap: base.thinkingLevelMap,
      defaultReasoningEffort: base.defaultReasoningEffort,
      thinkingFormat: base.compat?.thinkingFormat,
    } : { reasoning: false };
  }
  const map = {};
  for (const level of THINKING_LEVELS) {
    if (!Object.hasOwn(entry.reasoningEfforts, level)) map[level] = null;
    else if (!(level === "off" && entry.reasoningEfforts[level] === null)) map[level] = entry.reasoningEfforts[level];
  }
  return { reasoning: true, thinkingLevelMap: map, thinkingFormat: entry.compat?.thinkingFormat };
}

function positiveInteger(...values) {
  return values.find((value) => Number.isSafeInteger(value) && value > 0);
}

function text(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

/** 从 /v3/config 的 `agents[name=cli].models` 里取出当前 Key 被授权的模型。 */
function modelsFromConfig(data) {
  const agents = Array.isArray(data?.agents) ? data.agents : data?.agent?.agents;
  const cli = Array.isArray(agents) ? agents.find((agent) => agent?.name === "cli") : undefined;
  const allowed = Array.isArray(cli?.models) ? cli.models : [];
  const source = Array.isArray(data?.models) ? data.models : [];
  const byId = new Map(source.map((model) => [model?.id, model]));
  return allowed.flatMap((id) => {
    const raw = byId.get(id);
    if (!raw) return [];
    const fallback = FALLBACK_MODELS.find((model) => model.id === id);
    const contextWindow = positiveInteger(raw.maxInputTokens, raw.maxAllowedSize, fallback?.contextWindow);
    const maxTokens = positiveInteger(raw.maxOutputTokens, fallback?.maxTokens);
    if (!contextWindow || !maxTokens) return [];
    return [workBuddyModel({
      id,
      name: text(raw.name, fallback?.name, id),
      contextWindow,
      maxTokens,
      images: raw.supportsImages === true || fallback?.input.includes("image") === true,
      ...remoteReasoning(raw, fallback),
    })];
  });
}

function authenticationHeaders(apiKey) {
  const value = assertUsableApiKey(apiKey, name, API_KEY_ENV);
  return { "x-api-key": value };
}

async function fetchWorkBuddyModels(apiKey, signal) {
  let response;
  try {
    response = await fetch(CONFIG_URL, {
      headers: {
        accept: "application/json",
        ...authenticationHeaders(apiKey),
        "user-agent": USER_AGENT,
        "x-product": "SaaS",
      },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new LlmError("WorkBuddy 模型列表获取已取消", "ABORTED", { cause: error });
    throw new LlmError("无法连接 WorkBuddy 模型配置接口", "DISCOVERY_FAILED", { cause: error });
  }
  if (!response.ok) throw new LlmError(`WorkBuddy 模型配置接口返回 ${response.status}`, "DISCOVERY_FAILED");
  const body = await response.json();
  if (body?.code !== 0) throw new LlmError(`WorkBuddy 模型配置接口错误：${body?.msg ?? body?.code}`, "DISCOVERY_FAILED");
  const models = modelsFromConfig(body.data);
  if (models.length === 0) throw new LlmError("WorkBuddy 没有返回 CLI 可用模型", "DISCOVERY_FAILED");
  return models;
}

/**
 * WorkBuddy 的凭据由 DSH 适配器解析后传入。这里不复用 pi-ai 的
 * envApiKeyAuth：新旧 DSH 版本对 auth resolver 的 signal 约定不同，
 * 这个小适配器同时接受两种调用形式。
 */
function workBuddyApiKeyAuth() {
  return {
    name: `${DISPLAY_NAME} API Key`,
    login: async (interaction) => {
      const signal = interaction?.signal;
      signal?.throwIfAborted?.();
      const key = await interaction.prompt({ type: "secret", message: `Enter ${DISPLAY_NAME} API Key` });
      signal?.throwIfAborted?.();
      return { type: "api_key", key };
    },
    resolve: async ({ credential, signal } = {}) => {
      signal?.throwIfAborted?.();
      if (!credential?.key) return undefined;
      return {
        auth: { apiKey: credential.key },
        ...(credential.env ? { env: credential.env } : {}),
        source: "DSH credential",
      };
    },
  };
}

function workBuddyProvider(models, provider = PROVIDER) {
  return createProvider({
    id: provider,
    name: DISPLAY_NAME,
    baseUrl: BASE_URL,
    auth: { apiKey: workBuddyApiKeyAuth() },
    models: models.map((model) => ({ ...model, provider })),
    api: workBuddyApi,
  });
}

function genericApiKeyAuth(provider) {
  return {
    name: `${provider} API Key`,
    resolve: async ({ credential, signal } = {}) => {
      signal?.throwIfAborted?.();
      if (!credential?.key) return undefined;
      return { auth: { apiKey: credential.key }, source: "DSH credential" };
    },
  };
}

/** 把一个手写通用 provider 条目转成 pi-ai 模型对象。 */
function genericModel(provider, source, entry) {
  const reasoningEfforts = entry.reasoningEfforts;
  const reasoning = reasoningEfforts !== false && reasoningEfforts && typeof reasoningEfforts === "object";
  const thinkingLevelMap = reasoning
    ? Object.fromEntries(GENERIC_LEVELS.filter((level) => Object.hasOwn(reasoningEfforts, level)).map((level) => [level, reasoningEfforts[level]]))
    : undefined;
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    api: source.api,
    provider,
    baseUrl: source.baseURL,
    input: Array.isArray(entry.input) && entry.input.length > 0 ? [...entry.input] : [...source.defaultInput ?? ["text"]],
    cost: { ...NO_COST },
    contextWindow: entry.contextWindow ?? source.defaultContextWindow ?? 262144,
    maxTokens: entry.maxTokens ?? source.defaultMaxTokens ?? 32768,
    ...(reasoning ? { reasoning: true, thinkingLevelMap } : {}),
    ...(entry.compat ?? source.compat ? { compat: { ...(source.compat ?? {}), ...(entry.compat ?? {}) } } : {}),
  };
}

/** 通用 provider 需要协议、地址和至少一个模型，缺一不可。 */
function genericProvider(provider, source = {}) {
  const api = GENERIC_APIS[source.api];
  if (!api || !source.baseURL || !Array.isArray(source.models) || source.models.length === 0) return undefined;
  return createProvider({
    id: provider,
    name: source.displayName ?? provider,
    baseUrl: source.baseURL,
    headers: source.headers,
    auth: { apiKey: genericApiKeyAuth(provider) },
    models: source.models.map((entry) => genericModel(provider, source, entry)),
    api,
  });
}

/** 内置目录路由：保留 pi-ai 自己的模型元数据，只套用用户改写过的字段。 */
function selectBuiltinModels(base, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return base;
  const byId = new Map(base.getModels().map((model) => [model.id, model]));
  const selected = entries.flatMap((entry) => {
    const model = byId.get(entry.id);
    if (!model) return [];
    return [{
      ...model,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry.maxTokens ? { maxTokens: entry.maxTokens } : {}),
      ...(Array.isArray(entry.input) && entry.input.length ? { input: [...entry.input] } : {}),
    }];
  });
  return { ...base, getModels: () => selected };
}

/** 本插件是否负责这条路由：WorkBuddy、pi-ai 内置目录，或手写通用 provider。 */
function ownsProvider(provider, builtins, source) {
  return provider === PROVIDER || builtins.has(provider) || genericProvider(provider, source) !== undefined;
}

function resolvedProfile(provider, source, piProvider, configuredMaxTokens = new Map()) {
  const apiKeyEnv = source.apiKeyEnv === undefined ? undefined : credentialRef(source.apiKeyEnv);
  return {
    ...source,
    provider,
    displayName: source.displayName ?? piProvider.name ?? provider,
    // dsh-llm-pi-ai 在目录解析时读取这个 map；本插件没有逐模型校验失败，
    // 但仍需提供空 map 以匹配共享适配器接口。
    modelErrors: new Map(),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    streamIdleTimeoutMs: source.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(source.retryPolicy, `${name}: provider "${provider}" retryPolicy`),
    configuredMaxTokens,
    piProvider,
  };
}

function selectWorkBuddyModels(base, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return base;
  const byId = new Map(base.map((model) => [model.id, model]));
  return entries.map((entry) => {
    const model = byId.get(entry.id);
    const reasoning = configuredReasoning(entry, model);
    return workBuddyModel({
      id: entry.id,
      name: entry.name ?? model?.name ?? entry.id,
      contextWindow: entry.contextWindow ?? model?.contextWindow ?? 262144,
      maxTokens: entry.maxTokens ?? model?.maxTokens ?? 32768,
      images: entry.input?.includes("image") ?? model?.input?.includes("image") ?? false,
      ...reasoning,
    });
  });
}

function installSettingsCompat(ctx, ns, schema, entry, hooks) {
  if (typeof dshSettings.installSettingsSection === "function") {
    return dshSettings.installSettingsSection(ctx, ns, schema, entry, hooks);
  }
  return ctx.inject(["settings"], (settingsCtx) => {
    if (!settingsCtx.settings || typeof settingsCtx.settings.installSection !== "function") {
      throw new Error(`${name}: DSH settings service does not provide installSection`);
    }
    return settingsCtx.settings.installSection(ctx, ns, schema, entry, hooks);
  });
}

export const __testing = Object.freeze({ authenticationHeaders, workBuddyApiKeyAuth, workBuddyRequestOptions, modelsFromConfig, selectWorkBuddyModels, selectBuiltinModels, genericProvider, genericModel, ownsProvider, resolvedProfile, settingsEntry, GENERIC_APIS, WORKBUDDY_DEFAULT_PROFILE });

export function apply(ctx, config) {
  installWorkBuddyCredits(ctx);
  let current = () => config;
  let remoteModels;
  let generation = 0;
  let memoRaw;
  let memoGeneration = -1;
  let memoized;
  let remoteModelsKey;
  let refreshPromise;
  const builtins = new Map(builtinProviders().map((provider) => [provider.id, provider]));

  const effectiveConfig = () => {
    const raw = current() ?? {};
    const providers = raw.providers ?? {};
    return {
      ...raw,
      providers: {
        ...providers,
        [PROVIDER]: providers[PROVIDER] ?? WORKBUDDY_DEFAULT_PROFILE,
      },
    };
  };

  /** 逐模型显式配置的输出上限，交给适配器在调用方未指定时套用。 */
  const configuredMaxTokensOf = (source) => new Map((source.models ?? []).flatMap((model) =>
    Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 ? [[model.id, model.maxTokens]] : [],
  ));

  const profiles = () => {
    const raw = effectiveConfig();
    if (memoRaw === current() && memoGeneration === generation && memoized) return memoized;
    const result = new Map();
    for (const [provider, source] of Object.entries(raw.providers)) {
      if (!ownsProvider(provider, builtins, source)) continue;
      const configured = configuredMaxTokensOf(source);
      if (provider === PROVIDER) {
        const models = selectWorkBuddyModels(remoteModels ?? FALLBACK_MODELS, source.models);
        result.set(provider, resolvedProfile(provider, {
          ...WORKBUDDY_DEFAULT_PROFILE,
          ...source,
          displayName: DISPLAY_NAME,
        }, workBuddyProvider(models, provider), configured));
        continue;
      }
      const base = builtins.get(provider);
      if (base) {
        // pi-ai 内置路由：沿用内置模型元数据，只覆盖用户改写过的字段。
        result.set(provider, resolvedProfile(provider, source, selectBuiltinModels(base, source.models), configured));
        continue;
      }
      // 手写通用路由：协议、地址与模型都来自 settings.yaml。
      const generic = genericProvider(provider, source);
      if (!generic) continue;
      result.set(provider, resolvedProfile(provider, source, generic, configured));
    }
    memoRaw = current();
    memoGeneration = generation;
    memoized = result;
    return result;
  };

  /**
   * 解析某条路由的 API Key：DSH 凭据服务优先，其次启动环境。
   * @param provider - 路由 id，仅用于错误信息。
   * @param profile - 已解析的 profile，其 `apiKeyEnv` 指向凭据引用。
   */
  const resolveCredential = async (provider, profile) => {
    const ref = profile?.apiKeyEnv;
    if (ref === undefined) {
      throw new LlmError(`${name}: Provider "${provider}" 未配置 API Key 引用，请在 WebUI 的模型设置中填写`, "MISSING_CREDENTIAL");
    }
    const stored = await ctx.get("credentials")?.resolve(ref);
    const value = stored?.value ?? launchEnvironmentOf(ctx).get(ref)?.value;
    if (!value) {
      throw new LlmError(`${name}: Provider "${provider}" 缺少 API Key，请在 WebUI 的模型设置中填写`, "MISSING_CREDENTIAL");
    }
    return { value: assertUsableApiKey(value, name, ref), ref };
  };

  const resolveApiKey = async (provider, profile) => (await resolveCredential(provider, profile)).value;

  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get("attachments"),
  });
  const adapterStream = adapter.stream.bind(adapter);
  const legacyAdapter = typeof adapter.prepareCall !== "function";
  const invokeAdapterStream = (options) => adapterStream(options);
  adapter.stream = invokeAdapterStream;
  // `prepareCall` 在 DSH rc.6 之后才加入。旧宿主直接走 stream，新宿主走
  // prepareCall 返回的 stream handle，两条路径都要保留。
  if (!legacyAdapter) {
    const adapterPrepareCall = adapter.prepareCall.bind(adapter);
    adapter.prepareCall = async (...args) => {
      const prepared = await adapterPrepareCall(...args);
      return { ...prepared, stream: (options) => prepared.stream(options) };
    };
  } else {
    adapter.prepareCall = async (provider, model, signal) => ({
      model: await adapter.resolveModel(provider, model, signal),
      stream: (options) => invokeAdapterStream(options),
    });
  }
  const resolveModel = adapter.resolveModel.bind(adapter);
  adapter.resolveModel = async (provider, model, signal) => {
    const resolved = await resolveModel(provider, model, signal);
    if (provider !== PROVIDER || !resolved.reasoning) return resolved;
    const configured = profiles().get(provider)?.piProvider.getModels().find((entry) => entry.id === model);
    const effort = configured?.defaultReasoningEffort;
    if (!effort || !resolved.reasoning.efforts.some((entry) => entry.id === effort)) return resolved;
    return { ...resolved, reasoning: { ...resolved.reasoning, defaultEffort: effort } };
  };
  const listModels = adapter.listModels.bind(adapter);
  adapter.listModels = async (provider) => {
    if (provider === PROVIDER) {
      refreshPromise ??= (async () => {
        try {
          const profile = profiles().get(provider);
          const credential = await resolveCredential(provider, profile);
          if (remoteModels && remoteModelsKey === credential.ref) return;
          remoteModels = await fetchWorkBuddyModels(credential.value);
          remoteModelsKey = credential.ref;
          generation += 1;
        } catch {
          // 没有 Key 或网络不可用时继续提供内置目录。
        }
      })().finally(() => {
        refreshPromise = undefined;
      });
      await refreshPromise;
    }
    return listModels(provider);
  };

  const directoryEntries = () => [{
    provider: PROVIDER,
    displayName: DISPLAY_NAME,
    settingsNs: NS,
    settingsPath: ["providers", PROVIDER],
    declared: false,
  }, ...[...builtins.values()].flatMap((provider) => provider.auth?.apiKey ? [{
    provider: provider.id,
    displayName: provider.name,
    settingsNs: NS,
    settingsPath: ["providers", provider.id],
    declared: false,
  }] : []), ...Object.entries(effectiveConfig().providers ?? {}).flatMap(([provider, source]) => {
    // 手写通用路由才是 declared；内置目录路由由上一段提供更准确的显示名。
    if (provider === PROVIDER || builtins.has(provider) || !genericProvider(provider, source)) return [];
    return [{
      provider,
      displayName: source.displayName ?? provider,
      settingsNs: NS,
      settingsPath: ["providers", provider],
      declared: true,
    }];
  })];

  const directory = ctx.llm.registerConfigurableProviders(directoryEntries());
  const registration = ctx.llm.registerAdapter([...profiles().keys()], adapter);

  ctx.llm.registerModelDiscovery(NS, async (request) => {
    if (request.provider === PROVIDER) {
      const credential = request.apiKey
        ? { value: request.apiKey, ref: API_KEY_ENV }
        : await resolveCredential(PROVIDER, profiles().get(PROVIDER));
      remoteModels = await fetchWorkBuddyModels(credential.value, request.signal);
      remoteModelsKey = credential.ref;
      generation += 1;
      return remoteModels.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }));
    }
    // 内置目录路由从 pi-ai 自己的注册表回答，不需要网络请求。
    const builtin = request.provider === undefined ? undefined : builtins.get(request.provider);
    if (!builtin) {
      throw new LlmError(`没有 Provider "${request.provider ?? ""}" 的模型目录`, "DISCOVERY_FAILED");
    }
    return builtin.getModels().map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
  });

  // WorkBuddy 作为 settings base 层出现，这样 WebUI 的“添加 Provider”下拉里
  // 能看到它，且地址与协议已有默认值；运行时 profile 仍由上面的实现提供。
  installSettingsCompat(ctx, NS, Config, settingsEntry(config), {
    setSource(source) {
      current = source;
    },
    onChange() {
      memoRaw = undefined;
      const providers = profiles();
      registration.replace([...providers.keys()]);
      directory.replace(directoryEntries());
    },
  });
}
