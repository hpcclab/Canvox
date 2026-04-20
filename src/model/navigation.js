import { textToSpeech } from "./tts.js";

function navigate(destination) {
	//select all links in the layout wrapper
	const layoutWrapper = document.querySelector(".ic-Layout-wrapper");
	const links = layoutWrapper ? layoutWrapper.querySelectorAll("a") : [];

	//search for the appropriate link and navigate
	for (const link of links) {
		if (
			link.textContent.toLowerCase().includes(destination) ||
			(link.title && link.title.toLowerCase().includes(destination))
		) {
			// Store the confirmation message in sessionStorage for audio confirmation
			sessionStorage.setItem(
				"canvoxNavigation",
				JSON.stringify({
					message: `Opened ${destination}`,
					timestamp: Date.now(),
				}),
			);

			// Then navigate
			link.click();
			return true;
		}

		for (const child of link.children) {
			if (
				child.textContent.toLowerCase().includes(destination) ||
				(child.title && child.title.toLowerCase().includes(destination))
			) {
				// Store the confirmation message in sessionStorage for audio confirmation
				sessionStorage.setItem(
					"canvoxNavigation",
					JSON.stringify({
						message: `Opened ${destination}`,
						timestamp: Date.now(),
					}),
				);

				// Then navigate
				link.click();
				return true;
			}
		}
	}

	// No matching link found
	return false;
}

// This function collects all unique link texts from the page, removing duplicates and substrings. It basically extracts all the possible navigation destinations for chatGPT to consider when interpreting the user's command. It excludes links from the right-side-wrapper to avoid cluttering the results with irrelevant links.
function collectUniqueDestinations() {
	const layoutWrapper = document.querySelector(".ic-Layout-wrapper");
	if (!layoutWrapper) return [];

	// Exclude the right-side-wrapper and its children
	const rightSideWrapper = layoutWrapper.querySelector("#right-side-wrapper");

	// Get all links except those in the right-side-wrapper
	const links = [];
	const allLinks = layoutWrapper.querySelectorAll("a");

	for (const link of allLinks) {
		// Check if the link is a descendant of right-side-wrapper
		if (rightSideWrapper && rightSideWrapper.contains(link)) {
			continue; // Skip links inside right-side-wrapper
		}
		links.push(link);
	}

	// Collect all possible link texts
	const allTexts = [];
	for (const link of links) {
		if (link.textContent.trim()) {
			allTexts.push(link.textContent.trim().toLowerCase());
		}
		if (link.title && link.title.trim()) {
			allTexts.push(link.title.trim().toLowerCase());
		}

		// Check children elements of the link
		for (const child of link.children) {
			if (child.textContent.trim()) {
				allTexts.push(child.textContent.trim().toLowerCase());
			}
			if (child.title && child.title.trim()) {
				allTexts.push(child.title.trim().toLowerCase());
			}
		}
	}

	// Remove duplicates first by using Set
	const uniqueTexts = [...new Set(allTexts)];

	// Remove substrings (if text is contained within another)
	const filteredTexts = [];

	for (let i = 0; i < uniqueTexts.length; i++) {
		let isSubstring = false;
		for (let j = 0; j < uniqueTexts.length; j++) {
			// Skip self-comparison
			if (i === j) continue;

			// Check if uniqueTexts[i] is a substring of uniqueTexts[j]
			if (uniqueTexts[j].includes(uniqueTexts[i]) && uniqueTexts[i].length < uniqueTexts[j].length) {
				isSubstring = true;
				break;
			}
		}

		// Only add if not a substring of another element
		if (!isSubstring && uniqueTexts[i].length > 2) {
			// Ignore very short strings (likely not useful)
			filteredTexts.push(uniqueTexts[i]);
		}
	}

	return filteredTexts;
}

function readPossibleOptions() {
	// Get all possible destinations
	const currentURL = new URL(window.location.href);
	const possibleDestinations = collectUniqueDestinations();
	var message;
	var terms = [];
	var options = [];

	var links = ["by instructure", "privacy policy", "cookie notice", "acceptable use policy", "facebook", "x.com"];

	if (currentURL.pathname.includes("courses")) {
		for (var term of possibleDestinations) {
			// Read each destination using text-to-speech
			if (term.includes(".")) {
				// skip terms that include periods
				continue;
			} else {
				terms.push(term);
			}
		}

		if (terms.length > 25) {
			// If there are too many terms, limit the number of terms to read
			terms = terms.slice(0, 25);
		}

		message =
			"You are in the " +
			terms[1] +
			" course. You can navigate to the following sections: " +
			terms.slice(2).join(", ") +
			". All sidebar options are also available.";
	} else if (currentURL.pathname == "/" || currentURL.pathname == "") {
		for (let term of possibleDestinations) {
			// Read each destination using text-to-speech
			if (term.includes(".")) {
				terms.push(term);
			}
		}

		for (let term of terms) {
			innerloop: for (let i = 0; i < term.length; i++) {
				if (term[i] == ".") {
					options.push(term.substring(0, i - 9));
					break innerloop;
				}
			}
		}

		message =
			"You can navigate to the following sections: " +
			options.join(", ") +
			". You can also navigate to announcements, assignments, discussions, and files for all classes. You can navigate to these links: " +
			links.join(", ") +
			", All sidebar options are also available.";
	} else {
		for (var term of possibleDestinations) {
			terms.push(term);
		}

		message =
			"You can navigate to the following sections: " + terms.join(", ") + ". All sidebar options are also available.";
	}

	textToSpeech(message);
}

export { navigate, collectUniqueDestinations, readPossibleOptions };
