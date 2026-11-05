module.exports = {
  id: 'motion-no-preference-check',
  language: 'css',
  severity: 'advisory',
  wcag: 'WCAG 2.1 - 2.3.3 (Level AAA)',
  check(ast, sourceCode, config) {
    const violations = [];
    const animationDecls = [];
    let hasReducedMotionQuery = false;

    ast.walkAtRules((atRule) => {
      if (atRule.name === 'media' && atRule.params &&
          atRule.params.includes('prefers-reduced-motion')) {
        hasReducedMotionQuery = true;
      }
    });

    ast.walkDecls((decl) => {
      if ((decl.prop === 'animation' || decl.prop === 'animation-name') && !/^(none|initial|unset)$/i.test(String(decl.value).trim())) {
        animationDecls.push(decl);
      }
    });

    if (animationDecls.length === 0) return violations;
    if (hasReducedMotionQuery) return violations;

    for (const decl of animationDecls) {
      if (!decl.source || !decl.source.start) continue;

      const start = decl.source.start;
      const end = decl.source.end || start;

      violations.push({
        ruleId: 'motion-no-preference-check',
        severity: 'advisory',
        startLine: start.line - 1,
        endLine: end.line - 1,
        startChar: start.column - 1,
        endChar: end.column,
        message: {
          what: 'Animation used without a prefers-reduced-motion media query.',
          why: 'Users with vestibular disorders, epilepsy, or motion sensitivity can experience nausea, dizziness, or seizures from animated content. Many operating systems let users request reduced motion — your CSS should respect that setting.',
          fix: "@media (prefers-reduced-motion: reduce) { .element { animation: none; } }",
          wcag: 'WCAG 2.1 - 2.3.3 (Level AAA)'
        }
      });
    }

    return violations;
  }
};
