# AccessGen

Inline accessibility linter for HTML, JSX, TSX, and CSS in VS Code. AccessGen highlights accessibility violations directly in the editor with precise line-level decorations, detailed hover tooltips, and diagnostics in the Problems panel.

## Installation

1. Clone or copy this extension into a folder.
2. Run `npm install` in the extension root to install dependencies.
3. Open the folder in VS Code or Cursor.
4. Press `F5` to launch the Extension Development Host.
5. Open any HTML, JSX, TSX, or CSS file to see AccessGen in action.

## Usage

### Toggle On/Off

- **Keyboard shortcut:** `Ctrl+Shift+A` (Windows/Linux) or `Cmd+Shift+A` (macOS)
- **Command Palette:** Open with `Ctrl+Shift+P` and type `AccessGen: Toggle On/Off`
- **Status bar:** Click the AccessGen status bar item at the bottom left
- **Context menu:** Right-click in the editor and select `AccessGen: Toggle On/Off`

### Status Bar

The status bar item shows the current state:
- **AccessGen ON** — Extension is active with no issues found
- **AccessGen [N]** — Extension is active with N issues in the current file
- **AccessGen OFF** — Extension is disabled

### Hover Tooltips

Hover over any highlighted code to see a detailed tooltip with:
- What is wrong
- Why it affects users
- How to fix it
- The relevant WCAG reference

### Problems Panel

All violations also appear in the VS Code Problems panel (`Ctrl+Shift+M`) with the source label "AccessGen".

## Configuration

### accessgen.config.json

Place an `accessgen.config.json` file in your workspace root for project-level configuration:

```json
{
  "complianceLevel": "AA",
  "trustedComponents": ["Button", "Modal", "Input", "Icon", "FormField", "Link"],
  "disabledRules": [],
  "languages": ["html", "jsx", "tsx", "css"]
}
```

**Options:**
- `complianceLevel` — `"A"`, `"AA"`, or `"AAA"`. Controls which WCAG levels are checked. Default: `"AA"`.
- `trustedComponents` — Array of component names to skip during JSX analysis. Case-sensitive.
- `disabledRules` — Array of rule ID strings to disable.
- `languages` — Which languages to lint.

### VS Code Settings

These settings are available in VS Code's `settings.json` under the `accessgen` namespace:

