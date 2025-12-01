// memory.js
// Simple wrapper for remembering state across utterances

export class Memory {
	constructor(namespace = "convox_mem") {
		this.ns = namespace;
	}

	async get() {
		const data = await chrome.storage.local.get(this.ns);
		return data[this.ns] || {};
	}

	async set(patch) {
		const current = await this.get();
		const updated = { ...current, ...patch };
		await chrome.storage.local.set({ [this.ns]: updated });
		return updated;
	}

	async clear() {
		await chrome.storage.local.remove(this.ns);
	}
}
