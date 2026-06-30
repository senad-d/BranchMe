import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

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

export type BranchMePanelSection = "status" | "workflow";

const NARROW_MIN_WIDTH = 24;
const WIDE_MIN_WIDTH = 72;
const MAX_PANEL_WIDTH = 96;
const MAX_PANEL_HEIGHT = 14;
const BODY_HEIGHT = 7;
const PANEL_SECTIONS: BranchMePanelSection[] = ["status", "workflow"];
const ANSI_RESET = /\u001b\[0m/gu;

function truncateVisible(value: string, width: number, ellipsis = "…", pad = false): string {
  const truncated = truncateToWidth(value, width, ellipsis, pad);
  return value.includes("\u001b") ? truncated : truncated.replace(ANSI_RESET, "");
}

function sanitize(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u009b]/gu, " ").replace(/\s+/gu, " ").trim();
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  return truncateVisible(sanitize(value), width);
}

function pad(value: string, width: number): string {
  return truncateVisible(sanitize(value), Math.max(0, width), "…", true);
}

function sanitizeLayout(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u009b]/gu, " ");
}

function clipLayout(value: string, width: number): string {
  if (width <= 0) return "";
  return truncateVisible(sanitizeLayout(value), width);
}

function padLayout(value: string, width: number): string {
  return truncateVisible(sanitizeLayout(value), Math.max(0, width), "…", true);
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

function layoutCell(text: string, role?: string, bold = false): PanelCell {
  return { text, role, bold, preserveLeading: true };
}

function heading(text: string): PanelCell {
  return layoutCell(` ${text}`, "accent", true);
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

function statusValue(data: BranchMePanelData): { branch: string; repository: string; token: string } {
  return {
    branch: data.detached ? "detached HEAD" : data.currentBranch ?? "unknown",
    repository: data.githubRepository ?? "not resolved",
    token: getTokenLabel(data.tokenSource),
  };
}

function statusDetailRow(label: string, value: string): PanelCell {
  return layoutCell(`  ${label.padEnd(19, " ")}${sanitize(value)}`);
}

function workflowDetailRow(tool: string, description: string): PanelCell {
  return layoutCell(`  ${tool.padEnd(15, " ")}-> ${sanitize(description)}`);
}

function sectionTitle(section: BranchMePanelSection): string {
  switch (section) {
    case "status":
      return "STATUS";
    case "workflow":
      return "WORKFLOW";
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
      return "workflow • inspect → change/create → push → PR";
  }
}

function sectionRows(section: BranchMePanelSection, data: BranchMePanelData): PanelCell[] {
  const values = statusValue(data);

  switch (section) {
    case "status":
      return [
        heading("STATUS"),
        statusDetailRow("Current branch:", values.branch),
        statusDetailRow("GitHub repository:", values.repository),
        statusDetailRow("GitHub token:", values.token),
      ];
    case "workflow":
      return [
        heading("WORKFLOW"),
        workflowDetailRow("branch_status", "inspect"),
        workflowDetailRow("change_branch", "existing local"),
        workflowDetailRow("create_branch", "from HEAD"),
        workflowDetailRow("push_branch", "current branch"),
        workflowDetailRow("pull_request", "after push"),
      ];
  }
}

function fitLines(lines: string[], width: number): string[] {
  return lines.map((line) => truncateVisible(line, Math.max(0, width), ""));
}

function renderTiny(data: BranchMePanelData, width: number): string[] {
  const values = statusValue(data);
  return fitLines(
    [
      clip("BranchMe", width),
      clip(`branch: ${values.branch}`, width),
      clip(`repo: ${values.repository}`, width),
      clip("q quit", width),
    ],
    width,
  );
}

function renderNarrow(data: BranchMePanelData, width: number, selectedSection: BranchMePanelSection, theme?: PanelTheme): string[] {
  const section = normalizeSection(selectedSection);
  const rows = sectionRows(section, data).slice(0, BODY_HEIGHT);
  const counter = `${sectionIndex(section) + 1}/${PANEL_SECTIONS.length}`;
  const lines = [
    titleBorder(width, sectionLabel(section), theme),
    framedLine("current repo only • informational", width, theme),
    framedLine(layoutCell(" ↑↓ section • q quit • /branchme help"), width, theme),
    horizontal(width, "├", "─", "┤", theme),
  ];

  for (let index = 0; index < BODY_HEIGHT; index += 1) {
    const row = rows[index] ?? "";
    lines.push(framedLine(row, width, theme));
  }

  lines.push(
    horizontal(width, "├", "─", "┤", theme),
    framedLine(layoutCell(` ${counter} • ${sectionFooter(section, data)}`), width, theme),
    horizontal(width, "╰", "─", "╯", theme),
  );

  return fitLines(lines.slice(0, MAX_PANEL_HEIGHT), width);
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
  const rightRows = sectionRows(section, data).slice(0, BODY_HEIGHT);
  const leftRows = PANEL_SECTIONS.map((candidate) => category(sectionLabel(candidate), candidate === section));

  const lines = [
    titleBorder(width, sectionLabel(section), theme),
    framedLine(layoutCell(" ↑↓ section • q quit • /branchme help"), width, theme),
    paneSeparator(width, leftPaneWidth, rightPaneWidth, "┬", theme),
  ];

  for (let index = 0; index < BODY_HEIGHT; index += 1) {
    lines.push(paneLine(leftRows[index] ?? "", rightRows[index] ?? "", leftPaneWidth, rightPaneWidth, theme));
  }

  lines.push(
    paneSeparator(width, leftPaneWidth, rightPaneWidth, "┴", theme),
    framedLine(layoutCell(` ${sectionIndex(section) + 1}/${PANEL_SECTIONS.length} • ${sectionFooter(section, data)}`), width, theme),
    horizontal(width, "╰", "─", "╯", theme),
  );

  return fitLines(lines.slice(0, MAX_PANEL_HEIGHT), width);
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
    if (data === "q" || data === "Q" || matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.onClose();
      return;
    }

    if (data === "k" || data === "K" || matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }

    if (data === "j" || data === "J" || matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
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
