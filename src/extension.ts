import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBranchMeCommand } from "./commands/branchme-command.ts";
import { registerGitContextAwareness } from "./git-context.ts";
import { withGitTransport } from "./git-transport.ts";
import { registerBranchMeTools } from "./tools/branchme-tools.ts";

export function branchMeExtension(pi: ExtensionAPI): void {
  registerBranchMeCommand(pi);
  registerBranchMeTools({ registerTool: pi.registerTool.bind(pi), exec: withGitTransport(pi).exec });
  registerGitContextAwareness(pi);
}

export default branchMeExtension;
