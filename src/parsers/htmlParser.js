const parse5 = require('parse5');

function parseHTML(sourceCode) {
  try {
    const ast = parse5.parse(sourceCode, {
      sourceCodeLocationInfo: true
    });
    return ast;
  } catch (e) {
    console.error('AccessGen: HTML parse error:', e.message);
    return null;
  }
}

function walkNode(node, visitor) {
  visitor(node);
  if (node.childNodes) {
    for (const child of node.childNodes) {
      walkNode(child, visitor);
    }
  }
  if (node.content && node.content.childNodes) {
    for (const child of node.content.childNodes) {
      walkNode(child, visitor);
    }
  }
}

module.exports = { parseHTML, walkNode };