| Setting | Type | Default | Description |
|---|---|---|---|
| `accessgen.enabled` | boolean | `true` | Enable or disable the extension |
| `accessgen.complianceLevel` | `"A"` / `"AA"` / `"AAA"` | `"AA"` | WCAG compliance level |
| `accessgen.showTooltips` | boolean | `true` | Show hover tooltips |
| `accessgen.debounceMs` | number | `800` | Debounce delay before analysis |
| `accessgen.stateScope` | `"global"` / `"workspace"` | `"global"` | Scope for enabled state |
| `accessgen.trustedComponents` | string[] | `[]` | Trusted component names |
| `accessgen.aiReviewMode` | `"off"` / `"manual"` / `"auto"` | `"off"` | When to send content for AI review. See [AI Review and Data Sent to Third Parties](#ai-review-and-data-sent-to-third-parties) |
| `accessgen.aiProvider` | `"openai"` / `"anthropic"` | `"openai"` | Which provider performs AI review |
| `accessgen.aiModel` | string | `""` | Model to use; empty means the provider default (`gpt-4o-mini` / `claude-haiku-5-5`). Must belong to the selected provider |
| `accessgen.remediationMode` | `"manual"` / `"hybrid"` / `"auto"` | `"manual"` | Who applies fixes. See [Remediation Modes](#remediation-modes) |
| `accessgen.aiReviewDebounceMs` | number | `3000` | Quiet time before AI review runs in `auto` mode (the structural scan still uses `debounceMs`) |

### Trusted Components

Trusted components are JSX component names that AccessGen skips during analysis. This is useful for design system components that already handle accessibility internally.

Component names are case-sensitive: `"Button"` and `"button"` are different.

Add trusted components in `accessgen.config.json`:

```json
{
  "trustedComponents": ["Button", "Modal", "Input"]
}
```

Or in VS Code settings:

```json
{
  "accessgen.trustedComponents": ["Button", "Modal", "Input"]
}
```

## Remediation Modes

`accessgen.remediationMode` controls which fixes are **proposed** to you without a click. **Nothing is ever applied without your explicit Accept**, in any mode. The default is `manual`, which is also what you get if the setting is missing or invalid.

| Mode | What happens |
|---|---|
| `manual` | Fixes are offered as quick fixes (the lightbulb) and nothing is proposed automatically. Selecting a deterministic quick fix applies it; an AI quick fix is requested only when you select it (see [AI-suggested fixes](#ai-suggested-fixes)). |
| `hybrid` | Fixes tagged `safe` are proposed inline right after a scan finds them. `medium` and AI-written fixes are still only offered as quick fixes. |
| `auto` | Fixes tagged `safe` or `medium` are both proposed inline. AI-written fixes are also requested proactively, but only while AI features are on and only through the same cost controls and consent as AI review (see [AI-suggested fixes](#ai-suggested-fixes)). |

### Reviewing a proposed fix

A proposed fix is shown **inline in the editor**: the old text is struck through with a reddish tint, the suggested new text appears right after it with a greenish tint, and two actions appear above the line:

- **✓ Accept fix** applies exactly that edit (one undo step per fix).
- **✗ Dismiss** discards it without changing the file. A dismissed fix is not proposed again unless you change that code (an edited violation is a new suggestion).

A pending proposal is not recomputed or redrawn by later scans. It disappears if the violation goes away (for example you fixed it by hand), if you switch `remediationMode` to `manual`, or if AccessGen is turned off. If the text under a proposal changed before you clicked Accept, nothing is applied and the next scan proposes it afresh.

Whether a fix may ever run without a click is decided **per rule**, never by the mode alone. A rule that provides a fix declares a `fixTier`: `safe` (additive, no behaviour change, a straight value swap) or `medium` (adds behaviour, so a human would normally choose between options). **A fix with no `fixTier` is never proposed automatically, in any mode.** A third tier, `ai-suggested`, is used by fixes written by an AI provider (see [AI-suggested fixes](#ai-suggested-fixes)): it costs a request, so it is proposed proactively only in `auto` mode, and is otherwise a quick fix you select.

Currently `outline-removed` is the only rule with a fix, and it is tagged `safe` because the fix is computed, not guessed. When the same rule block has a literal `background-color` (a `#hex`, `rgb()` or one of the basic named colors), the removed outline is replaced with `outline: 2px solid #000000` or `#ffffff`, whichever has at least 3:1 contrast against that background (the WCAG minimum for non-text UI components), together with `outline-offset: -2px`. The negative offset draws the ring just inside the element's edge, over the element's own box, instead of outside it, so the page behind the element does not affect the contrast. If the block has no `background-color`, or it cannot be evaluated (`var()`, `currentColor`, `transparent`, other named colors, gradients), or the same block shows the ring would be drawn over something other than that color (a `background` shorthand or a background image, or a border at least as thick as the 2px ring), no fix is offered at all and the hover on the violation explains why.

What the check cannot see: rules elsewhere in the stylesheet that style the same element's border or background. Also, because the ring covers the outer 2px of the element's box, an element with no padding (typically an unpadded inline text link) can have its first and last letters touched by the ring; for those, a hand-written focus style may look better.

Safeguards:

- It only touches the document you have open and just analysed, never the whole workspace.
- It waits for the normal `accessgen.debounceMs` pause: nothing is proposed while you are typing or if the text changed since the scan.
- Each accepted fix is its own edit, so one undo reverts one fix.
- Each accepted or dismissed instance is proposed at most once per session, so if you undo an accepted fix it is not proposed again.
- If a rescan still reports the same violation after you accepted a fix, the fix did not work: it is marked "auto-fix-failed, manual review needed", logged once, and not proposed again. The quick fix remains available.
- Every proposal, Accept and Dismiss appears in the **AccessGen Auto-fix** output channel, and an Accept also as a brief status bar message. This is in-session only; nothing is saved or sent anywhere.

## AI Review and Data Sent to Third Parties

AccessGen's rules are deterministic and run entirely on your machine. **AI review is optional, off by default, and the only feature that sends anything off your machine.**

Some accessibility problems cannot be decided by logic: alt text that exists but may not describe the image, link text that is present but vague, a heading that may not be descriptive. With AI review enabled, AccessGen sends those short pieces of text to the AI provider you choose (OpenAI or Anthropic) and shows the verdict, a confidence score and a short reason in the **AccessGen AI Review** output channel.

### What leaves the machine

Only the text of elements that already passed the deterministic checks and look ambiguous, plus the minimal context listed here. Nothing else from the file is sent.

| Element | What is sent | What is never sent |
|---|---|---|
| Alt text | the alt text, the `<figcaption>` of its enclosing `<figure>` (if any), and the text of the nearest preceding heading | file path, source code, line numbers, rule IDs, your API key |
| Link text | the link text and the link's `href` with the query string and any credentials removed (`javascript:` links are dropped and `mailto:` / `tel:` are reduced to the bare scheme) | the same as above |
| Heading text | the heading text and its level (1–6) | the same as above |
| AI-suggested alt text (a quick fix you select) | the image's file name (the base name only, no folders), the `<figcaption>`, the nearest preceding heading, and a short snippet of nearby text (about 200 characters around the image) | the same as above |
| AI-suggested link text (a quick fix you select) | the link's `href` (sanitised as above), the current link text if it has any, and a short snippet of nearby text (about 200 characters around the link) | the same as above |

| Generic AI fix (**Suggest fix**, any rule without its own fix) | **source code**: the flagged range, the code around it (the enclosing element, JSX element or CSS rule, or, when that is too large, a few surrounding lines, at most about 1,200 characters), and the rule's own description of the problem and its WCAG criterion | the same as above |

Elements that already fail a rule (missing alt, empty link, empty heading) are not sent for AI *review*; they are reported by the normal checks. (They are what an AI *fix* is asked about, with the data listed above.) Very descriptive text (for example, a long sentence-like alt text) is filtered out locally and not sent either.

Sending is subject to the provider's own terms and data policy. Do not enable AI review for files whose alt text, link text, link destinations or headings must not leave your machine.

### Turning it on

1. Set `accessgen.aiReviewMode` to `"manual"` (review only when you run **AccessGen: Review with AI**) or `"auto"` (also review new or changed content after each scan, once you stop typing for `accessgen.aiReviewDebounceMs`).
2. Choose `accessgen.aiProvider` (and optionally `accessgen.aiModel`).
3. Run **AccessGen: Set AI API Key**.

The first time you either switch `accessgen.aiReviewMode` away from `"off"` or run **AccessGen: Set AI API Key**, AccessGen shows a one-time notice summarising the table above, with a **Learn more** button that opens this section. You will not see it again once dismissed, unless the wording changes in a later version of AccessGen (for example to cover new data that is sent): the acknowledgement is versioned, and you are asked once more, before the next request is sent, whenever the version you acknowledged is older than the current one.

Separately, nothing is ever sent before you have acknowledged this at least once. The first time a request is actually about to be sent, and only if you have not already dismissed the notice above, AccessGen shows a modal dialog with the same text and **OK** / **Cancel**. **OK** sends that batch and the dialog does not appear again (until the disclosure wording changes, as above). **Cancel** sends nothing and switches `accessgen.aiReviewMode` back to `"off"` (in your settings, and in `accessgen.config.json` if that is where it was enabled), so nothing is sent until you turn it on again. This applies to both **AccessGen: Review with AI** and `auto` mode.

### AI-suggested fixes

For missing alt text (`img-alt-missing`, `jsx-img-alt-missing`) and empty or generic link text (`anchor-no-text`, `jsx-anchor-no-content`), the Quick Fix menu can also offer **AccessGen (AI): Suggest alt text** and **AccessGen (AI): Suggest link text**. They are titled differently from deterministic fixes (such as `outline-removed`) on purpose, and they behave differently:

- They appear only while `accessgen.aiReviewMode` is `"manual"` or `"auto"`.
- **Opening the Quick Fix menu sends nothing.** A request is made only when you select that specific action. VS Code then shows the proposed change as a preview (a diff) that you accept or discard, with the model's confidence and reasoning next to it.
- They use the same API key, provider and model settings, and the same one-time disclosure dialog, as AI review. With no key set you get the same message telling you to run **AccessGen: Set AI API Key**.
- A suggestion is cached per element, so reopening the same quick fix does not call the API again. Changing the surrounding text, the model or the provider does.
- Their tier is `ai-suggested`: **never applied without Accept, in any `remediationMode`**. In `manual` and `hybrid` they are only ever a quick fix you select.
- In `auto` mode they are also requested proactively (while `accessgen.aiReviewMode` is `"manual"` or `"auto"`, never `"off"`) and shown as inline diffs to Accept or Dismiss. This goes through the same cost controls as AI review: it waits for `accessgen.aiReviewDebounceMs` of quiet, an element is requested once and not again until its code changes, at most 25 are requested per run (the rest on the next scan), and an unchanged or dismissed element is never requested again. It uses the same consent gates: with no key you get the same warning (once per session, not on every scan), and the first request ever shows the same blocking dialog. Failures and low-confidence answers are logged to the AccessGen AI Review channel instead of interrupting you.
- If the file name and surrounding text give the model nothing to go on (for example `IMG_1234.jpg` with no caption), it is told to say so rather than invent a description, and AccessGen shows a one-line "not enough context" message instead of an edit.
- A failed request (network, rate limit, an unusable reply) shows a one-line error and changes nothing.

What the edit is: alt text is added as `alt="..."`. For a link with no visible text (empty, or only an icon) an `aria-label` is added, so nothing visible changes. For a generic phrase such as "click here", or a bare URL, the link text is replaced. Links with mixed content, an existing `aria-label`, or spread props are not offered a suggestion, and neither are empty headings.

### Generic AI fix for any other rule

Every rule that has no fix of its own (all of them except `outline-removed` and the four alt-text / link-text rules above) can offer **AccessGen (AI): Suggest fix** in the Quick Fix menu. It works the same way as the other AI fixes: opening the menu sends nothing, a request is made only when you select it, VS Code previews the change, and the same key, provider, model, disclosure dialog and cache apply. It is never offered next to a fix the rule already has.

- The model is shown the rule's own description of the problem, the WCAG criterion, the flagged code and its surroundings, and is asked to rewrite **only the flagged range**. If it cannot do that safely with what it was shown (for example `duplicate-id`, which needs both elements, or `table-missing-headers`, which needs the other cells) it is told to say so, and you get a "not enough context" line instead of an edit.
- A suggestion is checked locally before you see it: it must differ from the existing code, leave the file parseable, and make the rule report fewer violations when its own check is run on the edited text. One that fails any of these is not offered.
- It sends **source code**. Unlike AI review, this includes the flagged code and the code around it, so do not enable AI features for files that must not leave your machine. The disclosure was updated for this, so everyone who accepted the earlier wording is asked again before the next request.
- In `remediationMode` `auto` these fixes are also requested proactively and shown as inline diffs, through exactly the cost controls and consent gates described under [AI-suggested fixes](#ai-suggested-fixes) (the debounce, at most 25 requests per run, one request per unchanged element). Their tier is `ai-suggested`: **never applied without Accept**, in any mode.

### Your API key

The key is stored in VS Code's secret storage, never in `settings.json`, `accessgen.config.json` or the repository, and it is never logged or displayed back. Keys are stored separately per provider.

- **AccessGen: Set AI API Key** stores the key for the selected provider.
- **AccessGen: Clear AI API Key** removes the key for OpenAI, Anthropic or both.

### Cost and limits

Each judged element is one API request, billed by your provider. To keep this predictable, AccessGen only requests a verdict for content that is new or changed since it was last judged, reuses the stored verdict otherwise (until you change provider or model), waits for `accessgen.aiReviewDebounceMs` of quiet in `auto` mode, and makes at most 25 requests per review run. Failed requests are not stored and are retried on the next review.

## Rules

AccessGen includes 27 accessibility rules across HTML, JSX, and CSS.

### HTML Rules (15)

| Rule ID | Severity | WCAG | Description |
|---|---|---|---|
| `img-alt-missing` | Critical | 1.1.1 (A) | Images must have an alt attribute |
| `input-label-missing` | Critical | 1.3.1 (A) | Input fields must have an associated label |
| `button-empty` | Critical | 4.1.2 (A) | Buttons must have an accessible name |
| `anchor-no-text` | Critical | 2.4.4 (A) | Links must have descriptive text |
| `heading-hierarchy-skip` | Warning | 1.3.1 (A) | Heading levels must not skip (e.g., h1 to h3) |
| `div-used-as-button` | Warning | 4.1.2 (A) | Divs/spans with onclick need role and tabindex |
| `form-missing-landmark` | Warning | 1.3.1 (A) | Forms must have an accessible name |
| `select-no-label` | Critical | 1.3.1 (A) | Select dropdowns must have a label |
| `table-missing-headers` | Warning | 1.3.1 (A) | Tables must have th elements with scope |
| `iframe-missing-title` | Critical | 4.1.2 (A) | Iframes must have a title attribute |
| `html-missing-lang` | Critical | 3.1.1 (A) | The html element must have a lang attribute |
| `duplicate-id` | Critical | 4.1.1 (A) | Element IDs must be unique |
| `positive-tabindex` | Warning | 2.4.3 (A) | Positive tabindex values disrupt tab order |
| `autofocus-used` | Advisory | 3.2.1 (A) | Autofocus can disorient screen reader users |
| `media-missing-captions` | Critical | 1.2.2 (A) | Video/audio must have a captions track |

### JSX Rules (8)

| Rule ID | Severity | WCAG | Description |
|---|---|---|---|
| `jsx-img-alt-missing` | Critical | 1.1.1 (A) | JSX img elements must have an alt prop |
| `jsx-onclick-no-keyboard` | Critical | 2.1.1 (A) | onClick must have a keyboard handler |
| `jsx-interactive-no-role` | Warning | 4.1.2 (A) | Interactive non-semantic elements need a role |
| `jsx-anchor-no-content` | Critical | 2.4.4 (A) | Anchors must have content or aria-label |
| `jsx-label-missing` | Critical | 1.3.1 (A) | Form elements must have labels |
| `jsx-aria-invalid-role` | Warning | 4.1.2 (A) | ARIA role values must be valid |
| `jsx-mouse-events-no-focus` | Warning | 2.1.1 (A) | Mouse events need focus/blur equivalents |
| `jsx-heading-empty` | Critical | 2.4.6 (AA) | Heading elements must not be empty |

### CSS Rules (4)

| Rule ID | Severity | WCAG | Description |
|---|---|---|---|
| `outline-removed` | Critical | 2.4.7 (AA) | Focus outlines must not be removed without replacement |
| `color-contrast-low` | Warning | 1.4.3 (AA) | Text must meet 4.5:1 contrast ratio |
| `motion-no-preference-check` | Advisory | 2.3.3 (AAA) | Animations need prefers-reduced-motion query |
| `focus-visible-missing` | Warning | 2.4.7 (AA) | :focus rules should have :focus-visible equivalents |

## Compliance Levels

- **Level A** — Runs only Level A rules (20 rules)
- **Level AA** — Runs Level A and AA rules (24 rules). This is the default.
- **Level AAA** — Runs all rules including AAA (27 rules)

## Dependencies

- [parse5](https://www.npmjs.com/package/parse5) — HTML parsing
- [@babel/parser](https://www.npmjs.com/package/@babel/parser) — JSX/TSX parsing
- [postcss](https://www.npmjs.com/package/postcss) — CSS parsing

## License

MIT
