/**
 * WorkBuddy 积分胶囊的 Host 侧接口。
 *
 * 只注册一条本地路由，供 WebUI 的积分胶囊查询剩余积分。凭证来自模型设置里
 * 当前选中的 WorkBuddy API Key，与模型调用完全一致；插件不保存任何令牌。
 */

import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { fetchWorkBuddyCredits } from "./workbuddy-credits.js";

const PROVIDER = "workbuddy-cn";
const API_KEY_ENV = "WORKBUDDY_API_KEY";
const ROUTE = "/dsh-llm-workbuddy/credits";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** 只接受本机页面的请求；积分查询需要读取凭据，不接受跨站调用。 */
function localRequest(req) {
  const address = req.socket.remoteAddress;
  const loopback = address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  if (!loopback) return false;
  const origin = req.headers.origin;
  if (!origin) return req.headers["sec-fetch-site"] === "same-origin";
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** 模型设置中当前生效的 API Key 引用；未配置时退回插件默认引用。 */
function configuredApiKeyRef(settings) {
  return settings.get("llm-pi-ai")?.providers?.[PROVIDER]?.apiKeyEnv ?? API_KEY_ENV;
}

/**
 * 注册积分路由。
 * @param ctx - 插件上下文；等待 `webServer`、`settings`、`credentials` 就绪。
 */
export function installWorkBuddyCredits(ctx) {
  ctx.inject(["webServer", "settings", "credentials"], (webCtx) => {
    const credits = async (req, res) => {
      if (req.method !== "GET") return json(res, 405, { ok: false, message: "Method not allowed" });
      if (!localRequest(req)) return json(res, 403, { ok: false, message: "只允许从本机 DSH 页面查询 WorkBuddy 积分" });
      try {
        const ref = credentialRef(configuredApiKeyRef(webCtx.settings));
        const stored = await webCtx.credentials.resolve(ref);
        const apiKey = stored?.value ?? launchEnvironmentOf(webCtx).get(ref)?.value;
        if (!apiKey) {
          return json(res, 200, {
            ok: true,
            configured: false,
            credits: null,
            segments: [],
            creditError: "未配置 WorkBuddy API Key",
          });
        }
        const result = await fetchWorkBuddyCredits(apiKey);
        json(res, 200, {
          ok: true,
          configured: true,
          credits: result.credits,
          totalDosage: result.totalDosage,
          segments: result.segments,
          creditError: result.creditError,
        });
      } catch (error) {
        // 积分失败不影响模型调用，页面显示“暂不可用”。
        json(res, 200, {
          ok: true,
          configured: true,
          credits: null,
          segments: [],
          creditError: error instanceof Error ? error.message : "查询 WorkBuddy 积分失败",
        });
      }
    };
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({ kind: "exact", path: ROUTE, handler: credits });
      return () => dispose();
    }, "llm-workbuddy: credits route");
  });
}
