/**
 * WorkBuddy 剩余积分查询。
 *
 * 只使用 API Key 认证：`/v2/billing/meter/get-user-resource` 接受与模型请求
 * 相同的 WorkBuddy API Key，因此积分胶囊和模型调用共用同一份凭据。
 *
 * 今日请求次数与今日积分用量来自 `/billing/meter/get-user-request-usage`，
 * 该接口只接受登录令牌（API Key 会得到网关 401），因此本模块不再查询它。
 */

const BILLING_HOST = "https://www.codebuddy.cn";
const REQUEST_TIMEOUT_MS = 12_000;
const PRODUCT_CODE = "p_tcaca";

/** 个人额度按周期计费的剩余量字段，优先级从高到低。 */
const REMAINING_FIELDS = [
  "SlicePeriodCapacityRemainPrecise",
  "SlicePeriodCapacityRemain",
  "CycleCapacityRemainPrecise",
  "CycleCapacityRemain",
  "CapacityRemainPrecise",
  "CapacityRemain",
  "RemainPrecise",
  "Remain",
  "Remaining",
  "Balance",
];
const TOTAL_FIELDS = [
  "SlicePeriodCapacitySizePrecise",
  "SlicePeriodCapacitySize",
  "CycleCapacitySizePrecise",
  "CycleCapacitySize",
  "CycleCapacityPrecise",
  "CycleCapacity",
  "CapacityPrecise",
  "Capacity",
  "TotalCapacityPrecise",
  "TotalCapacity",
  "PackageCapacity",
  "Quota",
  "Amount",
];
const EXPIRY_FIELDS = [
  "DeductionEndTime",
  "ExpiredTime",
  "SlicePeriodEndTime",
  "PackageEndTime",
  "EndTime",
  "CycleEndTime",
  "ExpireTime",
  "ExpirationTime",
  "ValidEndTime",
  "ValidPeriodEndTime",
  "EndAt",
  "ExpireAt",
];
const LABEL_FIELDS = ["PackageName", "PackageTypeName", "AccountName", "ProductName", "Name", "RuleName", "Description"];

/** 汇总剩余积分时使用的字段，与逐条明细的字段优先级不同。 */
const SUMMARY_REMAINING_FIELDS = [
  "CycleCapacityRemainPrecise",
  "CycleCapacityRemain",
  "CapacityRemainPrecise",
  "CapacityRemain",
];

function firstNumber(value, fields) {
  for (const field of fields) {
    const raw = value?.[field];
    if (raw === undefined || raw === null || raw === "") continue;
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value).trim())) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
  }
  const parsed = Date.parse(String(value).replace(/^(\d{4}-\d\d-\d\d)\s+/, "$1T"));
  return Number.isFinite(parsed) ? parsed : null;
}

function firstTimestamp(value, fields) {
  for (const field of fields) {
    const parsed = parseTimestamp(value?.[field]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function firstText(value, fields) {
  for (const field of fields) {
    const text = value?.[field];
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
}

/** 响应外层结构在 WorkBuddy 各版本间有差异，这里列出全部已知包装。 */
function extractAccounts(payload) {
  const candidates = [
    payload?.data?.Response?.Data?.Accounts,
    payload?.data?.data?.Response?.Data?.Accounts,
    payload?.data?.accounts,
    payload?.data?.data?.accounts,
    payload?.Response?.Data?.Accounts,
  ];
  return candidates.find(Array.isArray) ?? [];
}

function extractCreditSegments(accounts, source = "积分") {
  return (Array.isArray(accounts) ? accounts : [])
    .flatMap((account) => {
      const details = Array.isArray(account?.SlicePeriodUsageDetails) && account.SlicePeriodUsageDetails.length
        ? account.SlicePeriodUsageDetails.map((detail) => ({ ...account, ...detail }))
        : [account];
      return details.map((item) => {
        const remaining = firstNumber(item, REMAINING_FIELDS);
        if (remaining === null || remaining <= 0) return null;
        const total = firstNumber(item, TOTAL_FIELDS);
        return {
          remaining: Number(remaining.toFixed(2)),
          total: Number((total === null ? remaining : Math.max(total, remaining)).toFixed(2)),
          expiresAt: firstTimestamp(item, EXPIRY_FIELDS),
          source: firstText(item, LABEL_FIELDS) || source,
          packageCode: item?.PackageCode ? String(item.PackageCode) : "",
        };
      });
    })
    .filter(Boolean);
}

function sortSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && Number(segment.remaining) > 0)
    .map((segment) => ({
      remaining: Number(Number(segment.remaining).toFixed(2)),
      total: Number(Number(segment.total || segment.remaining).toFixed(2)),
      expiresAt: segment.expiresAt === null || segment.expiresAt === undefined ? null : Number(segment.expiresAt),
      source: String(segment.source || "积分"),
      packageCode: String(segment.packageCode || ""),
    }))
    .sort((left, right) => {
      if (left.expiresAt === null && right.expiresAt !== null) return 1;
      if (left.expiresAt !== null && right.expiresAt === null) return -1;
      return (left.expiresAt || 0) - (right.expiresAt || 0);
    });
}

/** 同一到期时间的多个资源包合并成一条，避免弹层里重复出现同名条目。 */
function mergeSegments(segments) {
  const merged = new Map();
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || Number(segment.remaining) <= 0) continue;
    const key = [segment.packageCode || segment.source || "积分", segment.expiresAt ?? "unknown"].join("|");
    const previous = merged.get(key);
    if (previous) {
      previous.remaining += Number(segment.remaining) || 0;
      previous.total += Number(segment.total || segment.remaining) || 0;
    } else {
      merged.set(key, {
        remaining: Number(segment.remaining) || 0,
        total: Number(segment.total || segment.remaining) || 0,
        expiresAt: segment.expiresAt === undefined ? null : segment.expiresAt,
        source: String(segment.source || "积分"),
        packageCode: String(segment.packageCode || ""),
      });
    }
  }
  return sortSegments(Array.from(merged.values()));
}

