const { walkJSX } = require('../../parsers/jsxParser');
const aiFix = require('../shared/aiFix');
const ctx = require('../shared/elementContext');
const { findAttr, attrValue } = require('../shared/jsxAccessibleName');
const { isHiddenJsx, hasJsxSpread } = require('../shared/visibility');

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

function getElementName(node) {
  if (!node.name) return '';
  if (node.name.type === 'JSXIdentifier') return node.name.name;
  if (node.name.type === 'JSXMemberExpression') {
    return node.name.property ? node.name.property.name : '';
  }
  return '';
}

module.exports = {
  id: 'jsx-img-alt-missing',
  language: 'jsx',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 1.1.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkJSX(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;

      const name = getElementName(node);
      if (name.toLowerCase() !== 'img') return;

      if (config.isTrustedComponent && config.isTrustedComponent(name)) return;
      // Spread props may carry alt; an image hidden from assistive technology needs none.
      if (hasJsxSpread(node) || isHiddenJsx(node)) return;

      const roleAttr = getJSXAttr(node, 'role');
      if (roleAttr) {
        const roleVal = getJSXAttrValue(roleAttr);
        if (roleVal === 'presentation' || roleVal === 'none') return;
      }

      const altAttr = getJSXAttr(node, 'alt');
      if (altAttr) {
        const altVal = getJSXAttrValue(altAttr);
        if (altVal !== null && altVal !== undefined) return;
        if (altAttr.value && altAttr.value.type === 'JSXExpressionContainer') return;
      }

      if (!node.loc) return;

      violations.push({
        ruleId: 'jsx-img-alt-missing',
        severity: 'critical',
        startLine: node.loc.start.line - 1,
        endLine: node.loc.end.line - 1,
        startChar: node.loc.start.column,
        endChar: node.loc.end.column,
        message: {
          what: 'This image has no alt attribute.',
          why: 'Screen reader users will hear the file name or URL read aloud instead of a meaningful description. This makes the image useless or confusing for blind users.',
          fix: "Add alt='describe what the image shows' prop to the img element. For decorative images use alt=''.",
          wcag: 'WCAG 2.1 - 1.1.1 (Level A)'
        }
      });
    });

    return violations;
  },

  // ---- AI-suggested fix --------------------------------------------------------------------------
  // fixTier 'ai-suggested': never auto-applied in ANY remediationMode; a quick fix selected by hand.
  // Adds alt="..." (or alt={"..."} when the text needs escaping) to the opening element.
  fixTier: 'ai-suggested',
  aiFixLabel: 'alt text',
  async fix(violation, sourceCode, services) {
    if (!services || typeof services.generate !== 'function') return null;
    const found = aiFix.findJsxElement(sourceCode, violation);
    if (!found) return null;
    const { ast, node } = found;
    const opening = node.openingElement;
    if (opening.name.type !== 'JSXIdentifier' || opening.name.name.toLowerCase() !== 'img') return null;

    // Stale check: still no alt attribute (and not marked presentational).
    const role = attrValue(findAttr(opening, 'role'));
    if (findAttr(opening, 'alt') || (role.state === 'static' && ['presentation', 'none'].includes(role.text))) return null;
    if (aiFix.hasJsxSpread(opening)) return { unavailable: 'No AI suggestion for this image: it spreads props, which may already supply alt.' };

    const info = ctx.buildJsxInfo(ast);
    const meta = info.get(node) || {};
    const src = attrValue(findAttr(opening, 'src'));
    const suggestion = await services.generate({
      kind: 'image-alt-fix',
      content: '',
      path: meta.path,
      context: ctx.pick({
        fileName: src.state === 'static' ? ctx.imageFileName(src.text) : '',
        figcaption: meta.figcaption,
        nearestHeading: meta.nearestHeading,
        surroundingText: ctx.jsxSurroundingText(node, info, '[IMAGE]')
      })
    });

    const text = aiFix.cleanAltSuggestion(suggestion.suggestedText);
    if (!text) return { unavailable: 'The AI suggestion was not usable as alt text (it was a file name or a single generic word). Write the alt text yourself.' };
    return { ...aiFix.jsxAddAttribute(sourceCode, node, 'alt', text), suggestion: { ...suggestion, suggestedText: text } };
  }
};
