// Plain-language names for each rule, for people who are not accessibility experts: what is wrong (title) and
// who it affects (impact). Shown in the panel, the fix preview and the report; rule ids stay secondary.

const TITLES = {
  'img-alt-missing': ['Image has no text description', 'Screen reader users cannot tell what the image shows'],
  'jsx-img-alt-missing': ['Image has no text description', 'Screen reader users cannot tell what the image shows'],
  'input-label-missing': ['Text field has no label', 'Screen reader users do not know what to type'],
  'jsx-label-missing': ['Form field has no label', 'Screen reader users do not know what to enter'],
  'select-no-label': ['Dropdown has no label', 'Screen reader users do not know what the choice is for'],
  'button-empty': ['Button has no name', 'Screen reader users hear only "button", with no idea what it does'],
  'anchor-no-text': ['Link text does not say where it goes', 'Screen reader users cannot tell links apart'],
  'jsx-anchor-no-content': ['Link has no text', 'Screen reader users cannot tell where the link goes'],
  'heading-hierarchy-skip': ['Heading level is skipped', 'The page outline that screen reader users navigate by is broken'],
  'heading-empty': ['Heading is empty', 'Screen reader users land on a heading with nothing in it'],
  'jsx-heading-empty': ['Heading is empty', 'Screen reader users land on a heading with nothing in it'],
  'div-used-as-button': ['Clickable element is not a real button', 'Keyboard users cannot reach or activate it'],
  'jsx-onclick-no-keyboard': ['Clickable element does not work with a keyboard', 'Keyboard users cannot activate it'],
  'jsx-interactive-no-role': ['Clickable element is not announced as one', 'Screen reader users do not know they can activate it'],
  'jsx-mouse-events-no-focus': ['Hover behaviour has no keyboard equivalent', 'Keyboard users miss what mouse users see'],
  'form-missing-landmark': ['Form has no name', 'Screen reader users cannot tell what the form is for when jumping between regions'],
  'table-missing-headers': ['Table has no header cells', 'Screen reader users hear values without knowing which column they belong to'],
  'iframe-missing-title': ['Embedded frame has no title', 'Screen reader users cannot tell what the frame contains'],
  'html-missing-lang': ['Page language is not set', 'Screen readers may read the page with the wrong pronunciation'],
  'duplicate-id': ['The same id is used twice', 'Labels and ARIA references may point at the wrong element'],
  'positive-tabindex': ['Tab order is forced with a positive tabindex', 'Keyboard focus jumps around the page in an unexpected order'],
  'jsx-tabindex-positive': ['Tab order is forced with a positive tabindex', 'Keyboard focus jumps around the page in an unexpected order'],
  'autofocus-used': ['Field grabs focus when the page loads', 'Screen reader users can miss the content before it'],
  'jsx-autofocus-used': ['Field grabs focus when the page loads', 'Screen reader users can miss the content before it'],
  'media-missing-captions': ['Video or audio has no captions', 'Deaf and hard-of-hearing users miss the spoken content'],
  'jsx-aria-invalid-role': ['Element has an invalid ARIA role', 'Assistive technology may ignore or misreport the element'],
  'outline-removed': ['Keyboard focus indicator is removed', 'Keyboard users cannot see where they are on the page'],
  'focus-visible-missing': ['Focus style is missing for keyboard users', 'Keyboard users may not see where focus is'],
  'color-contrast-low': ['Text color has too little contrast', 'People with low vision may not be able to read it'],
  'motion-no-preference-check': ['Animation ignores the reduce-motion setting', 'Can cause dizziness or nausea for people sensitive to motion']
};

function titleOf(ruleId) {
  return (TITLES[ruleId] && TITLES[ruleId][0]) || ruleId;
}
function impactOf(ruleId) {
  return (TITLES[ruleId] && TITLES[ruleId][1]) || '';
}

module.exports = { TITLES, titleOf, impactOf };
