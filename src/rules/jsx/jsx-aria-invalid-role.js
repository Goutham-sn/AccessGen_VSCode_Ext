const { walkJSX } = require('../../parsers/jsxParser');

function getElementName(node) {
  if (!node.name) return '';
  if (node.name.type === 'JSXIdentifier') return node.name.name;
  if (node.name.type === 'JSXMemberExpression') {
    return node.name.property ? node.name.property.name : '';
  }
  return '';
}

function getJSXAttr(node, name) {
  if (!node.attributes) return null;
  return node.attributes.find(
    a => a.type === 'JSXAttribute' && a.name && a.name.name === name
  );
}

function getJSXAttrValue(attr) {
  if (!attr || !attr.value) return null;
  if (attr.value.type === 'StringLiteral') return attr.value.value;
  if (attr.value.type === 'JSXExpressionContainer' && attr.value.expression) {
    if (attr.value.expression.type === 'StringLiteral') return attr.value.expression.value;
  }
  return undefined;
}

// WAI-ARIA 1.2 concrete roles (abstract roles such as "command" or "widget" are
// deliberately excluded), plus "mark" (ARIA 1.3 draft, requested), plus the
// DPUB-ARIA 1.1 doc-* roles and Graphics-ARIA 1.0 graphics-* roles.
const VALID_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote',
  'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox',
  'complementary', 'contentinfo', 'definition', 'deletion', 'dialog',
  'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic',
  'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu',
  'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter',
  'navigation', 'none', 'note', 'option', 'paragraph', 'presentation',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider',
  'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch',
  'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer',
  'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
  // DPUB-ARIA 1.1
  'doc-abstract', 'doc-acknowledgments', 'doc-afterword', 'doc-appendix',
  'doc-backlink', 'doc-biblioentry', 'doc-bibliography', 'doc-biblioref',
  'doc-chapter', 'doc-colophon', 'doc-conclusion', 'doc-cover', 'doc-credit',
  'doc-credits', 'doc-dedication', 'doc-endnote', 'doc-endnotes',
  'doc-epigraph', 'doc-epilogue', 'doc-errata', 'doc-example', 'doc-footnote',
  'doc-foreword', 'doc-glossary', 'doc-glossref', 'doc-index',
  'doc-introduction', 'doc-noteref', 'doc-notice', 'doc-pagebreak',
  'doc-pagefooter', 'doc-pageheader', 'doc-pagelist', 'doc-part',
  'doc-preface', 'doc-prologue', 'doc-pullquote', 'doc-qna', 'doc-subtitle',
  'doc-tip', 'doc-toc',
  // Graphics-ARIA 1.0
  'graphics-document', 'graphics-object', 'graphics-symbol'
]);

module.exports = {
  id: 'jsx-aria-invalid-role',
  language: 'jsx',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 4.1.2 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;

      const roleAttr = getJSXAttr(node, 'role');
      if (!roleAttr) return;

      const roleVal = getJSXAttrValue(roleAttr);
      if (roleVal === undefined || roleVal === null) return;

      // role accepts a whitespace-separated fallback list; valid if ANY token is a known role.
      const tokens = roleVal.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (tokens.some(t => VALID_ROLES.has(t))) return;

      if (!node.loc) return;

      violations.push({
        ruleId: 'jsx-aria-invalid-role',
        severity: 'warning',
        startLine: node.loc.start.line - 1,
        endLine: node.loc.end.line - 1,
        startChar: node.loc.start.column,
        endChar: node.loc.end.column,
        message: {
          what: `The role value '${roleVal}' is not a valid ARIA role.`,
          why: 'Invalid ARIA roles are ignored by assistive technology. The element will have no semantic meaning for screen reader users — worse than having no role at all.',
          fix: "Use a valid ARIA role from the WAI-ARIA specification. Common ones: role='button', role='dialog', role='navigation', role='alert'.",
          wcag: 'WCAG 2.1 - 4.1.2 (Level A)'
        }
      });
    });

    return violations;
  }
};
