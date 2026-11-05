module.exports = {
  id: 'focus-visible-missing',
  language: 'css',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 2.4.7 (Level AA)',
  check(ast, sourceCode, config) {
    const violations = [];
    const focusRules = [];
    let hasFocusVisible = false;

    ast.walkRules((rule) => {
      const selector = rule.selector || '';
      if (selector.includes(':focus-visible')) {
        hasFocusVisible = true;
      }
      if (selector.includes(':focus') && !selector.includes(':focus-visible') && !selector.includes(':focus-within')) {
        focusRules.push(rule);
      }
    });

    if (focusRules.length === 0) return violations;
    if (hasFocusVisible) return violations;

    for (const rule of focusRules) {
      if (!rule.source || !rule.source.start) continue;

      const start = rule.source.start;
      const end = rule.source.end || start;

      violations.push({
        ruleId: 'focus-visible-missing',
        severity: 'warning',
        startLine: start.line - 1,
        endLine: end.line - 1,
        startChar: start.column - 1,
        endChar: end.column,
        message: {
          what: 'Focus styles are defined for :focus but not :focus-visible.',
          why: ':focus triggers for mouse clicks too, which can cause unwanted outlines for mouse users. :focus-visible only shows focus styles for keyboard navigation — giving keyboard users visibility without affecting mouse users.',
          fix: "Add a :focus-visible rule alongside your :focus rule: button:focus-visible { outline: 2px solid #0066cc; } This is now the modern standard for focus styling.",
          wcag: 'WCAG 2.1 - 2.4.7 (Level AA)'
        }
      });
    }

    return violations;
  }
};
