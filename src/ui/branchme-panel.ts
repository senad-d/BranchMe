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

type PanelCell =
  | string
  | {
      text: string;
      role?: string;
      bold?: boolean;
      preserveLeading?: boolean;
    };

export type BranchMePanelSection = "status" | "workflow" | "safety";

const NARROW_MIN_WIDTH = 24;
const WIDE_MIN_WIDTH = 72;
const MAX_PANEL_WIDTH = 96;
const MAX_PANEL_HEIGHT = 14;
const BODY_HEIGHT = 7;
const PANEL_SECTIONS: BranchMePanelSection[] = ["status", "workflow", "safety"];

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u009b]/gu, " ").replace(/\s+/gu, " ").trim();
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  const text = sanitize(value);
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function pad(value: string, width: number): string {
  return clip(value, width).padEnd(Math.max(0, width), " ");
}

function sanitizeLayout(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u009b]/gu, " ");
}

function clipLayout(value: string, width: number): string {
  if (width <= 0) return "";
  const text = sanitizeLayout(value);
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function padLayout(value: string, width: number): string {
  return clipLayout(value, width).padEnd(Math.max(0, width), " ");
}

function tailClip(value: string, width: number): string {
  if (width <= 0) return "";
  const text = sanitize(value);
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `…${text.slice(-(width - 1))}`;
}

function rightAlignTail(value: string, width: number): string {
  return tailClip(value, width).padStart(Math.max(0, width), " ");
}

function style(theme: PanelTheme | undefined, role: string, value: string): string {
  return theme ? theme.fg(role, value) : value;
}

function formatCell(cell: PanelCell, width: number, theme?: PanelTheme): string {
  const text = typeof cell === "string" ? cell : cell.text;
  const rendered = typeof cell === "string" || !cell.preserveLeading ? pad(text, width) : padLayout(text, width);
  if (typeof cell === "string" || !theme || !cell.role) return rendered;

  const styled = cell.bold ? theme.bold(rendered) : rendered;
  return theme.fg(cell.role, styled);
}

function heading(text: string): PanelCell {
  return { text, role: "accent", bold: true };
}

function category(text: string, selected: boolean): PanelCell {
  return {
    text: `${selected ? "▶" : " "}  ${text}`,
    role: selected ? "accent" : "dim",
    bold: selected,
    preserveLeading: true,
  };
}

function border(theme: PanelTheme | undefined, value: string): string {
  return style(theme, "accent", value);
}

function horizontal(width: number, left: string, fill: string, right: string, theme?: PanelTheme): string {
  if (width <= 0) return "";
  if (width === 1) return border(theme, fill);
  return border(theme, `${left}${fill.repeat(Math.max(0, width - 2))}${right}`);
}

function titleBorder(width: number, scope: string, theme?: PanelTheme): string {
  if (width < 3) return horizontal(width, "╭", "─", "╮", theme);

  const title = " BranchMe ";
  const scopeText = ` ${scope} `;
  const innerWidth = width - 2;
  const showScope = title.length + scopeText.length <= innerWidth;
  const visibleTitle = title.length <= innerWidth ? title : " BranchMe";
  const visibleScope = showScope ? scopeText : "";
  const fillWidth = Math.max(0, innerWidth - visibleTitle.length - visibleScope.length);
  return border(theme, `╭${visibleTitle}${"─".repeat(fillWidth)}${visibleScope}╮`);
}

function framedLine(content: PanelCell, width: number, theme?: PanelTheme): string {
  const innerWidth = Math.max(0, width - 2);
  return `${border(theme, "│")}${formatCell(content, innerWidth, theme)}${border(theme, "│")}`;
}

function statusValue(data: BranchMePanelData): { branch: string; repository: string; token: string; footer: string } {
  return {
    branch: data.detached ? "detached HEAD" : data.currentBranch ?? "unknown",
    repository: data.githubRepository ?? "not resolved",
    token: getTokenLabel(data.tokenSource),
    footer: data.statusNote ?? "status • no commits/staging/file edits • tools perform actions",
  };
}

function statusRow(label: string, value: string, width: number): string {
  const valueWidth = Math.min(30, Math.max(8, Math.floor(width * 0.42)));
  const labelWidth = Math.max(1, width - valueWidth - 1);
  return `${pad(label, labelWidth)} ${rightAlignTail(value, valueWidth)}`;
}

function sectionTitle(section: BranchMePanelSection): string {
  switch (section) {
    case "status":
      return "STATUS";
    case "workflow":
      return "WORKFLOW";
    case "safety":
      return "SAFETY";
  }
}

function sectionLabel(section: BranchMePanelSection): string {
  const title = sectionTitle(section).toLowerCase();
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function normalizeSection(section: BranchMePanelSection | undefined): BranchMePanelSection {
  return section && PANEL_SECTIONS.includes(section) ? section : "status";
}

function sectionIndex(section: BranchMePanelSection): number {
  return PANEL_SECTIONS.indexOf(section);
}

function sectionFooter(section: BranchMePanelSection, data: BranchMePanelData): string {
  if (data.statusNote) return `warning • ${data.statusNote}`;

  switch (section) {
    case "status":
      return "status • current repository only • tools perform actions";
    case "workflow":
      return "workflow • inspect → branch → push → PR";
    case "safety":
      return "safety • no commits/staging/file edits";
  }
}

function sectionRows(section: BranchMePanelSection, data: BranchMePanelData, width: number): PanelCell[] {
  const values = statusValue(data);

  switch (section) {
    case "status":
      return [
        heading("STATUS"),
        statusRow("Current branch", values.branch, width),
        statusRow("GitHub repository", values.repository, width),
        statusRow("GitHub token", values.token, width),
      ];
    case "workflow":
      return [
        heading("WORKFLOW"),
        statusRow("1 branch_status", "inspect", width),
        statusRow("2 create_branch", "from HEAD", width),
        statusRow("3 push_branch", "current branch", width),
        statusRow("4 pull_request", "current repo PR", width),
      ];
    case "safety":
      return [
        heading("SAFETY"),
        statusRow("Commits", "never", width),
        statusRow("Staging", "never", width),
        statusRow("File edits", "never", width),
        statusRow("Repository", "current only", width),
        statusRow("Token source", "env only", width),
      ];
  }
}

function renderTiny(data: BranchMePanelData, width: number): string[] {
  const values = statusValue(data);
  return [
    clip("BranchMe", width),
    clip(`branch: ${values.branch}`, width),
    clip(`repo: ${values.repository}`, width),
    clip("q quit", width),
  ];
}

function renderNarrow(data: BranchMePanelData, width: number, selectedSection: BranchMePanelSection, theme?: PanelTheme): string[] {
  const section = normalizeSection(selectedSection);
  const innerWidth = Math.max(0, width - 2);
  const rows = sectionRows(section, data, innerWidth).slice(0, BODY_HEIGHT);
  const counter = `${sectionIndex(section) + 1}/${PANEL_SECTIONS.length}`;
  const lines = [
    titleBorder(width, sectionLabel(section), theme),
    framedLine("current repo only • informational", width, theme),
    framedLine("↑↓ section • q quit • /branchme help", width, theme),
    horizontal(width, "├", "─", "┤", theme),
  ];

  for (let index = 0; index < BODY_HEIGHT; index += 1) {
    const row = rows[index] ?? "";
    lines.push(framedLine(row, width, theme));
  }

  lines.push(
    horizontal(width, "├", "─", "┤", theme),
    framedLine(`${counter} • ${sectionFooter(section, data)}`, width, theme),
    horizontal(width, "╰", "─", "╯", theme),
  );

  return lines.slice(0, MAX_PANEL_HEIGHT);
}

function paneSeparator(width: number, leftPaneWidth: number, rightPaneWidth: number, middle: string, theme?: PanelTheme): string {
  return border(theme, `├${"─".repeat(leftPaneWidth)}${middle}${"─".repeat(rightPaneWidth)}┤`);
}

function paneLine(left: PanelCell, right: PanelCell, leftPaneWidth: number, rightPaneWidth: number, theme?: PanelTheme): string {
  return `${border(theme, "│")}${formatCell(left, leftPaneWidth, theme)}${border(theme, "│")}${formatCell(right, rightPaneWidth, theme)}${border(theme, "│")}`;
}

function renderWide(data: BranchMePanelData, width: number, selectedSection: BranchMePanelSection, theme?: PanelTheme): string[] {
  const section = normalizeSection(selectedSection);
  const leftPaneWidth = Math.min(22, Math.max(16, Math.floor(width * 0.27)));
  const rightPaneWidth = Math.max(10, width - leftPaneWidth - 3);
  const rightRows = sectionRows(section, data, rightPaneWidth).slice(0, BODY_HEIGHT);
  const leftRows = PANEL_SECTIONS.map((candidate) => category(sectionLabel(candidate), candidate === section));

  const lines = [
    titleBorder(width, sectionLabel(section), theme),
    framedLine("↑↓ section • q quit • /branchme help", width, theme),
    paneSeparator(width, leftPaneWidth, rightPaneWidth, "┬", theme),
  ];

  for (let index = 0; index < BODY_HEIGHT; index += 1) {
    lines.push(paneLine(leftRows[index] ?? "", rightRows[index] ?? "", leftPaneWidth, rightPaneWidth, theme));
  }

  lines.push(
    paneSeparator(width, leftPaneWidth, rightPaneWidth, "┴", theme),
    framedLine(`${sectionIndex(section) + 1}/${PANEL_SECTIONS.length} • ${sectionFooter(section, data)}`, width, theme),
    horizontal(width, "╰", "─", "╯", theme),
  );

  return lines.slice(0, MAX_PANEL_HEIGHT);
}

export function getTokenLabel(tokenSource: string | null): string {
  return tokenSource ? "present" : "not set";
}

export function renderBranchMePanelLines(
  data: BranchMePanelData,
  width: number,
  theme?: PanelTheme,
  selectedSection: BranchMePanelSection = "status",
): string[] {
  const normalizedWidth = Math.max(0, width);
  if (normalizedWidth < NARROW_MIN_WIDTH) return renderTiny(data, normalizedWidth);

  const panelWidth = Math.min(normalizedWidth, MAX_PANEL_WIDTH);
  const section = normalizeSection(selectedSection);
  if (panelWidth >= WIDE_MIN_WIDTH) return renderWide(data, panelWidth, section, theme);
  return renderNarrow(data, panelWidth, section, theme);
}

export class BranchMePanel {
  private readonly data: BranchMePanelData;
  private readonly theme: PanelTheme | undefined;
  private readonly onClose: () => void;
  private readonly onChange: () => void;
  private selectedSection: BranchMePanelSection = "status";

  constructor(data: BranchMePanelData, theme: PanelTheme | undefined, onClose: () => void, onChange: () => void = () => {}) {
    this.data = data;
    this.theme = theme;
    this.onClose = onClose;
    this.onChange = onChange;
  }

  render(width: number): string[] {
    return renderBranchMePanelLines(this.data, width, this.theme, this.selectedSection);
  }

  handleInput(data: string): void {
    if (data === "q" || data === "Q" || data === "\u001b" || data === "\r" || data === "\n") {
      this.onClose();
      return;
    }

    if (data === "\u001b[A" || data === "k" || data === "K") {
      this.moveSelection(-1);
      return;
    }

    if (data === "\u001b[B" || data === "\t" || data === "j" || data === "J") {
      this.moveSelection(1);
    }
  }

  invalidate(): void {}

  private moveSelection(delta: number): void {
    const currentIndex = sectionIndex(this.selectedSection);
    const nextIndex = (currentIndex + delta + PANEL_SECTIONS.length) % PANEL_SECTIONS.length;
    this.selectedSection = PANEL_SECTIONS[nextIndex] ?? "status";
    this.onChange();
  }
}
