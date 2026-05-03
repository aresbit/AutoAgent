import { getPromptSourceIndex, loadDesktopReplicaPromptParts } from './prompt-assets.js';

export interface AutoworkPromptContext {
  currentDateTime: string;
  currentTimezone: string;
  cwd: string;
  workspaceFolder: string;
  modelName: string;
  accountName: string;
  folderSelected: 'yes' | 'no';
  hiddenAppend?: string;
}

function wrap(tag: string, content: string): string {
  return `<${tag}>\n${content.trim()}\n</${tag}>`;
}

export function composeAutoworkSystemPrompt(context: AutoworkPromptContext): string {
  const parts = loadDesktopReplicaPromptParts();
  const sourceIndex = getPromptSourceIndex();

  return [
    parts.coworkSystemPrompt.trim().replace(/\bCowork\b/g, 'Autowork').replace(/\bcowork\b/g, 'autowork'),
    wrap(
      'autowork_desktop_replica',
      [
        'Autowork is a Claude Desktop style replica mode implemented inside AutoAgent.',
        'It should inherit the behavior, prompt layering, artifact workflow, and visual-generation expectations described in the upstream extracted prompt assets bundled with this app.',
        'Autowork should not describe itself as Claude Code unless directly relevant.',
      ].join('\n\n'),
    ),
    wrap(
      'autowork_prompt_assembly',
      [
        'The effective prompt should conceptually mirror the upstream Rbr() layering:',
        '1. Cowork desktop system prompt',
        '2. Dynamic workspace and runtime context',
        '3. Skills and project guidance',
        '4. Computer-use guidance',
        '5. Imagine prompt',
        '6. Artifacts host prompt',
        '7. Hidden local AutoAgent directives',
      ].join('\n'),
    ),
    wrap(
      'autowork_artifact_stability_rules',
      [
        'When creating an artifact, prefer returning a fenced artifact-html block with the full widget markup.',
        'If you also save an .html file to the workspace, explicitly mention the resulting filename or absolute path in plain text so the host can ingest it.',
        'Do not only say that a file was created without naming the .html artifact file.',
      ].join('\n'),
    ),
    wrap('autowork_artifacts_host', parts.artifactsSection.replace(/\bCowork\b/g, 'Autowork').replace(/\bcowork\b/g, 'autowork')),
    parts.imagineBase.trim(),
    wrap('imagine_palette', parts.imaginePalette),
    wrap('imagine_ui_components', parts.imagineUiComponents),
    parts.imagineElicitation.trim(),
    wrap('imagine_svg_guide', parts.imagineSvgGuide),
    wrap('imagine_diagram_rules', parts.imagineDiagramRules),
    parts.imagineDataVizRules.trim(),
    parts.imagineArtRules.trim(),
    wrap('visualize_server_definition', parts.visualizeServer.replace(/\bCowork\b/g, 'Autowork').replace(/\bcowork\b/g, 'autowork')),
    wrap('artifact_mechanism_notes', parts.artifactMechanismNotes.replace(/\bCowork\b/g, 'Autowork').replace(/\bcowork\b/g, 'autowork')),
    wrap('ui_generation_notes', parts.uiGenerationNotes.replace(/\bCowork\b/g, 'Autowork').replace(/\bcowork\b/g, 'autowork')),
    wrap('internal_mcp_notes', parts.internalMcpNotes.replace(/\bCowork\b/g, 'Autowork').replace(/\bcowork\b/g, 'autowork')),
    wrap(
      'env',
      [
        `Today's date: ${context.currentDateTime}`,
        `Current timezone: ${context.currentTimezone}`,
        `Model: ${context.modelName}`,
        `User name: ${context.accountName || 'User'}`,
        `Working directory: ${context.cwd}`,
        `Workspace folder: ${context.workspaceFolder}`,
        `User selected a folder: ${context.folderSelected}`,
      ].join('\n'),
    ),
    context.hiddenAppend?.trim() || '',
    wrap('autowork_source_index', JSON.stringify(sourceIndex)),
  ].filter(Boolean).join('\n\n');
}
