/**
 * WorkBuddy 积分的浏览器侧 UI：输入框底部的积分胶囊。
 *
 * 只做一件事——在 composer dock 里显示当前 API Key 的剩余积分，点击展开明细。
 * 认证配置全部由 DSH 模型设置页承担（地址与协议来自插件的 provider 默认层），
 * 这里不再注入任何表单、不再监听 DOM 变化、也不再处理登录令牌。
 */
window.__ModuleLoader__.load({
  id: "@axiaohungry/dsh-llm-workbuddy",
  factory: (require) => {
    const ROUTE = "/dsh-llm-workbuddy/credits";
    const WORKBUDDY_PROVIDER_PATTERN = /(?:^|-)(?:work-?buddy|code-?buddy)(?:-|$)/;
    const React = require("react");
    const ReactDOM = require("react-dom");
    const { createElement, useEffect, useState } = React;
    const { createPortal } = ReactDOM;

    const CREDIT_CACHE_TTL_MS = 30_000;
    const CREDIT_CACHE_KEY = "dsh-llm-workbuddy:credits";

    function isWorkBuddyProvider(value) {
      const normalized = String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return normalized.length > 0 && WORKBUDDY_PROVIDER_PATTERN.test(normalized);
    }

    function isModLensWorkBuddyProvider(value) {
      const normalized = String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return /^modlens-(?:work-?buddy|code-?buddy)(?:-|$)/.test(normalized);
    }

    function formatCredits(value) {
      const number = Number(value);
      return Number.isFinite(number) ? number.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "—";
    }

    function formatExpiry(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
      const date = new Date(value);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    async function creditsRequest() {
      const response = await fetch(ROUTE, { method: "GET", cache: "no-store" });
      const text = await response.text();
      let result = {};
      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        result = {};
      }
      if (!response.ok || result.ok === false) {
        const error = new Error(result.message || `请求失败（${response.status}）`);
        error.status = response.status;
        throw error;
      }
      return result;
    }

    /**
     * 跨会话/跨窗口共享一份持久缓存。切会话、刷新页面或新开窗口都先读缓存，
     * 距上次成功请求不足 30 秒时不再发请求。
     */
    const creditCache = (() => {
      const memory = new Map();
      try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CREDIT_CACHE_KEY) : null;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            for (const [id, entry] of Object.entries(parsed)) memory.set(id, entry);
          }
        }
      } catch {
        // 存储损坏或不可用时保持内存缓存为空。
      }
      const persist = () => {
        try {
          if (typeof localStorage !== "undefined") {
            localStorage.setItem(CREDIT_CACHE_KEY, JSON.stringify(Object.fromEntries(memory)));
          }
        } catch {
          // 持久化尽力而为；内存缓存仍然可用。
        }
      };
      return {
        get(key) {
          return memory.get(key) ?? null;
        },
        set(key, result, at) {
          memory.set(key, {
            credits: result.credits,
            segments: Array.isArray(result.segments) ? result.segments : [],
            configured: result.configured !== false,
            creditLoading: false,
            creditError: result.creditError ?? null,
            fetchedAt: at,
          });
          persist();
        },
        setError(key, message, at) {
          const prev = memory.get(key);
          memory.set(key, {
            ...(prev ?? {}),
            credits: prev?.credits ?? null,
            segments: prev?.segments ?? [],
            configured: prev?.configured ?? true,
            creditLoading: false,
            creditError: message,
            fetchedAt: at,
          });
          persist();
        },
        isFresh(key, now) {
          const entry = memory.get(key);
          return Boolean(entry) && typeof entry.fetchedAt === "number" && now - entry.fetchedAt < CREDIT_CACHE_TTL_MS;
        },
      };
    })();

    // 同一个 key 只允许一个在途请求，胶囊展开与页面刷新共享一次调用。
    const creditInflight = new Map();
    const CREDIT_KEY = "workbuddy";

    function creditsText(state) {
      if (state?.creditLoading) return "剩余积分：读取中…";
      if (typeof state?.credits === "number" && Number.isFinite(state.credits)) return `剩余积分：${formatCredits(state.credits)}`;
      if (state?.creditError) return "剩余积分：暂不可用";
      return "剩余积分：—";
    }

    function WorkBuddyCreditsDock({ useProjection }) {
      let selection;
      try {
        selection = typeof useProjection === "function" ? useProjection("modelSelection") : undefined;
      } catch {
        selection = undefined;
      }
      const provider = selection?.next?.provider ?? selection?.lastUsed?.provider ?? selection?.provider;
      const selected = isWorkBuddyProvider(provider);
      const modlens = isModLensWorkBuddyProvider(provider);
      const [state, setState] = useState(null);
      const [open, setOpen] = useState(false);
      const rootRef = React.useRef(null);

      const applyCache = React.useCallback(() => {
        const entry = creditCache.get(CREDIT_KEY);
        setState({
          credits: entry?.credits ?? null,
          segments: Array.isArray(entry?.segments) ? entry.segments : [],
          creditLoading: entry?.creditLoading ?? false,
          creditError: entry?.creditError ?? null,
        });
      }, []);

      useEffect(() => {
        if (!open) return;
        const onPointerDown = (event) => {
          const target = event.target;
          // 弹层挂在 body 上，不在 rootRef 内，需要单独判断。
          if (!(target instanceof Node)) return;
          if (target.closest && target.closest(".dsh-workbuddy-credits-popup")) return;
          if (rootRef.current && rootRef.current.contains(target)) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown);
        return () => {
          document.removeEventListener("pointerdown", onPointerDown, true);
          document.removeEventListener("keydown", onKeyDown);
        };
      }, [open]);

      // 折叠状态只显示缓存；展开弹层时才请求接口。不按定时器轮询。
      useEffect(() => {
        if (!selected) {
          setState(null);
          return;
        }
        applyCache();
      }, [provider, selected, applyCache]);

      const loadCredits = async () => {
        const now = Date.now();
        if (creditCache.isFresh(CREDIT_KEY, now)) {
          applyCache();
          return;
        }
        const existing = creditInflight.get(CREDIT_KEY);
        if (existing) {
          try {
            await existing;
          } catch {
            // 错误已由发起方写入缓存。
          }
          applyCache();
          return;
        }
        setState((prev) => ({ ...(prev ?? {}), creditLoading: true }));
        const promise = (async () => {
          try {
            creditCache.set(CREDIT_KEY, await creditsRequest(), Date.now());
          } catch (error) {
            creditCache.setError(CREDIT_KEY, error instanceof Error ? error.message : "查询 WorkBuddy 积分失败", Date.now());
          } finally {
            creditInflight.delete(CREDIT_KEY);
          }
        })();
        creditInflight.set(CREDIT_KEY, promise);
        try {
          await promise;
        } catch {
          // 已写入缓存。
        }
        applyCache();
      };

      const onToggle = () => {
        const next = !open;
        setOpen(next);
        if (next) void loadCredits();
      };

      // 弹层优先显示在胶囊上方，空间不足时移到下方，并限制在视口内。
      const [popupPos, setPopupPos] = useState(null);
      React.useLayoutEffect(() => {
        if (!open || !rootRef.current) {
          setPopupPos(null);
          return;
        }
        const anchor = rootRef.current.getBoundingClientRect();
        const panel = document.querySelector(".dsh-workbuddy-credits-popup");
        const margin = 12;
        const gap = 8;
        const width = panel ? Math.min(panel.offsetWidth, window.innerWidth - margin * 2) : 300;
        const height = panel ? panel.offsetHeight : 160;
        const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin));
        let top = anchor.top - gap - height;
        if (top < margin) top = anchor.bottom + gap;
        if (top + height > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - height - margin);
        setPopupPos({ position: "fixed", left, top, visibility: "visible" });
      }, [open, state]);

      if (!selected) return null;
      const label = creditsText(state);
      const segments = Array.isArray(state?.segments) ? state.segments : [];
      const popupTitle = state?.creditError ?? "WorkBuddy 剩余积分";
      const modlensHint = modlens ? createElement("span", {
        "data-workbuddy-modlens-hint": true,
        title: "ModLens 会先处理会话中的历史图片，首次响应可能较慢；若超时、无响应或返回 429，请检查视觉引擎登录、网络和额度。纯文本任务可切换 WorkBuddy 直连。",
        style: {
          display: "block",
          marginTop: "10px",
          minWidth: 0,
          color: "var(--dsw-text-tertiary, #98a2b3)",
          fontSize: "11px",
          lineHeight: "16px",
        },
      }, "ModLens：历史图片会先处理，响应较慢或出现 429 时请检查视觉引擎与额度；纯文本可切换 WorkBuddy 直连") : null;

      const rows = [
        ["剩余积分", label.replace("剩余积分：", "")],
        ...segments.map((segment) => {
          const expiry = formatExpiry(segment.expiresAt);
          const name = String(segment.source || "积分");
          return [expiry ? `${name}（至 ${expiry}）` : name, formatCredits(segment.remaining)];
        }),
      ];

      return createElement(
        "div",
        {
          className: "dsh-workbuddy-credits",
          "data-workbuddy-credits": true,
          style: {
            boxSizing: "border-box",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: "12px",
            minWidth: 0,
            maxWidth: "100%",
            minHeight: "20px",
            padding: "0",
            flex: "0 0 auto",
            flexWrap: "wrap",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "normal",
            overflow: "visible",
          },
        },
        createElement(
          "span",
          { className: "dsh-workbuddy-credits-pill-anchor", ref: rootRef },
          createElement(
            "button",
            {
              type: "button",
              className: "dsh-workbuddy-credits-pill",
              "aria-haspopup": "dialog",
              "aria-expanded": open,
              "aria-label": label,
              title: popupTitle,
              onClick: onToggle,
              style: { cursor: "pointer" },
            },
            createElement("span", { className: "dsh-workbuddy-credits-pill-label", style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, label),
          ),
          open ? createPortal(
            createElement(
              "div",
              {
                className: "dsh-workbuddy-credits-popup",
                role: "dialog",
                "aria-label": popupTitle,
                onClick: (event) => { event.stopPropagation(); },
                style: {
                  ...(popupPos ?? { position: "fixed", left: 0, top: 0, visibility: "hidden" }),
                  zIndex: 1100,
                  boxSizing: "border-box",
                  width: "max-content",
                  minWidth: "min(300px, calc(100vw - 24px))",
                  maxWidth: "min(440px, calc(100vw - 24px))",
                  maxHeight: "calc(100vh - 24px)",
                  overflowY: "auto",
                  padding: "16px",
                  border: "0",
                  borderRadius: "12px",
                  background: "var(--dsw-specific-menu, #ffffff)",
                  boxShadow: "var(--dsw-elevation-prominent, 0 12px 32px rgba(16, 24, 40, 0.18))",
                  color: "var(--dsw-alias-label-secondary, #475467)",
                  fontSize: "12px",
                  lineHeight: "18px",
                  cursor: "default",
                },
              },
              createElement(
                "div",
                { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", marginBottom: "8px", color: "var(--dsw-alias-label-primary, #101828)", fontWeight: 500 } },
                createElement("span", { style: { minWidth: 0, overflowWrap: "anywhere" } }, "WorkBuddy 剩余积分"),
                createElement(
                  "button",
                  {
                    type: "button",
                    "aria-label": "关闭",
                    onClick: () => setOpen(false),
                    style: { flex: "none", border: "none", background: "transparent", color: "inherit", font: "inherit", fontSize: "14px", lineHeight: "18px", cursor: "pointer", padding: "0 2px" },
                  },
                  "✕",
                ),
              ),
              createElement("div", { style: { marginBottom: "10px", borderTop: "0.5px solid var(--dsw-alias-border-l2, #eaecf0)" } }),
              createElement(
                "dl",
                { style: { display: "grid", gridTemplateColumns: "minmax(76px, auto) minmax(0, 1fr)", gap: "6px 16px", margin: 0, color: "var(--dsw-alias-label-tertiary, #98a2b3)" } },
                ...rows.flatMap(([term, value], index) => [
                  createElement("dt", { key: `t${index}`, style: { minWidth: 0, margin: 0, overflowWrap: "anywhere" } }, term),
                  createElement("dd", { key: `d${index}`, style: { minWidth: 0, margin: 0, color: "var(--dsw-alias-label-secondary, #475467)", fontVariantNumeric: "tabular-nums", textAlign: "right" } }, value),
                ]),
                ...(state?.creditError
                  ? [createElement("dd", { key: "err", style: { gridColumn: "1 / -1", margin: 0, color: "var(--dsw-text-danger, #c62828)", overflowWrap: "anywhere" } }, state.creditError)]
                  : []),
              ),
              modlensHint,
            ),
            document.body,
          ) : null,
        ),
      );
    }

    function installComposerDockLayout() {
      if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="dsh-llm-workbuddy-composer-dock"]')) return;
      const style = document.createElement("style");
      style.dataset.plugin = "@axiaohungry/dsh-llm-workbuddy";
      style.dataset.pluginCss = "dsh-llm-workbuddy-composer-dock";
      style.textContent = `
[data-slot="conversation.composer.dock"]:has(> [data-composer-stats]),
[data-slot="conversation.composer.dock"]:has(> [data-workbuddy-credits]) {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  display: flex !important;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 0 4px 4px;
  overflow: hidden;
}
[data-slot="conversation.composer.dock"] > [data-composer-stats],
[data-slot="conversation.composer.dock"] > [data-workbuddy-credits] {
  width: auto !important;
  max-width: 100%;
  min-width: 0;
  margin: 0 !important;
}
/* 胶囊对齐原生统计 pill：同样的 13/20 三级文本与圆角。 */
.dsh-workbuddy-credits-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  max-width: 100%;
  padding: 1px 8px;
  border: none;
  border-radius: 24px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsh-workbuddy-credits-pill:hover,
.dsh-workbuddy-credits-pill[aria-expanded='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
`;
      document.head.appendChild(style);
    }

    function apply(ctx) {
      installComposerDockLayout();
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "workbuddy-credits",
        order: 100,
        label: "WorkBuddy 剩余积分",
      }, WorkBuddyCreditsDock));
    }

    return { name: "dsh-llm-workbuddy-client", inject: ["slots"], apply };
  },
});
