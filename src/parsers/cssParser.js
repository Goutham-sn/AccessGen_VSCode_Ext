const postcss = require('postcss');

function parseCSS(sourceCode) {
  try {
    const root = postcss.parse(sourceCode);
    return root;
  } catch (e) {
    console.error('AccessGen: CSS parse error:', e.message);
    return null;
  }
}

function walkCSS(root, visitor) {
  root.walk(node => {
    visitor(node);
  });
}

module.exports = { parseCSS, walkCSS };
