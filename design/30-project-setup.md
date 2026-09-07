# Project setup

## Goal

Give work a folder, then let the user start a conversation. Setup must not start an agent.

## Flow

- **Create new project:** name, existing parent folder, resulting path, optional Git history.
- **Add existing folder:** exact path or keyboard-accessible folder browser. No changes inside the folder.
- Keep both choices in one dialog. Switching keeps entered values.
- Show the active action as **Create project** or **Add project**.
- After success, open the project page. Empty projects offer **Start conversation**.
- Edit the lasting purpose separately on the project page. Purpose is optional and editable.

## Safety and access

- New projects cannot silently reuse an existing folder.
- Existing folder names keep spaces and Unicode characters.
- Require absolute paths or `~/` paths. General and temporary folders are not project identities.
- Keep form entries after errors. Report a saved folder separately from a failed registration or Git setup.
- Compare purpose text with its loaded version before saving. Save by replacement, not an in-place partial write.
- Keep the dialog open during save. Disable repeat submission.
- Trap keyboard focus, make the background inert, support Escape, and restore trigger focus.
- An outside click does not discard the form.
- Use readable labels and 44-pixel button targets. The dialog body scrolls on short screens; action buttons remain outside it.
- Use theme tokens, native controls, and visible focus. No new dependencies.

## API

`POST /api/project/create`

- `{operation: 'create', name, parent, git}`
- `{operation: 'add', path}`

`GET /api/project/setup` returns `{version: 1}`. The form checks this before any setup write, so an older server cannot apply legacy behavior.

Explicit operations ignore legacy intent and first-prompt fields. Return the saved project, exact folder path, and any Git warning.

`GET /api/project/purpose?project=...` returns current text.

`POST /api/project/purpose {project, intent, baseText}` checks the loaded text, saves, and records the user's review. Empty text clears the purpose. A review-ledger failure returns a warning after saving.

## Trade-offs

- Starting a conversation takes a separate action. Setup cannot accidentally launch paid work.
- Larger controls show fewer folders at once. They improve touch and keyboard use.
- Keep Git enabled for new projects to preserve the existing default. Show that default in the collapsed settings label.
- Keep legacy API calls compatible. Existing clients without `operation` still use the older combined behavior.
- Small synchronous filesystem operations prevent competing app registrations from interleaving. Slow disks can briefly delay the server.
- Purpose conflict checks protect against changes already on disk. External writers do not share a transaction with this editor.
- Removing a registered empty project keeps its folder. This is not a general hide-project feature.
- Keep the existing project identity rules. Two folders that map to the same project cannot be registered separately.

## Checks and deployment

Run:

```
node --check server.js
node --test test/project-create.test.js test/project-setup-ui.test.js test/projectfolds.test.js test/run-card-visibility.test.js
```

The UI test runs extracted production dialog code in an isolated headless Chromium profile, with production styles and mocked requests at a phone-sized viewport. It does not create real projects or launch agents. Set `CHROMIUM` if the binary has another name.

Deploy matching server and frontend code together. Wait for active conversations to finish before restarting the service. Reload the app afterward. These tests do not replace a full live-app integration check or user testing.
