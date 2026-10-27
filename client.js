/**
 * dsh-usemodel — browser half.
 *
 * 在「设置」左侧加一栏「自定义模型」：列出自己配的 OpenAI 兼容渠道，
 * 每条可编辑名称 / Base URL / API Key / 模型名，保存后模型进入模型选择器。
 *
 * 数据走插件自己的同源路由 /api/usemodel（Host 半在 index.js）。
 */
window.__ModuleLoader__.load({
	id: "dsh-usemodel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useMemo, Component } = react;

		const name = "dsh-usemodel";
		const inject = ["slots", "locale"];
		const NS = "settings.dsh-usemodel";
		const API = "/api/usemodel";

		/** 设置页左栏标题 */
		const TITLE = "自定义模型";

		const S = {
			card: {
				border: "1px solid rgba(127,127,127,.22)",
				borderRadius: 10,
				padding: "12px 14px",
				marginBottom: 10,
				background: "rgba(127,127,127,.06)",
			},
			row: { display: "flex", alignItems: "center", gap: 8 },
			grow: { flex: 1, minWidth: 0 },
			label: { fontSize: 12, opacity: .72, marginBottom: 4, display: "block" },
			input: {
				width: "100%",
				boxSizing: "border-box",
				padding: "7px 9px",
				borderRadius: 7,
				border: "1px solid rgba(127,127,127,.3)",
				background: "rgba(127,127,127,.08)",
				color: "inherit",
				fontSize: 13,
				fontFamily: "inherit",
				outline: "none",
			},
			area: {
				width: "100%",
				boxSizing: "border-box",
				minHeight: 64,
				padding: "7px 9px",
				borderRadius: 7,
				border: "1px solid rgba(127,127,127,.3)",
				background: "rgba(127,127,127,.08)",
				color: "inherit",
				fontSize: 12,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				resize: "vertical",
				outline: "none",
			},
			btn: {
				padding: "6px 12px",
				borderRadius: 7,
				border: "1px solid rgba(127,127,127,.3)",
				background: "rgba(127,127,127,.1)",
				color: "inherit",
				fontSize: 12.5,
				cursor: "pointer",
				fontFamily: "inherit",
				whiteSpace: "nowrap",
			},
			btnPrimary: {
				padding: "6px 14px",
				borderRadius: 7,
				border: "1px solid rgba(90,150,255,.55)",
				background: "rgba(90,150,255,.18)",
				color: "inherit",
				fontSize: 12.5,
				cursor: "pointer",
				fontFamily: "inherit",
				fontWeight: 600,
				whiteSpace: "nowrap",
			},
			btnDanger: {
				padding: "6px 12px",
				borderRadius: 7,
				border: "1px solid rgba(230,90,90,.5)",
				background: "rgba(230,90,90,.12)",
				color: "inherit",
				fontSize: 12.5,
				cursor: "pointer",
				fontFamily: "inherit",
				whiteSpace: "nowrap",
			},
			title: { fontSize: 15, fontWeight: 600, margin: 0 },
			hint: { fontSize: 12, opacity: .65, lineHeight: 1.6, margin: "6px 0 0" },
			mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, opacity: .7 },
			tag: {
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 20,
				background: "rgba(127,127,127,.16)",
				opacity: .85,
				whiteSpace: "nowrap",
			},
			ok: { fontSize: 12, color: "#3fbf7f" },
			err: { fontSize: 12, color: "#e5716a" },
			overlay: {
				position: "fixed",
				inset: 0,
				background: "rgba(0,0,0,.45)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 9999,
				padding: 24,
			},
			modal: {
				width: "min(620px, 94vw)",
				maxHeight: "88vh",
				overflow: "auto",
				borderRadius: 14,
				border: "1px solid rgba(127,127,127,.3)",
				background: "var(--dsh-bg, #1f2124)",
				color: "inherit",
				padding: 18,
				boxShadow: "0 24px 60px rgba(0,0,0,.5)",
			},
		};

		/** {id,name} 或旧字符串 → 一行 `id` 或 `id => 名字`。 */
		function modelToLine(m) {
			if (typeof m === "string") return m;
			if (m !== null && typeof m === "object") {
				const id = String(m.id ?? "");
				const name = String(m.name ?? "");
				if (id === "") return "";
				return (name === "" || name === id) ? id : (id + " => " + name);
			}
			return "";
		}
		const EMPTY = {
			id: "",
			name: "",
			baseURL: "",
			apiKey: "",
			modelsText: "",
			contextWindow: "",
			maxTokens: "",
		};

		/** 常用端点，点一下就填上 Base URL。 */
		const PRESETS = [
			{ label: "OpenAI", baseURL: "https://api.openai.com/v1", models: "gpt-4o-mini" },
			{ label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", models: "deepseek-chat" },
			{ label: "硅基流动", baseURL: "https://api.siliconflow.cn/v1", models: "deepseek-ai/DeepSeek-V3" },
			{ label: "Moonshot", baseURL: "https://api.moonshot.cn/v1", models: "moonshot-v1-8k" },
			{ label: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4", models: "glm-4-flash" },
			{ label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", models: "openai/gpt-4o-mini" },
		];

		function api(path, options) {
			return fetch(API + path, {
				headers: { "content-type": "application/json" },
				...options,
			}).then(async (response) => {
				const text = await response.text();
				let payload;
				try { payload = JSON.parse(text); } catch { payload = { ok: false, error: text || ("HTTP " + response.status) }; }
				if (payload === null || typeof payload !== "object") payload = { ok: false, error: "空响应" };
				return payload;
			});
		}

		function Field(props) {
			return h("div", { style: { marginBottom: 10 } },
				h("label", { style: S.label }, props.label),
				props.multiline
					? h("textarea", {
						style: S.area,
						value: props.value,
						placeholder: props.placeholder,
						spellCheck: false,
						onChange: (e) => props.onChange(e.target.value),
					})
					: h("input", {
						style: S.input,
						type: props.type || "text",
						value: props.value,
						placeholder: props.placeholder,
						spellCheck: false,
						autoComplete: "off",
						onChange: (e) => props.onChange(e.target.value),
					}),
				props.hint ? h("p", { style: S.hint }, props.hint) : null,
			);
		}

		function Editor(props) {
			const { initial, onClose, onSaved } = props;
			const [form, setForm] = useState(() => ({
				id: initial?.id ?? "",
				name: initial?.name ?? "",
				baseURL: initial?.baseURL ?? "",
				apiKey: initial?.apiKey ?? "",
				modelsText: (initial?.models ?? []).map(modelToLine).filter((line) => line !== "").join("\n"),
				contextWindow: initial?.contextWindow ? String(initial.contextWindow) : "",
				maxTokens: initial?.maxTokens ? String(initial.maxTokens) : "",
			}));
			const [busy, setBusy] = useState("");
			const [msg, setMsg] = useState(null);
			const [tested, setTested] = useState(null);

			const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }));

			const build = useCallback(() => {
				const models = form.modelsText
					.split(/\r?\n/)
					.map((m) => m.trim())
					.filter((m) => m !== "");
				return {
					channel: {
						id: form.id,
						name: form.name.trim() || "未命名渠道",
						baseURL: form.baseURL.trim(),
						apiKey: form.apiKey.trim(),
						models,
						contextWindow: Number(form.contextWindow) || 0,
						maxTokens: Number(form.maxTokens) || 0,
					},
				};
			}, [form]);

			const save = async () => {
				setBusy("save");
				setMsg(null);
				const payload = build();
				if (payload.channel.baseURL === "") {
					setMsg({ kind: "err", text: "Base URL 必填" });
					setBusy("");
					return;
				}
				if (payload.channel.models.length === 0) {
					setMsg({ kind: "err", text: "至少填一个模型名（一行一个）" });
					setBusy("");
					return;
				}
				const result = await api("/save", { method: "POST", body: JSON.stringify(payload) });
				setBusy("");
				if (result.ok) {
					setMsg({ kind: "ok", text: "已保存，模型选择器里已经能看到（下拉列表可能需要重新打开）" });
					onSaved?.(result.config);
				} else {
					setMsg({ kind: "err", text: result.error || "保存失败" });
				}
			};

			const test = async () => {
				setBusy("test");
				setMsg(null);
				setTested(null);
				const payload = build();
				const firstEntry = payload.channel.models[0];
				const firstModel = typeof firstEntry === "string" ? firstEntry : (firstEntry?.id ?? "");
				if (payload.channel.baseURL === "" || payload.channel.apiKey === "" || firstModel === "") {
					setMsg({ kind: "err", text: "测连通要填全：Base URL、API Key、至少一个模型名" });
					setBusy("");
					return;
				}
				const result = await api("/test", {
					method: "POST",
					body: JSON.stringify({ channel: payload.channel, model: firstModel }),
				});
				setBusy("");
				setTested(result);
			};

			/** 拿当前填的 baseURL + key 去上游 /models 拉一遍，直接覆盖模型名。 */
			const pullModels = async () => {
				setBusy("pull");
				setMsg(null);
				const result = await api("/models", {
					method: "POST",
					body: JSON.stringify({ baseURL: form.baseURL.trim(), apiKey: form.apiKey.trim() }),
				});
				setBusy("");
				if (result.ok !== true) {
					setMsg({ kind: "err", text: `拉取失败：${result.error || "未知错误"}` });
					return;
				}
				if (!Array.isArray(result.models) || result.models.length === 0) {
					setMsg({ kind: "err", text: "上游没返回可用的模型名，手填吧" });
					return;
				}
				setForm((prev) => ({ ...prev, modelsText: result.models.join("\n") }));
				const dropped = Number(result.total) > result.models.length ? result.total - result.models.length : 0;
				setMsg({
					kind: "ok",
					text: `拉到 ${result.models.length} 个模型` + (dropped > 0 ? `（共 ${result.total} 个，滤掉了 ${dropped} 个非对话模型）` : ""),
				});
			};

			const applyPreset = (preset) => {
				setForm((prev) => ({
					...prev,
					baseURL: preset.baseURL,
					modelsText: prev.modelsText.trim() === "" ? preset.models : prev.modelsText,
					name: prev.name.trim() === "" ? preset.label : prev.name,
				}));
			};

			return h("div", { style: S.overlay, onMouseDown: (e) => { if (e.target === e.currentTarget) onClose?.(); } },
				h("div", { style: S.modal },
					h("div", { style: { ...S.row, marginBottom: 14 } },
						h("h3", { style: { ...S.title, flex: 1 } }, form.id === "" ? "新增渠道" : "编辑渠道"),
						h("button", { style: S.btn, onClick: onClose }, "关闭"),
					),
					h("div", { style: { marginBottom: 12 } },
						h("label", { style: S.label }, "快速填充"),
						h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
							PRESETS.map((preset) => h("button", {
								key: preset.label,
								style: S.btn,
								onClick: () => applyPreset(preset),
							}, preset.label)),
						),
					),
					h(Field, { label: "显示名称", value: form.name, onChange: set("name"), placeholder: "例如 我的 OpenAI" }),
					h(Field, {
						label: "Base URL",
						value: form.baseURL,
						onChange: set("baseURL"),
						placeholder: "https://api.openai.com/v1",
						hint: "填到 /v1 这一层，插件自动拼 /chat/completions",
					}),
					h(Field, {
						label: "API Key",
						type: "password",
						value: form.apiKey,
						onChange: set("apiKey"),
						placeholder: "sk-...",
						hint: "明文存在 %USERPROFILE%\\.dsh\\usemodel\\config.json，只在本机",
					}),
					h(Field, {
						label: "模型（一行一个；左边真实 id，=> 右边随你起名）",
						multiline: true,
						value: form.modelsText,
						onChange: set("modelsText"),
						placeholder: "gpt-4o-mini\ngpt-4o => 我的 GPT\n[按量6] deepseek-v4.1-flash-1017 [不补] => DeepSeek",
						hint: "左边必须是上游真实 id；不写 => 就自动去掉方括号当显示名。点下面按钮能拉真实 id",
					}),
					h("div", { style: { ...S.row, marginTop: -6, marginBottom: 12 } },
						h("button", { style: S.btn, onClick: pullModels, disabled: busy !== "" },
							busy === "pull" ? "拉取中…" : "从上游拉取模型列表"),
						h("span", { style: { ...S.hint, fontSize: 11.5 } }, "需要 Base URL + Key 都填好"),
					),
					h("div", { style: { display: "flex", gap: 10 } },
						h("div", { style: { flex: 1 } },
							h(Field, { label: "上下文窗口（可空，默认 128000）", value: form.contextWindow, onChange: set("contextWindow"), placeholder: "128000" }),
						),
						h("div", { style: { flex: 1 } },
							h(Field, { label: "单次最大输出（可空）", value: form.maxTokens, onChange: set("maxTokens"), placeholder: "8192" }),
						),
					),
					msg !== null
						? h("p", { style: msg.kind === "ok" ? S.ok : S.err }, msg.text)
						: null,
					tested !== null
						? h("div", { style: { marginBottom: 10, fontSize: 12, lineHeight: 1.6 } },
							tested.ok
								? h("span", { style: S.ok }, `连通正常 · HTTP ${tested.status} · ${tested.ms}ms` + (tested.preview ? ` · 回复：${tested.preview}` : ""))
								: h("span", { style: S.err }, `失败 · ${tested.error}`),
						)
						: null,
					h("div", { style: { ...S.row, marginTop: 6 } },
						h("button", { style: S.btnPrimary, onClick: save, disabled: busy !== "" }, busy === "save" ? "保存中…" : "保存"),
						h("button", { style: S.btn, onClick: test, disabled: busy !== "" }, busy === "test" ? "测试中…" : "测连通"),
						h("div", { style: S.grow }),
						h("span", { style: S.hint }, "保存后无需重启 DSH"),
					),
				),
			);
		}

		function ChannelCard(props) {
			const { channel, onEdit, onDelete, onTest } = props;
			const [busy, setBusy] = useState(false);
			const [result, setResult] = useState(null);

			const maskKey = (key) => {
				if (key === "") return "未填 Key";
				if (key.length <= 8) return "••••";
				return key.slice(0, 4) + "••••" + key.slice(-4);
			};

			const runTest = async () => {
				setBusy(true);
				setResult(null);
				const response = await api("/test", {
					method: "POST",
					body: JSON.stringify({ channel, model: typeof channel.models[0] === "string" ? channel.models[0] : (channel.models[0]?.id ?? "") }),
				});
				setBusy(false);
				setResult(response);
				onTest?.(response);
			};

			return h("div", { style: S.card },
				h("div", { style: S.row },
					h("div", { style: S.grow },
						h("div", { style: { ...S.row, gap: 8 } },
							h("strong", { style: { fontSize: 13.5 } }, channel.name),
							h("span", { style: S.tag }, `${channel.models.length} 个模型`),
						),
						h("div", { style: { ...S.mono, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
							channel.baseURL + "  ·  " + maskKey(channel.apiKey)),
						h("div", { style: { ...S.mono, marginTop: 2 } }, channel.models.map((m) => (typeof m === "string" ? m : (m.name || m.id))).join(" · ")),
					),
					h("button", { style: S.btn, onClick: runTest, disabled: busy }, busy ? "测试中…" : "测连通"),
					h("button", { style: S.btn, onClick: () => onEdit(channel) }, "编辑"),
					h("button", {
						style: S.btnDanger,
						onClick: () => {
							if (window.confirm(`删除渠道「${channel.name}」？`)) onDelete(channel.id);
						},
					}, "删除"),
				),
				result !== null
					? h("p", { style: result.ok ? S.ok : S.err, marginTop: 0 },
						result.ok
							? `连通正常 · ${result.ms}ms` + (result.preview ? ` · ${result.preview}` : "")
							: `失败 · ${result.error}`)
					: null,
			);
		}

		function SettingsPage(props) {
			const [config, setConfig] = useState(null);
			const [error, setError] = useState("");
			const [editing, setEditing] = useState(null);
			const [notice, setNotice] = useState("");
			const [paste, setPaste] = useState("");
			const [detecting, setDetecting] = useState(false);
			const [pasteMsg, setPasteMsg] = useState(null);

			const load = useCallback(async () => {
				const result = await api("/state");
				if (result.ok) {
					setConfig(result.config);
					setError("");
				} else {
					setError(result.error || "读取失败");
				}
			}, []);

			useEffect(() => { load(); }, [load]);

			/** 粘贴识别：认出地址和 Key 就预填到编辑弹窗，让用户确认再存。 */
			const detect = async () => {
				const text = paste.trim();
				if (text === "") { setPasteMsg({ kind: "err", text: "先粘贴点东西进来" }); return; }
				setDetecting(true);
				setPasteMsg(null);
				const result = await api("/detect", { method: "POST", body: JSON.stringify({ text }) });
				setDetecting(false);
				if (result.ok !== true) {
					setPasteMsg({ kind: "err", text: result.error || "没认出来" });
					return;
				}
				const channel = result.channel;
				setPaste("");
				setEditing({
					id: "",
					name: channel.name,
					baseURL: channel.baseURL,
					apiKey: channel.apiKey,
					models: channel.models,
					contextWindow: channel.contextWindow,
					maxTokens: channel.maxTokens,
				});
				setPasteMsg({
					kind: "ok",
					text: (result.notes?.length > 0 ? result.notes.join(" · ") + " · " : "")
						+ "已识别，确认无误后点「保存」",
				});
			};

			const remove = async (id) => {
				const result = await api("/delete", { method: "POST", body: JSON.stringify({ id }) });
				if (result.ok) {
					setConfig(result.config);
					setNotice("已删除");
				} else {
					setError(result.error || "删除失败");
				}
			};

			const channels = config?.channels ?? [];
			const totalModels = useMemo(() => channels.reduce((sum, c) => sum + c.models.length, 0), [channels]);

			if (config === null) {
				return h("div", { style: { padding: 20, fontSize: 13, opacity: .7 } },
					error ? `读取配置失败：${error}` : "加载中…");
			}

			return h("div", { style: { padding: "4px 2px 40px" } },
				h("div", { style: { ...S.row, marginBottom: 6 } },
					h("h2", { style: { ...S.title, flex: 1 } }, TITLE),
					h("span", { style: S.hint }, `${channels.length} 个渠道 · ${totalModels} 个模型`),
					h("button", { style: S.btnPrimary, onClick: () => setEditing(EMPTY) }, "+ 新增渠道"),
				),
				h("div", { style: { ...S.card, marginTop: 12, marginBottom: 14 } },
					h("div", { style: { ...S.row, marginBottom: 8 } },
						h("strong", { style: { fontSize: 13 } }, "粘贴识别"),
						h("div", { style: S.grow }),
						h("span", { style: S.hint }, "认地址、认 Key、顺手把模型列表拉回来"),
					),
					h("textarea", {
						style: { ...S.area, minHeight: 56 },
						value: paste,
						spellCheck: false,
						placeholder:
							"把下面任意一种贴进来：\n"
							+ "· Base URL：https://api.openai.com/v1\n"
							+ "· 一个 Key：sk-xxxxxxxx\n"
							+ "· 两行一起贴，或者中转站给的分享链接 / 整段 JSON / curl 命令",
						onChange: (e) => setPaste(e.target.value),
						onKeyDown: (e) => {
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); detect(); }
						},
					}),
					h("div", { style: { ...S.row, marginTop: 8 } },
						h("button", { style: S.btnPrimary, onClick: detect, disabled: detecting },
							detecting ? "识别中…" : "识别"),
						h("span", { style: { ...S.hint, fontSize: 11.5 } }, "Ctrl+Enter"),
						h("div", { style: S.grow }),
						h("button", { style: S.btn, onClick: () => setEditing(EMPTY) }, "手动填"),
					),
					pasteMsg !== null
						? h("p", { style: pasteMsg.kind === "ok" ? { ...S.ok, marginBottom: 0 } : { ...S.err, marginBottom: 0 } }, pasteMsg.text)
						: null,
				),
				h("p", { style: S.hint },
					"填自己的 OpenAI 兼容端点（OpenAI / DeepSeek / 硅基流动 / 任何兼容 /v1/chat/completions 的服务）。",
					"保存后模型会出现在对话输入框右下角的模型选择器里，显示名是「渠道名 · 模型名」。",
				),
				notice !== "" ? h("p", { style: S.ok }, notice) : null,
				error !== "" ? h("p", { style: S.err }, error) : null,
				h("div", { style: { marginTop: 14 } },
					channels.length === 0
						? h("div", { style: { ...S.card, textAlign: "center", padding: "26px 14px", opacity: .7, fontSize: 13 } },
							"还没有渠道。点右上角「+ 新增渠道」，填 Base URL 和 API Key 就能用。")
						: channels.map((channel) => h(ChannelCard, {
							key: channel.id,
							channel,
							onEdit: (c) => setEditing(c),
							onDelete: remove,
						})),
				),
				h("p", { style: { ...S.hint, marginTop: 18, opacity: .5 } },
					"配置文件：%USERPROFILE%\\.dsh\\usemodel\\config.json（可直接编辑，保存时插件会重读）"),
				editing !== null
					? h(Editor, {
						initial: editing,
						onClose: () => setEditing(null),
						onSaved: (next) => { setConfig(next); setNotice("已保存"); },
					})
					: null,
			);
		}

		/** 页面出任何异常都只坏这一栏，不连累整个设置页。 */
		class Boundary extends Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			render() {
				if (this.state.error !== null) {
					return h("div", { style: { padding: 20, fontSize: 13, color: "#e5716a", lineHeight: 1.7 } },
						h("strong", null, "自定义模型页面加载出错"),
						h("p", { style: { opacity: .8 } }, String(this.state.error?.message ?? this.state.error)),
						h("p", { style: { opacity: .6, fontSize: 12 } }, "配置仍可用，也可以直接编辑 %USERPROFILE%\\.dsh\\usemodel\\config.json"),
					);
				}
				return this.props.children;
			}
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "usemodel",
				order: 36,
				label: () => TITLE,
				locale: NS,
			}, (props) => h(Boundary, null, h(SettingsPage, { ...props }))));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.__test = { SettingsPage, Editor, ChannelCard };
		return module.exports;
	},
});
