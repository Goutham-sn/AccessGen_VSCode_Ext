const vscode = require('vscode');

function createStatusBar() {
  const item = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  item.command = 'accessgen.toggle';
  item.text = 'AccessGen  ON';
  item.tooltip = 'AccessGen — No issues in this file';
  item.show();
  return item;
}

function updateStatusBar(item, enabled, issueCount) {
  if (!item) return;

  if (!enabled) {
    item.text = 'AccessGen  OFF';
    item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
    item.tooltip = 'AccessGen is disabled. Click to enable.';
    return;
  }

  if (issueCount === 0) {
    item.text = 'AccessGen  ON';
    item.color = new vscode.ThemeColor('statusBarItem.foreground');
    item.tooltip = 'AccessGen — No issues in this file';
  } else {
    item.text = `AccessGen  ⚑ ${issueCount}`;
    item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    item.tooltip = `AccessGen — ${issueCount} issues in this file. Click to toggle.`;
  }
}

function showToggleNotification(enabled) {
  const msg = enabled ? 'AccessGen — Enabled' : 'AccessGen — Disabled';
  vscode.window.setStatusBarMessage(msg, 2000);
}

module.exports = {
  createStatusBar,
  updateStatusBar,
  showToggleNotification
};
