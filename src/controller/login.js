import { textToSpeech } from "../model/tts.js";

function onLoginPage() {
	const path = window.location.pathname;
	return path.includes("/login") || path.includes("/login/") || path.includes("/login?") || path.includes("/login#");
}

async function useLoginGPT(transcript) {
	const response = await fetch("https://glacial-sea-18791-40c840bc91e9.herokuapp.com/api/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			transcript,
		}),
	});
	const data = await response.json();

	return data;
}

function insertLoginDetails(userDetails, recognitionState) {
	if (!userDetails) return;

	const usernameField = document.querySelector("#pseudonym_session_unique_id");
	const passwordField = document.querySelector("#pseudonym_session_password");

	if (usernameField && userDetails.username) {
		usernameField.value = userDetails.username;
	}

	if (passwordField && userDetails.password) {
		passwordField.value = userDetails.password;
	}

	if (userDetails.username && userDetails.password) {
		textToSpeech("Your username and password has been entered", recognitionState);
	} else if (userDetails.username) {
		textToSpeech("Your username has been entered", recognitionState);
	} else if (userDetails.password) {
		textToSpeech("Your password has been entered", recognitionState);
	} else {
		textToSpeech("I couldn't find any login credentials in what you said", recognitionState);
	}
}

async function loginPageAction(transcript, recognitionState) {
	if (!onLoginPage()) return false;

	const response = await useLoginGPT(transcript);
	console.log(response);
	if (!response) return false;

	if (response === "submit") {
		const loginButton = document.querySelector(".Button--login");
		if (loginButton) {
			loginButton.click();
			sessionStorage.setItem(
				"canvoxNavigation",
				JSON.stringify({
					message: "Successfully logged in to your account. You are now on the Canvas dashboard.",
					timestamp: Date.now(),
				}),
			);
		}
	} else if (response === "persist") {
		const rememberMeCheckbox = document.querySelector("#pseudonym_session_remember_me");
		if (rememberMeCheckbox) {
			rememberMeCheckbox.checked = !rememberMeCheckbox.checked;
			textToSpeech("Toggled stay signed in checkbox", recognitionState);
		}
	} else if (response.username || response.password) {
		insertLoginDetails(response, recognitionState);
	} else {
		return false;
	}

	return true;
}

export { loginPageAction, onLoginPage };
