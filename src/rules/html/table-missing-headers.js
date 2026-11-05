const { walkNode } = require('../../parsers/htmlParser');

function getAttr(node, name) {
  return (node.attrs || []).find(a => a.name === name);
}

function getLoc(node) {
  const loc = node.sourceCodeLocation;
  if (!loc) return null;
  const tag = loc.startTag || loc;
  return {
    startLine: tag.startLine - 1,
    endLine: (tag.endLine || tag.startLine) - 1,
    startChar: tag.startCol - 1,
    endChar: (tag.endCol || tag.startCol + 10) - 1
  };
}

function collectDescendants(node, tagName) {
  const results = [];
  if (!node.childNodes) return results;
  for (const child of node.childNodes) {
    if (child.tagName === tagName) {
      results.push(child);
    }
    results.push(...collectDescendants(child, tagName));
  }
  return results;
}

// Complex-table pattern: <th id="x"> + <td headers="x y">. Valid only when there is at
// least one data cell and EVERY data cell has a non-empty headers attribute whose tokens
// all resolve to a <th id> inside this same table.
function usesCompleteHeadersAssociation(table, thElements) {
  const thIds = new Set(
    thElements.map(th => getAttr(th, 'id')).filter(a => a && a.value && a.value.trim()).map(a => a.value.trim())
  );
  if (thIds.size === 0) return false;

  const dataCells = collectDescendants(table, 'td');
  if (dataCells.length === 0) return false;

  return dataCells.every(td => {
    const headersAttr = getAttr(td, 'headers');
    if (!headersAttr || !headersAttr.value) return false;
    const tokens = headersAttr.value.split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every(t => thIds.has(t));
  });
}

module.exports = {
  id: 'table-missing-headers',
  language: 'html',
  severity: 'warning',
  wcag: 'WCAG 2.1 - 1.3.1 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'table') return;

      const roleAttr = getAttr(node, 'role');
      if (roleAttr && (roleAttr.value === 'presentation' || roleAttr.value === 'none')) {
        return;
      }

      const thElements = collectDescendants(node, 'th');
      const loc = getLoc(node);
      if (!loc) return;

      if (thElements.length === 0) {
        violations.push({
          ruleId: 'table-missing-headers',
          severity: 'warning',
          startLine: loc.startLine,
          endLine: loc.endLine,
          startChar: loc.startChar,
          endChar: loc.endChar,
          message: {
            what: 'This table has no header cells or missing scope attributes.',
            why: 'Screen reader users navigate tables cell by cell. Without headers, they hear data values with no context — numbers with no column or row name to give them meaning.',
            fix: "Add <th scope='col'>Column Name</th> for column headers and <th scope='row'>Row Name</th> for row headers.",
            wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
          }
        });
        return;
      }

      // Either association pattern is sufficient: scope on every <th>, or a complete
      // headers/id mapping (the correct technique for irregular tables).
      if (usesCompleteHeadersAssociation(node, thElements)) return;

      for (const th of thElements) {
        const scopeAttr = getAttr(th, 'scope');
        if (!scopeAttr || !scopeAttr.value) {
          const thLoc = getLoc(th);
          if (!thLoc) continue;

          violations.push({
            ruleId: 'table-missing-headers',
            severity: 'warning',
            startLine: thLoc.startLine,
            endLine: thLoc.endLine,
            startChar: thLoc.startChar,
            endChar: thLoc.endChar,
            message: {
              what: 'This table has no header cells or missing scope attributes.',
              why: 'Screen reader users navigate tables cell by cell. Without headers, they hear data values with no context — numbers with no column or row name to give them meaning.',
              fix: "Add <th scope='col'>Column Name</th> for column headers and <th scope='row'>Row Name</th> for row headers.",
              wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
            }
          });
        }
      }
    });

    return violations;
  }
};
