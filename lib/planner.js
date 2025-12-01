// planner.js
// Optional: Chains multi-step instructions like "Open grades then read page"

import { detectIntent } from "./intent.js";
import { runAction } from "./actions.js";

export async function planAndExecute(command) {
	const steps = command
		.split(/\bthen\b|\band\b/i)
		.map((s) => s.trim())
		.filter(Boolean);
	const results = [];

	for (const step of steps) {
		const { intent } = await detectIntent(step);
		const result = await runAction(intent);
		results.push({ step, intent, result });
	}
	return results;
}