function buildCreditResourceBody(now = new Date()) {
  const end = new Date(now.getTime());
  end.setFullYear(end.getFullYear() + 101);
  const format = (date) => {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  return {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: format(now),
    PackageEndTimeRangeEnd: format(end),
  };
}

function billingHeaders(apiKey) {
  // 与模型请求一致：同时发送 Authorization 与 X-API-Key，兼容服务端策略变化。
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "x-client-platform": "web",
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  };
}

function timeoutSignal(timeoutMs, externalSignal) {
  if (externalSignal) return externalSignal;
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(timeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

async function readJson(response, action) {
  const raw = await response.text();
  // HTTP 状态先于正文解析：上游失败时常返回 HTML 或空正文，先解析会把
  // 真正的原因（401/403/5xx）替换成“无法解析的数据”。
  if (!response.ok) throw new Error(`${action} HTTP ${response.status}: ${raw.slice(0, 160)}`);
  if (!raw.trim()) throw new Error(`${action}返回空响应（HTTP ${response.status}）`);
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${action}返回了无法解析的数据`, { cause: error });
  }
  if (payload?.code !== undefined && payload.code !== null && payload.code !== 0) {
    throw new Error(`${action}失败（${payload.msg ?? payload.message ?? `code=${payload.code}`}）`);
  }
  return payload;
}

async function postJson(url, apiKey, body, action, options = {}) {
  const response = await (options.fetchImpl || globalThis.fetch)(url, {
    method: "POST",
    headers: billingHeaders(apiKey),
    body: JSON.stringify(body),
    signal: timeoutSignal(options.timeoutMs ?? REQUEST_TIMEOUT_MS, options.signal),
  });
  return readJson(response, action);
}

async function retry(task, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  throw lastError;
}

/**
 * 查询当前 API Key 的剩余积分。
 *
 * 失败不抛出：积分属于附加信息，弹层显示“暂不可用”即可，不能影响模型调用。
 * @param apiKey - WorkBuddy API Key。
 * @param options - 注入 fetch 实现、超时与取消信号（测试与调用方使用）。
 * @returns 剩余积分、资源包明细与失败信息。
 */
export async function fetchWorkBuddyCredits(apiKey, options = {}) {
  try {
    const payload = await retry(() => postJson(
      `${BILLING_HOST}/v2/billing/meter/get-user-resource`,
      apiKey,
      buildCreditResourceBody(),
      "WorkBuddy 积分接口",
      options,
    ));
    const accounts = extractAccounts(payload);
    let credits = 0;
    for (const account of accounts) {
      const remaining = firstNumber(account, SUMMARY_REMAINING_FIELDS);
      if (remaining !== null) credits += remaining;
    }
    return {
      credits: Number(credits.toFixed(2)),
      totalDosage: payload?.data?.Response?.Data?.TotalDosage ?? payload?.data?.data?.Response?.Data?.TotalDosage ?? null,
      segments: mergeSegments(extractCreditSegments(accounts)),
      count: accounts.length,
      creditError: null,
    };
  } catch (error) {
    return {
      credits: null,
      totalDosage: null,
      segments: [],
      count: 0,
      creditError: error instanceof Error ? error.message : String(error),
    };
  }
}

export const __testing = Object.freeze({
  billingHeaders,
  buildCreditResourceBody,
  extractAccounts,
  extractCreditSegments,
  firstNumber,
  firstTimestamp,
  mergeSegments,
  parseTimestamp,
  sortSegments,
});
