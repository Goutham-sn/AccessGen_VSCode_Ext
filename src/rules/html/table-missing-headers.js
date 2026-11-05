const { walkNode } = require('../../parsers/htmlParser');
const { isHiddenHtml } = require('../shared/visibility');

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

// Rows that belong to this table (directly, or through thead/tbody/tfoot), not to a nested table.
function ownRows(table) {
  const rows = [];
  (function visit(n) {
    for (const c of n.childNodes || []) {
      if (c.tagName === 'tr') rows.push(c);
      else if (c.tagName === 'thead' || c.tagName === 'tbody' || c.tagName === 'tfoot') visit(c);
    }
  })(table);
  return rows;
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
      if (roleAttr && (roleAttr.value === 'presentation' || roleAttr.value === 'none')) return;
      if (isHiddenHtml(node)) return;

      // Only this table's own rows and cells (a nested table is checked on its own).
      const rows = ownRows(node);
      const cellsOf = (tr) => (tr.childNodes || []).filter(c => c.tagName === 'td' || c.tagName === 'th');

      // headers="..." makes it a data table on purpose; each token must be the id of a <th> of this table.
      const thIds = new Set(rows.flatMap(r => cellsOf(r)).filter(c => c.tagName === 'th').map(c => (getAttr(c, 'id') || {}).value).filter(Boolean));
      const broken = rows.flatMap(r => cellsOf(r)).filter(c => { const h = getAttr(c, 'headers'); return h && h.value.trim() && h.value.trim().split(/\s+/).some(t => !thIds.has(t)); });
      if (broken.length) {
        const bl = getLoc(broken[0]);
        if (bl) violations.push({
          ruleId: 'table-missing-headers', severity: 'warning',
          startLine: bl.startLine, endLine: bl.endLine, startChar: bl.startChar, endChar: bl.endChar,
          message: {
            what: 'A cell\'s headers attribute points at a header that does not exist in this table.',
            why: 'Screen readers use headers="..." to announce which header a cell belongs to; a broken reference means the cell is read without its header.',
            fix: "Make every token in headers='...' the id of a <th> in the same table.",
            wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
          }
        });
        return;
      }
      const width = Math.max(0, ...rows.map(r => cellsOf(r).length));
      // A single row or a single column has no header relationships to convey: a layout table, not data.
      if (rows.length < 2 || width < 2) return;

      const loc = getLoc(node);
      if (!loc) return;
      const thElements = rows.flatMap(r => cellsOf(r).filter(c => c.tagName === 'th'));

      if (thElements.length === 0) {
        violations.push({
          ruleId: 'table-missing-headers',
          severity: 'warning',
          startLine: loc.startLine,
          endLine: loc.endLine,
          startChar: loc.startChar,
          endChar: loc.endChar,
          message: {
            what: 'This data table has no header cells.',
            why: 'Screen reader users navigate tables cell by cell. Without headers, they hear data values with no context — numbers with no column or row name to give them meaning.',
            fix: "Mark the header cells with <th>, e.g. <th scope='col'>Name</th> for column headers (and <th scope='row'> for row headers).",
            wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
          }
        });
        return;
      }

      // Header cells exist. For a simple table browsers work out which cells they label; scope (or headers/id) only
      // matters when there are headers on both axes, so that is the only case reported, once, as advice.
      const firstRowHeaders = cellsOf(rows[0]).some(c => c.tagName === 'th');
      const rowHeaders = rows.slice(1).some(r => { const c = cellsOf(r)[0]; return c && c.tagName === 'th'; });
      if (!(firstRowHeaders && rowHeaders)) return;
      if (usesCompleteHeadersAssociation(node, thElements)) return;
      if (thElements.every(th => { const sc = getAttr(th, 'scope'); return sc && sc.value; })) return;

      violations.push({
        ruleId: 'table-missing-headers',
        severity: 'advisory',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'This table has both column and row headers, but not every header says which way it applies.',
          why: 'With headers on both axes, some screen readers guess wrong about which cells a header labels.',
          fix: "Add scope='col' to column headers and scope='row' to row headers.",
          wcag: 'WCAG 2.1 - 1.3.1 (Level A)'
        }
      });
    });

    return violations;
  }
};
