export interface ChatGPTShareExtractResult {
	title: string;
	content: string;
}

interface TurboStreamObject {
	[key: string]: unknown;
}

interface ChatGPTMessage {
	author?: {
		role?: string;
	};
	content?: {
		content_type?: string;
		parts?: unknown[];
	};
}

interface ChatGPTConversationNode {
	id?: string;
	message?: ChatGPTMessage;
	parent?: string;
}

const TURBO_STREAM_ENQUEUE = /window\.__reactRouterContext\.streamController\.enqueue\(\s*("(?:\\.|[^"\\])*")\s*\)/g;

const TURBO_STREAM_SPECIAL_VALUES = new Map<number, unknown>([
	[-1, undefined],
	[-2, Number.NaN],
	[-3, Number.NEGATIVE_INFINITY],
	[-4, -0],
	[-5, null],
	[-6, Number.POSITIVE_INFINITY],
	[-7, undefined],
]);

function isChatGPTShareUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (parsed.hostname === "chatgpt.com" || parsed.hostname === "www.chatgpt.com") &&
			/^\/share\/[^/]+\/?$/.test(parsed.pathname);
	} catch {
		return false;
	}
}

function hydrateTurboStream(values: unknown[]): unknown {
	const hydrated: unknown[] = new Array(values.length);

	function hydrate(index: number): unknown {
		if (index < 0) return TURBO_STREAM_SPECIAL_VALUES.get(index);
		if (index in hydrated) return hydrated[index];

		const value = values[index];
		if (value === null || typeof value !== "object") {
			hydrated[index] = value;
			return value;
		}

		if (Array.isArray(value)) {
			if (typeof value[0] === "string") return hydrateSpecialValue(value, index);

			const array: unknown[] = [];
			hydrated[index] = array;
			for (let i = 0; i < value.length; i++) {
				const reference = value[i];
				if (reference === -1) continue;
				if (typeof reference !== "number") throw new TypeError("Invalid turbo-stream array reference");
				array[i] = hydrate(reference);
			}
			return array;
		}

		const object: TurboStreamObject = {};
		hydrated[index] = object;
		for (const [rawKey, rawValue] of Object.entries(value as TurboStreamObject)) {
			const keyMatch = /^_(-?\d+)$/.exec(rawKey);
			if (!keyMatch) throw new TypeError("Invalid turbo-stream object key");
			const key = hydrate(Number(keyMatch[1]));
			if (typeof key !== "string") throw new TypeError("Invalid turbo-stream object key");
			if (typeof rawValue !== "number") throw new TypeError("Invalid turbo-stream object value");
			const propertyValue = hydrate(rawValue);
			Object.defineProperty(object, key, {
				value: propertyValue,
				writable: true,
				enumerable: true,
				configurable: true,
			});
		}
		return object;
	}

	function hydrateSpecialValue(value: unknown[], index: number): unknown {
		const [type, first, second] = value;
		switch (type) {
			case "D":
				hydrated[index] = new Date(Number(first));
				break;
			case "U":
				hydrated[index] = new URL(String(first));
				break;
			case "B":
				hydrated[index] = BigInt(String(first));
				break;
			case "R":
				hydrated[index] = new RegExp(String(first), String(second ?? ""));
				break;
			case "Y":
				hydrated[index] = Symbol.for(String(first));
				break;
			case "S": {
				const set = new Set<unknown>();
				hydrated[index] = set;
				for (let i = 1; i < value.length; i++) set.add(hydrate(Number(value[i])));
				break;
			}
			case "M": {
				const map = new Map<unknown, unknown>();
				hydrated[index] = map;
				for (let i = 1; i < value.length; i += 2) {
					map.set(hydrate(Number(value[i])), hydrate(Number(value[i + 1])));
				}
				break;
			}
			case "N": {
				const object = Object.create(null) as TurboStreamObject;
				hydrated[index] = object;
				const source = first as TurboStreamObject;
				for (const [rawKey, rawValue] of Object.entries(source)) {
					const keyMatch = /^_(-?\d+)$/.exec(rawKey);
					if (!keyMatch) throw new TypeError("Invalid turbo-stream null-object key");
					const key = hydrate(Number(keyMatch[1]));
					if (typeof key !== "string") throw new TypeError("Invalid turbo-stream null-object key");
					object[key] = hydrate(Number(rawValue));
				}
				break;
			}
			case "P":
				hydrated[index] = Promise.resolve(undefined);
				break;
			case "E":
				hydrated[index] = new Error(String(first));
				break;
			case "Z":
				hydrated[index] = hydrate(Number(first));
				break;
			default:
				throw new TypeError(`Unsupported turbo-stream value type: ${type}`);
		}
		return hydrated[index];
	}

	return hydrate(0);
}

