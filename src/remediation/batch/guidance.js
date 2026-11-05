// Expert remediation guidance per rule, sent with each issue in a batch remediation request.
//
// The linter's own message says WHAT is wrong; this says HOW an accessibility engineer fixes it correctly:
// the preferred pattern, the traps that make a "fix" fail for real users, and the evidence the text content
// must come from. `region` picks how much code around the issue is sent ('element' = the flagged element,
// 'parent' = up to two enclosing elements, so nearby visible text and labels are visible, 'table' / 'form' =
// the whole enclosing table / form, 'rule' = the enclosing CSS rule).

const GUIDE = {
  'img-alt-missing': {
    region: 'parent',
    guidance: [
      'Add an alt attribute. Decide the image purpose first:',
      '- informative: describe the content the image conveys in context (not its appearance in general), concise (under ~120 characters), no "image of"/"picture of", no file name;',
      '- functional (inside a link or button with no other text): describe the action or destination, not the picture;',
      '- decorative or redundant with adjacent text (the same words appear next to it, or it is a spacer/flourish/background-like graphic): alt="";',
      '- complex (chart, diagram): short alt plus point the developer to a longer description in steps.',
      'Use the attached image when one is provided: describe what is actually visible that matters in this context. Otherwise use the file name, figcaption, surrounding text and heading only as evidence; if they do not establish what the image shows, ask (status "needs-input", alt="{{INPUT}}", question "What does this image show?").'
    ]
  },
  'jsx-img-alt-missing': { sameAs: 'img-alt-missing', extra: 'In JSX keep the prop style of the file (alt="..." or alt={...}). For a component such as next/image <Image>, alt is still required.' },
  'anchor-no-text': {
    region: 'parent',
    guidance: [
      'Give the link an accessible name that states its destination or purpose on its own (WCAG 2.4.4).',
      'Prefer visible text. For an icon-only link keep the icon, mark decorative icon elements aria-hidden="true" (an <svg> also focusable="false") and add aria-label on the <a>, or add visually hidden text if the project has an sr-only / visually-hidden utility (see facts).',
      'Derive the name from evidence: the href (domain, path words), icon class names (e.g. "fa-twitter" -> "Twitter"), an svg <title>, the surrounding text. Never use "click here", "read more", "link" or the raw URL. If nothing indicates the purpose, ask (aria-label="{{INPUT}}", question "Where does this link go?").',
      'If the link opens a new window (target="_blank"), mention it in the name, e.g. "Pricing (opens in new tab)".'
    ]
  },
  'jsx-anchor-no-content': { sameAs: 'anchor-no-text', extra: 'For router links (<Link>) the same applies. Keep JSX prop syntax (aria-hidden="true", focusable="false").' },
  'button-empty': {
    region: 'parent',
    guidance: [
      'Give the button an accessible name that says what it does (a verb phrase: "Close dialog", "Open menu", "Delete item").',
      'Icon-only button: keep the icon, add aria-label on the <button> (or visually hidden text when an sr-only utility exists), mark the icon aria-hidden="true".',
      'Infer the action from evidence: onclick handler names, icon class names, svg <title>, id/class names ("btn-close"), data attributes, surrounding text. Keep type="button" if present; add type="button" only if the button is inside a <form> and clearly is not a submit button.',
      'A submit button (type="submit", or no type inside a <form>) is named after what the form does: use the form fields and heading ("Subscribe", "Sign in", "Search", "Send message"), "Submit" at worst.',
      'Only if nothing at all indicates the action, ask (put {{INPUT}} as the button text, question "What does this button do?", with likely answers).'
    ]
  },
  'div-used-as-button': {
    region: 'element',
    guidance: [
      'Preferred: convert the element to a native <button type="button">, keeping every attribute (class, id, data-*, handlers) and the children. Change both the start and end tag. Add a CSS reset only as a step (do not edit stylesheets you cannot see).',
      'If it must stay a div/span (e.g. it contains block content or a button would break layout the code shows), add role="button", tabindex="0" and a keydown handler that activates on Enter and Space (Space must call preventDefault to stop scrolling).',
      'Never leave a role="button" without keyboard support.'
    ]
  },
  'jsx-onclick-no-keyboard': {
    region: 'element',
    guidance: [
      'Preferred: change the element to <button type="button"> (change opening AND closing tag), keeping className, handlers and children. A native button gives Enter/Space activation, focus and the button role for free; remove role="button"/tabIndex if they become redundant.',
      'If the element cannot become a button (it wraps block content, or it is a list item/row whose semantics matter), keep it and add: role="button" if missing, tabIndex={0} if missing, and onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); <same handler call>; } }}. Call the same handler the onClick calls with compatible arguments.',
      'For a link-like action that navigates, prefer <a href> or the router <Link>.',
      'Do not add a keyboard handler to an element that is already a native interactive element.'
    ]
  },
  'jsx-interactive-no-role': { sameAs: 'jsx-onclick-no-keyboard' },
  'jsx-mouse-events-no-focus': {
    region: 'element',
    guidance: [
      'Pair onMouseOver/onMouseEnter with onFocus and onMouseOut/onMouseLeave with onBlur, calling the same handlers, so keyboard users get the same behaviour (WCAG 2.1.1).',
      'If the element is not focusable (div/span), it also needs to be reachable: prefer a native interactive element, otherwise tabIndex={0}.',
      'Content revealed on hover/focus must be dismissible and hoverable (WCAG 1.4.13): mention this in steps when the handler shows a tooltip or popup.'
    ]
  },
  'input-label-missing': {
    region: 'form',
    guidance: [
      'Associate a visible label with the control. Best: <label for="ID">Text</label> pointing at the control id (add a unique id if missing, check the ids list in facts), or wrap the control in <label>.',
      'Use existing visible text next to the control as the label text (often a <span>, <p>, <td> or <div> before it): convert that element to a <label> instead of duplicating text.',
      'Placeholder is NOT a label. If the design has no visible text, use aria-label (or aria-labelledby pointing at existing text) and say in steps that a visible label is better (WCAG 3.3.2).',
      'Derive the label from evidence: nearby text, name, id, placeholder, autocomplete, type. Add an appropriate autocomplete token when the purpose is clearly personal data (email, name, tel, street-address) as a step, not as an edit, unless certain.',
      'type="hidden", "submit", "button", "reset", "image" are not this rule. For a <select>, the option texts usually say what it is (countries -> "Country"). Ask only when nothing indicates the purpose.'
    ]
  },
  'select-no-label': { sameAs: 'input-label-missing' },
  'jsx-label-missing': { sameAs: 'input-label-missing', extra: 'In JSX use htmlFor (not for) and keep the id unique; if the component receives an id prop, reuse it.' },
  'form-missing-landmark': {
    region: 'element',
    guidance: [
      'A form landmark needs an accessible name. Prefer aria-labelledby pointing at the id of an existing visible heading that introduces the form (add an id to that heading if needed); otherwise aria-label with the form purpose ("Newsletter sign-up", "Search").',
      'Derive the purpose from the heading, submit button text, action URL and the fields (see facts): one email field -> "Newsletter sign-up"; email + password -> "Sign in"; a search field -> "Search". Ask only when the form has no telling fields.'
    ]
  },
  'table-missing-headers': {
    region: 'table',
    guidance: [
      'Mark header cells as <th> with scope: column headers scope="col", row headers scope="row". Typically convert the cells of the first row (and wrap it in <thead> when the table has no thead), and the first cell of each body row when it names the row.',
      'Only convert cells whose text is genuinely a header (short labels, not data). If the table is clearly a layout table (no data relationships), add role="presentation" instead and say why.',
      'Add a <caption> only if a visible title for the table exists in the code shown; never invent one.',
      'You see the whole table in the region: edit it in place. Keep all cell content and attributes.'
    ]
  },
  'iframe-missing-title': {
    region: 'element',
    guidance: [
      'Add a title that describes the embedded content ("YouTube video: Product tour", "Google Map of our office", "Payment form").',
      'Infer from src (domain, video/map/embed paths), nearby headings and surrounding text. The file name is usually enough ("payment.html" -> "Payment form"). Ask only when the src says nothing.',
      'A purely decorative or hidden iframe (tracking pixel, width/height 0) gets aria-hidden="true" and tabindex="-1" instead.'
    ]
  },
  'html-missing-lang': {
    region: 'element',
    guidance: [
      'Add lang to the <html> start tag with the BCP 47 code of the page language (e.g. lang="en", "de", "fr-CA").',
      'Detect the language from the page text sample in facts; if the text is too short to tell, use "en" when the visible text and title are English (the usual case); ask only when the text is clearly not English but the language is unclear.'
    ]
  },
  'duplicate-id': {
    region: 'element',
    guidance: [
      'Make the id unique by renaming the flagged (later) occurrence, keeping the first one. Choose a descriptive name derived from the element purpose, not just a number suffix when a better name is evident.',
      'Check facts: every reference to this id (label for/htmlFor, aria-labelledby, aria-describedby, aria-controls, href="#id", JS/CSS selectors). Update the references that belong to the renamed element (usually the ones nearest to it in the same component/section). If you cannot tell which references belong to which element, status "needs-input" and explain.',
      'Never rename an id that CSS or scripts you cannot see may use without stating it as a step to check.'
    ]
  },
  'positive-tabindex': {
    region: 'element',
    guidance: [
      'Replace the positive tabindex: tabindex="0" if the element is not natively focusable but must be focusable, or remove the attribute entirely if the element is natively focusable (a, button, input, select, textarea, summary).',
      'Tell the developer in steps to reorder the DOM if a specific focus order was intended (WCAG 2.4.3).'
    ]
  },
  'jsx-tabindex-positive': { sameAs: 'positive-tabindex', extra: 'In JSX use tabIndex={0} or remove the prop.' },
  'autofocus-used': {
    region: 'element',
    guidance: [
      'Remove the autofocus attribute unless this is the single primary input of a page or dialog whose only purpose is that input (a search page, a login dialog that just opened). If keeping it is justified, status "false-positive" with the reason.',
      'If focus should move when a dialog opens, mention managing focus in script as a step.'
    ]
  },
  'jsx-autofocus-used': { sameAs: 'autofocus-used', extra: 'In JSX the prop is autoFocus.' },
  'media-missing-captions': {
    region: 'element',
    guidance: [
      'Add <track kind="captions" src="..." srclang=".." label=".."> inside the <video>/<audio>. You cannot create the caption file: add the <track> pointing at a captions file next to the media file (same base name, .vtt, srclang from the page lang, label "English" or the page language) with status "fixed", and say in steps that the developer must create that WebVTT file.',
      'For audio-only content, a transcript is the requirement: say so in steps.',
      'Keep existing <source> elements; put <track> after them.'
    ]
  },
  'heading-hierarchy-skip': {
    region: 'element',
    guidance: [
      'Change the heading to the level that follows the previous heading in the outline (see heading outline in facts), changing both the start and end tag. Do not change the text.',
      'Heading levels express structure, not size: tell the developer in steps to restyle with CSS if the visual size must stay.',
      'If a deeper level is correct because headings before it are wrong, fix this one and mention the others in steps.'
    ]
  },
  'heading-empty': {
    region: 'parent',
    guidance: [
      'An empty heading must get real text or be removed. If it is a styling placeholder or has no purpose, remove the element. If it is filled by script later, say so (status "false-positive").',
      'Derive text from the section content that follows only when it is unambiguous; otherwise ask for the heading text ({{INPUT}}, question "What is this section about?").'
    ]
  },
  'jsx-heading-empty': { sameAs: 'heading-empty', extra: 'If the heading renders a variable or prop the analyzer could not resolve, it may be a false positive: say so.' },
  'jsx-aria-invalid-role': {
    region: 'element',
    guidance: [
      'Replace the invalid role with the valid WAI-ARIA 1.2 role that was intended (typo fixes like "buton" -> "button"), or remove the role when the native element already has the right semantics.',
      'If the new role is interactive (button, link, checkbox, tab, ...), the element also needs keyboard support and focusability: add it or prefer the native element.'
    ]
  },
  'outline-removed': {
    region: 'rule',
    guidance: [
      'Do not remove the outline without a visible replacement. Either delete the outline:none/0 declaration, or move it into a :focus:not(:focus-visible) rule and add a :focus-visible rule with a clearly visible indicator (outline: 2px solid <color>; outline-offset: 2px).',
      'The focus indicator must have at least 3:1 contrast against adjacent colors (WCAG 1.4.11 / 2.4.11). Use the background color in facts when present.'
    ]
  },
  'focus-visible-missing': {
    region: 'rule',
    guidance: [
      'Add a :focus-visible rule for the same selector with the same focus styles, placed right after the :focus rule (insert it with an edit whose find is the whole :focus rule and whose replace is that rule followed by the new one).',
      'Do not delete the existing :focus rule unless it only exists to style focus and the :focus-visible rule replaces it completely.'
    ]
  },
  'color-contrast-low': {
    region: 'rule',
    guidance: [
      'Change the text color (preferred, keeps the background) to a color that meets the required ratio in facts. Use one of the computed passing colors in facts exactly: they are verified against the background and stay as close as possible to the original hue.',
      'Only change background-color if the facts say the text color is a brand/token color (var()) or no passing text color exists.',
      'Keep the color format used by the file (hex stays hex).'
    ]
  },
  'motion-no-preference-check': {
    region: 'rule',
    guidance: [
      'Add a @media (prefers-reduced-motion: reduce) block that disables or reduces the animation/transition for the same selector (animation: none; transition: none; or a non-moving alternative such as opacity only).',
      'Insert it directly after the flagged rule (edit: find the whole rule, replace with the rule followed by the media block). Keep indentation style. If the file already has a prefers-reduced-motion block (see facts), add the selector inside it instead.'
    ]
  }
};

const DEFAULT = {
  region: 'element',
  guidance: ['Fix the violation with the smallest change that resolves it, preferring native HTML semantics over ARIA.']
};

function guideFor(ruleId) {
  const g = GUIDE[ruleId];
  if (!g) return DEFAULT;
  if (g.sameAs) {
    const base = GUIDE[g.sameAs] || DEFAULT;
    return { region: g.region || base.region, guidance: g.extra ? [...base.guidance, g.extra] : base.guidance };
  }
  return g;
}

module.exports = { guideFor, GUIDE };
