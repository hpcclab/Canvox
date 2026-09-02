# Canvox — New Team Quick Notes

Welcome to the Canvox project!

These notes are meant to give new team members a quick understanding of the project before they begin working with the code.

You do **not** need to understand the entire repository before contributing.

---

# 1. What Is Canvox?

Canvox is a **Chrome extension for Canvas** that allows users to interact with Canvas using voice or typed commands.

For example, a user may say or type:

- "Open my assignments"
- "Show my grades"
- "Read this page"
- "What is due?"
- "Open my inbox"

Canvox figures out what the user wants and then performs the requested action on Canvas.

The project is mainly focused on making Canvas easier to use through:

- Voice commands
- Spoken feedback
- Page reading
- Easier navigation
- Accessibility support

One important goal of Canvox is helping blind and visually impaired Canvas users, although the voice interface can also be useful for anyone who prefers hands-free interaction.

---

# 2. The Main Idea

Canvox basically works in four steps:

```text
1. User speaks or types a command
              ↓
2. Canvox figures out what the command means
              ↓
3. Canvox performs the action on Canvas
              ↓
4. Canvox gives the user feedback
```

In the current code, this roughly looks like:

```text
User Command
     ↓
content_test.js
     ↓
lib/actions.js
     ↓
lib/intent.js
     ↓
Canvas
     ↓
Navigation / Page Action / Spoken Response
```

This is the main idea behind the project.

---

# 3. How Canvox Works

## Step 1 — The User Gives a Command

The user can type or speak a command.

For example:

```text
Open my assignments
```

The main active file handling this interaction is:

```text
content_test.js
```

This file creates the current testing interface that appears on the webpage.

It can accept:

- Typed commands
- Microphone input
- Keyboard shortcuts

---

## Step 2 — Canvox Understands the Command

The command is passed into the Canvox command system.

Two very important files are:

```text
lib/actions.js
lib/intent.js
```

### `lib/intent.js`

This file performs **intent detection**.

An **intent** simply means:

> What does the user want Canvox to do?

For example:

```text
"Open my assignments"
```

could be recognized as an action related to opening assignments.

Different intents represent actions such as:

- Opening Canvas pages
- Reading a page
- Checking due dates
- Opening the inbox
- Creating messages
- Getting help

The current intent system mainly uses rules and pattern matching.

---

## Step 3 — Canvox Performs the Action

Once Canvox understands the command, the action is handled mainly by:

```text
lib/actions.js
```

This file contains much of the project's command behavior.

Depending on the command, Canvox may:

- Open another Canvas page
- Click a button
- Read information from the webpage
- Get assignment or to-do information
- Start a guided command
- Speak information back to the user

`lib/actions.js` is one of the most important files in the project.

---

## Step 4 — Canvox Gives Feedback

After performing an action, Canvox may respond through:

- Spoken audio
- Browser navigation
- Clicking something on Canvas
- Text shown in the testing interface

For example, if the user asks Canvox to open assignments, Canvox may navigate directly to the assignments page.

If the user asks Canvox to read information, Canvox may speak that information back to the user.

---

# 4. The Four Most Important Files

New team members should start by becoming familiar with these four files.

| File              | What it does                                        |
| ----------------- | --------------------------------------------------- |
| `manifest.json`   | Tells Chrome how the Canvox extension is configured |
| `content_test.js` | Receives typed or spoken commands from the user     |
| `lib/intent.js`   | Figures out what the user wants                     |
| `lib/actions.js`  | Performs the requested Canvas action                |

You do not need to understand every file in the repository before contributing.

These four files give you the best starting point.

---

# 5. Important Project Files and Folders

## `README.md`

This is the main project introduction.

It explains things such as:

- What Canvox is
- The project's goals
- Basic features
- How to load the extension in Chrome

---

## `manifest.json`

Every Chrome extension has a manifest file.

For Canvox, that file is:

```text
manifest.json
```

It tells Chrome things such as:

- Which files should run
- What permissions Canvox needs
- Which background code should run
- Which scripts should be added to webpages

The current manifest loads:

```text
content_test.js
```

as the main content script.

---

## `content_test.js`

This is currently the main connection between the user and the Canvox command system.

It creates the testing interface and handles things such as:

- Typed commands
- Microphone commands
- Command transcripts
- Keyboard shortcuts
- Sending commands into the Canvox action system

---

## `lib/`

This is currently one of the most important folders in Canvox.

It contains much of the newer command system.

Important files include:

```text
lib/actions.js
lib/intent.js
lib/canvas_api.js
lib/page_text.js
lib/page_summarize.js
lib/snapshot.js
```

### `lib/actions.js`

Contains much of the logic for performing commands.

### `lib/intent.js`

Figures out what the user's command means.

### `lib/canvas_api.js`

Helps Canvox retrieve information from Canvas.

### `lib/page_text.js`

Helps extract useful text from the current Canvas page.

### `lib/page_summarize.js`

Helps create shorter summaries of page content.

### `lib/snapshot.js`

Helps collect useful information from the current Canvas page.

---

## `background.js`

This file runs behind the scenes as part of the Chrome extension.

It helps with things such as:

- Initial settings
- Extension messages
- Navigation-related tasks
- Opening extension options

---

## `src/`

You will also see another major folder called:

```text
src/
```

It contains code related to:

- Controllers
- Speech
- Settings
- Reading tools
- Navigation
- Other earlier Canvox features

Some of this appears to belong to an older version of the project.

The current main path uses:

```text
content_test.js
        ↓
lib/
```

more directly.

Because of that, do not assume every file inside `src/` is currently being used.

---

## `audios/`

Contains audio files used for feedback, such as microphone or loading sounds.

---

## `images/icons/`

Contains icons and other image assets used by the extension.

---

# 6. Current Features

The current repository contains support for features such as:

- Typed commands
- Voice commands
- Canvas navigation
- Assignment-related commands
- Grade navigation
- Inbox commands
- Page reading
- Page summaries
- Due-date queries
- Canvas planner and to-do information
- Spoken responses
- Chained commands

A chained command means that Canvox can handle multiple related actions from a longer request.

For example, a user may ask Canvox to navigate somewhere and then perform another action.

Some features are more complete than others because Canvox is still being actively developed.

---

# 7. How to Run Canvox

Canvox currently runs as an **unpacked Chrome extension**.

## Step 1

Open Google Chrome.

## Step 2

Go to:

```text
chrome://extensions/
```

## Step 3

Turn on:

```text
Developer mode
```

## Step 4

Click:

```text
Load unpacked
```

## Step 5

Select the Canvox project folder.

For the current development setup:

```text
/Users/vedanshtembhre/Canvox
```

## Step 6

Open Canvas in Chrome.

If the extension loads correctly, the current Canvox testing interface should appear.

If you make changes to the extension code, you may need to reload the extension from:

```text
chrome://extensions/
```

and then refresh Canvas.

---

# 8. Before You Commit Changes

Before committing code, always check which files you changed.

Run:

```bash
git status --short
```

This shows the files that are currently modified, added, or deleted.

You can also inspect your actual changes using:

```bash
git diff
```

Before committing:

- Make sure you understand every file you changed.
- Make sure the extension still loads.
- Test the feature you worked on.
- Check for obvious errors.
- Do not commit passwords, API keys, tokens, or other private information.
- Avoid changing unrelated files.

Keep changes small and focused whenever possible.

This makes the code easier for everyone on the team to understand, test, and review.
