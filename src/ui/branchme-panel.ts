export interface BranchMePanelData {
  currentBranch: string | null;
  detached: boolean;
  githubRepository: string | null;
  tokenSource: string | null;
  statusNote?: string;
}

interface PanelTheme {
  fg(color: string, value: string): string;
  bold(value: string): string;
}

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u009b]/gu, " ").replace(/\s+/gu, " ").trim();
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  const text = sanitize(value);
  if (text.length <= width) return text.padEnd(width, " ");
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function tailClip(value: string, width: number): string {
  if (width <= 0) return "";
  const text = sanitize(value);
  if (text.length <= width) return text.padEnd(width, " ");
  if (width === 1) return "…";
  return `…${text.slice(-(width - 1))}`;
}

function style(theme: PanelTheme | undefined, role: string, value: string): string {
  return theme ? theme.fg(role, value) : value;
}

function framedLine(content: string, width: number, theme?: PanelTheme): string {
  const innerWidth = Math.max(0, width - 2);
  return `${style(theme, "accent", "│")}${clip(content, innerWidth)}${style(theme, "accent", "│")}`;
}

function horizontal(width: number, left: string, right: string, theme?: PanelTheme): string {
  if (width <= 1) return style(theme, "accent", "─".repeat(Math.max(0, width)));
  return style(theme, "accent", `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
}

function titleBorder(width: number, theme?: PanelTheme): string {
  if (width < 3) return horizontal(width, "╭", "╮", theme);
  const title = " BranchMe ";
  const scope = " Status ";
  const innerWidth = width - 2;
  const titleText = title.length + scope.length <= innerWidth ? title : " BranchMe";
  const scopeText = titleText.length + scope.length <= innerWidth ? scope : "";
  const fillWidth = Math.max(0, innerWidth - titleText.length - scopeText.length);
  return style(theme, "accent", `╭${titleText}${"─".repeat(fillWidth)}${scopeText}╮`);
}

function row(label: string, value: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  const safeLabel = sanitize(label);
  const valueWidth = Math.min(28, Math.max(8, Math.floor(innerWidth * 0.42)));
  const labelWidth = Math.max(1, innerWidth - valueWidth - 1);
  return `${clip(safeLabel, labelWidth)} ${tailClip(value, valueWidth)}`;
}

export function getTokenLabel(tokenSource: string | null): string {
  return tokenSource ? `present (${tokenSource})` : "not set";
}

export function renderBranchMePanelLines(data: BranchMePanelData, width: number, theme?: PanelTheme): string[] {
  const normalizedWidth = Math.max(0, width);
  const branch = data.detached ? "detached HEAD" : data.currentBranch ?? "unknown";
  const repository = data.githubRepository ?? "not resolved";
  const token = getTokenLabel(data.tokenSource);
  const note = data.statusNote ?? "Tools perform actions; /branchme is informational only.";

  if (normalizedWidth < 24) {
    return [
      clip("BranchMe", normalizedWidth),
      clip(branch, normalizedWidth),
      clip(repository, normalizedWidth),
      clip("q quit", normalizedWidth),
    ];
  }

  const lines = [
    titleBorder(normalizedWidth, theme),
    framedLine("↑↓ status • tools: branch_status → create_branch → push_branch → pull_request", normalizedWidth, theme),
    framedLine("q quit • Esc close • /branchme help for workflow notes", normalizedWidth, theme),
    horizontal(normalizedWidth, "├", "┤", theme),
    framedLine(`▶ Current branch ${branch}`, normalizedWidth, theme),
    framedLine(row("GitHub repository", repository, normalizedWidth), normalizedWidth, theme),
    framedLine(row("GitHub token", token, normalizedWidth), normalizedWidth, theme),
    horizontal(normalizedWidth, "├", "┤", theme),
    framedLine(`1/3 • ${note}`, normalizedWidth, theme),
    horizontal(normalizedWidth, "╰", "╯", theme),
  ];

  return lines;
}

export class BranchMePanel {
  private readonly data: BranchMePanelData;
  private readonly theme: PanelTheme | undefined;
  private readonly onClose: () => void;

  constructor(data: BranchMePanelData, theme: PanelTheme | undefined, onClose: () => void) {
    this.data = data;
    this.theme = theme;
    this.onClose = onClose;
  }

  render(width: number): string[] {
    return renderBranchMePanelLines(this.data, width, this.theme);
  }

  handleInput(data: string): void {
    if (data === "q" || data === "Q" || data === "\u001b" || data === "\r" || data === "\n") {
      this.onClose();
    }
  }

  invalidate(): void {}
}
