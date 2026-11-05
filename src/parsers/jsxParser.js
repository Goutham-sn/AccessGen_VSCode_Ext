const babelParser = require('@babel/parser');

function parseJSX(sourceCode) {
  try {
    const ast = babelParser.parse(sourceCode, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: true
    });
    return ast;
  } catch (e) {
    console.error('AccessGen: JSX parse error:', e.message);
    return null;
  }
}

function walkJSX(node, visitor) {
  if (!node || typeof node !== 'object') return;

  visitor(node);

  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === 'object' && item.type) {
          walkJSX(item, visitor);
        }
      }
    } else if (child && typeof child === 'object' && child.type) {
      walkJSX(child, visitor);
    }
  }
}

module.exports = { parseJSX, walkJSX };
