(async () => {
	const src = chrome.runtime.getURL("src/controller/main.js");
	const contentScript = await import(src);
	contentScript.main();
})();