function parseTurboStreamRoot(html: string): unknown {
	for (const match of html.matchAll(TURBO_STREAM_ENQUEUE)) {
		try {
			const chunk = JSON.parse(match[1]) as string;
			const values = JSON.parse(chunk) as unknown;
			if (Array.isArray(values)) return hydrateTurboStream(values);
		} catch {
			continue;
		}
	}
	return null;
}

function findConversation(root: unknown): TurboStreamObject | null {
	if (!root || typeof root !== "object") return null;
	const loaderData = (root as TurboStreamObject).loaderData;
	if (!loaderData || typeof loaderData !== "object") return null;

	for (const route of Object.values(loaderData as TurboStreamObject)) {
		if (!route || typeof route !== "object") continue;
		const serverResponse = (route as TurboStreamObject).serverResponse;
		if (!serverResponse || typeof serverResponse !== "object") continue;
		const data = (serverResponse as TurboStreamObject).data;
		if (data && typeof data === "object" && (data as TurboStreamObject).mapping) {
			return data as TurboStreamObject;
		}
	}
	return null;
}

function getVisiblePath(conversation: TurboStreamObject): ChatGPTConversationNode[] {
	const mapping = conversation.mapping;
	if (!mapping || typeof mapping !== "object") return [];

	const nodes = mapping as Record<string, ChatGPTConversationNode>;
	const currentNodeId = conversation.current_node;
	if (typeof currentNodeId !== "string") return [];

	const path: ChatGPTConversationNode[] = [];
	const visited = new Set<string>();
	let node = nodes[currentNodeId];
	while (node && !visited.has(node.id ?? currentNodeId)) {
		const nodeId = node.id ?? currentNodeId;
		visited.add(nodeId);
		path.push(node);
		if (typeof node.parent !== "string") break;
		node = nodes[node.parent];
	}
	return path.reverse();
}

function extractText(parts: unknown[] | undefined): string {
	if (!parts) return "";
	const text: string[] = [];
	for (const part of parts) {
		if (typeof part === "string") {
			text.push(part);
			continue;
		}
		if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
			text.push((part as { text: string }).text);
		}
	}
	return text
		.join("\n\n")
		.replace(/[^\n]*/g, "")
		.trim();
}

function formatConversation(path: ChatGPTConversationNode[]): string {
	const messages: string[] = [];
	for (const node of path) {
		const message = node.message;
		const role = message?.author?.role;
		if (role !== "user" && role !== "assistant") continue;
		const contentType = message?.content?.content_type;
		if (contentType && contentType !== "text" && contentType !== "multimodal_text") continue;
		const content = extractText(message?.content?.parts);
		if (!content) continue;
		const author = role === "user" ? "You" : "ChatGPT";
		messages.push(`**${author}**\n\n${content}`);
	}
	return messages.join("\n\n---\n\n");
}

/** Extract a shared ChatGPT conversation from its React Router turbo-stream payload. */
export function extractChatGPTShareContent(html: string, url: string): ChatGPTShareExtractResult | null {
	if (!isChatGPTShareUrl(url) || !html.includes("__reactRouterContext.streamController.enqueue")) return null;

	try {
		const root = parseTurboStreamRoot(html);
		const conversation = findConversation(root);
		if (!conversation) return null;

		const content = formatConversation(getVisiblePath(conversation));
		if (!content) return null;
		const title = typeof conversation.title === "string" && conversation.title.trim()
			? conversation.title.trim()
			: "ChatGPT Conversation";
		return { title, content };
	} catch {
		return null;
	}
}
