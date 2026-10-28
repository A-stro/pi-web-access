import assert from "node:assert/strict";
import { test } from "node:test";

import { extractChatGPTShareContent } from "../chatgpt-share-extract.ts";
import { extractContent } from "../extract.ts";

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const originalFetch = globalThis.fetch;

function flattenTurboStream(value) {
	const values = [];
	const indices = new Map();

	function flatten(input) {
		if (indices.has(input)) return indices.get(input);
		if (input === undefined) return -7;
		if (input === null) return -5;
		if (Number.isNaN(input)) return -2;
		if (input === Number.POSITIVE_INFINITY) return -6;
		if (input === Number.NEGATIVE_INFINITY) return -3;
		if (input === 0 && 1 / input < 0) return -4;

		const index = values.length;
		values.push(null);
		indices.set(input, index);

		if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
			values[index] = input;
		} else if (Array.isArray(input)) {
			values[index] = input.map((item) => flatten(item));
		} else if (input instanceof Date) {
			values[index] = ["D", input.getTime()];
		} else {
			values[index] = Object.fromEntries(
				Object.entries(input).map(([key, item]) => [`_${flatten(key)}`, flatten(item)]),
			);
		}
		return index;
	}

	const root = flatten(value);
	return { root, values };
}

function makeShareHtml(conversation) {
	const { root, values } = flattenTurboStream(conversation);
	const chunk = JSON.stringify(values.slice(root));
	return `<!doctype html><html><head><title>Check out this chat</title></head><body>
		<template id="B:0"></template><div hidden id="S:0"><p>React loading shell</p></div><template id="P:0"></template>
		<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(chunk)})</script>
	</body></html>`;
}

function makeConversation() {
	return {
		loaderData: {
			root: {},
			"routes/share.$shareId.($action)": {
				sharedConversationId: "fixture-share-id",
				serverResponse: {
					type: "data",
					data: {
						title: "Fixture Share",
						mapping: {
							"user-node": {
								id: "user-node",
								parent: null,
								message: {
									author: { role: "user" },
									content: { content_type: "text", parts: ["Question from the user"] },
								},
								children: ["assistant-node"],
							},
							"assistant-node": {
								id: "assistant-node",
								parent: "user-node",
								message: {
									author: { role: "assistant" },
									content: { content_type: "text", parts: ["Answer from ChatGPT"] },
								},
							},
							"alternate-node": {
								id: "alternate-node",
								parent: "user-node",
								message: {
									author: { role: "assistant" },
									content: { content_type: "text", parts: ["Alternate branch must stay hidden"] },
								},
							},
						},
						current_node: "assistant-node",
					},
				},
			},
		},
		actionData: null,
		errors: null,
	};
}

test("ChatGPT share extraction reads the visible React Router conversation path", () => {
	const html = makeShareHtml(makeConversation());
	const result = extractChatGPTShareContent(html, "https://chatgpt.com/share/fixture-share-id");

	assert.equal(result?.title, "Fixture Share");
	assert.match(result?.content ?? "", /\*\*You\*\*\n\nQuestion from the user/);
	assert.match(result?.content ?? "", /\*\*ChatGPT\*\*\n\nAnswer from ChatGPT/);
	assert.doesNotMatch(result?.content ?? "", /Alternate branch must stay hidden/);
	assert.doesNotMatch(result?.content ?? "", /React loading shell|__reactRouterContext|serverResponse/);
});

test("ChatGPT share extraction stays scoped to share URLs", () => {
	const html = makeShareHtml(makeConversation());
	assert.equal(extractChatGPTShareContent(html, "https://chatgpt.com/c/not-a-share"), null);
	assert.equal(extractChatGPTShareContent(html, "https://example.com/share/fixture-share-id"), null);
});

test("fetch_content extracts a ChatGPT shared conversation before generic HTML parsing", async (t) => {
	t.after(() => { globalThis.fetch = originalFetch; });
	globalThis.fetch = async () => new Response(makeShareHtml(makeConversation()), {
		status: 200,
		headers: { "content-type": "text/html" },
	});

	const result = await extractContent("https://chatgpt.com/share/fixture-share-id", undefined, { lookup });
	assert.equal(result.error, null);
	assert.equal(result.title, "Fixture Share");
	assert.match(result.content, /Question from the user/);
	assert.match(result.content, /Answer from ChatGPT/);
});
