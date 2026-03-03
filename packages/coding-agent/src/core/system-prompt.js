/**
 * System prompt construction and project context loading
 */
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { getPromptRegistry } from "./prompt-registry.js";
import { formatSkillsForPrompt } from "./skills.js";
/** Known built-in tool names that have short descriptions in the prompt registry */
const KNOWN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "webfetch", "websearch"];
/** Get tool descriptions from the prompt registry */
function getToolDescriptions() {
    const registry = getPromptRegistry();
    const descriptions = {};
    for (const tool of KNOWN_TOOLS) {
        descriptions[tool] = registry.render(`tools/${tool}-short`);
    }
    return descriptions;
}
/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options = {}) {
    const { customPrompt, selectedTools, appendSystemPrompt, cwd, contextFiles: providedContextFiles, skills: providedSkills, } = options;
    const resolvedCwd = cwd ?? process.cwd();
    const now = new Date();
    const dateTime = now.toLocaleString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
    });
    const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
    const contextFiles = providedContextFiles ?? [];
    const skills = providedSkills ?? [];
    if (customPrompt) {
        let prompt = customPrompt;
        if (appendSection) {
            prompt += appendSection;
        }
        // Append project context files
        if (contextFiles.length > 0) {
            prompt += "\n\n# Project Context\n\n";
            prompt += "Project-specific instructions and guidelines:\n\n";
            for (const { path: filePath, content } of contextFiles) {
                prompt += `## ${filePath}\n\n${content}\n\n`;
            }
        }
        // Append skills section (only if read tool is available)
        const customPromptHasRead = !selectedTools || selectedTools.includes("read");
        if (customPromptHasRead && skills.length > 0) {
            prompt += formatSkillsForPrompt(skills);
        }
        // Add date/time and working directory last
        prompt += `\nCurrent date and time: ${dateTime}`;
        prompt += `\nCurrent working directory: ${resolvedCwd}`;
        return prompt;
    }
    // Get absolute paths to documentation and examples
    const readmePath = getReadmePath();
    const docsPath = getDocsPath();
    const examplesPath = getExamplesPath();
    // Build tools list based on selected tools (only built-in tools with known descriptions)
    const toolDescriptions = getToolDescriptions();
    const tools = (selectedTools || ["read", "bash", "edit", "write", "webfetch", "websearch"]).filter((t) => t in toolDescriptions);
    const toolsList = tools.length > 0 ? tools.map((t) => `- ${t}: ${toolDescriptions[t]}`).join("\n") : "(none)";
    // Build guidelines based on which tools are actually available
    const guidelinesList = [];
    const hasBash = tools.includes("bash");
    const hasEdit = tools.includes("edit");
    const hasWrite = tools.includes("write");
    const hasGrep = tools.includes("grep");
    const hasFind = tools.includes("find");
    const hasLs = tools.includes("ls");
    const hasRead = tools.includes("read");
    // File exploration guidelines
    if (hasBash && !hasGrep && !hasFind && !hasLs) {
        guidelinesList.push("Use bash for file operations like ls, rg, find");
    }
    else if (hasBash && (hasGrep || hasFind || hasLs)) {
        guidelinesList.push("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
    }
    // Read before edit guideline
    if (hasRead && hasEdit) {
        guidelinesList.push("Use read to examine files before editing. You must use this tool instead of cat or sed.");
    }
    // Edit guideline
    if (hasEdit) {
        guidelinesList.push("Use edit for precise changes (old text must match exactly)");
    }
    // Write guideline
    if (hasWrite) {
        guidelinesList.push("Use write only for new files or complete rewrites");
    }
    // Output guideline (only when actually writing or executing)
    if (hasEdit || hasWrite) {
        guidelinesList.push("When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did");
    }
    // Always include these
    guidelinesList.push("Be concise in your responses");
    guidelinesList.push("Show file paths clearly when working with files");
    const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
    // Build context sections
    let contextFilesSection = "";
    if (contextFiles.length > 0) {
        contextFilesSection = "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
        for (const { path: filePath, content } of contextFiles) {
            contextFilesSection += `## ${filePath}\n\n${content}\n\n`;
        }
    }
    let skillsSection = "";
    if (hasRead && skills.length > 0) {
        skillsSection = formatSkillsForPrompt(skills);
    }
    const registry = getPromptRegistry();
    return registry.render("system/coding-agent", {
        TOOLS_LIST: toolsList,
        GUIDELINES: guidelines,
        README_PATH: readmePath,
        DOCS_PATH: docsPath,
        EXAMPLES_PATH: examplesPath,
        APPEND_SECTION: appendSection,
        CONTEXT_FILES_SECTION: contextFilesSection,
        SKILLS_SECTION: skillsSection,
        DATE_TIME: dateTime,
        WORKING_DIR: resolvedCwd,
    });
}
//# sourceMappingURL=system-prompt.js.map