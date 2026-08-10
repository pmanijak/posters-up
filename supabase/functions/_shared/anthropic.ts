// Minimal typing for the Anthropic Messages API response.
//
// Only covers what this codebase actually reads off a response — enough to
// stop `(c: any) => c.type === ...` scans over `content`, not a full SDK.
//
// Follows the discriminated-union pattern in type-best-practices.md: the
// base block carries an index signature so narrowed blocks are assignable
// to it, which is what lets a type predicate compile.

export interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

/** A model-invoked tool call. `input` stays unknown — cast it at the call site. */
export interface ToolUseBlock extends AnthropicContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface TextBlock extends AnthropicContentBlock {
  type: "text";
  text: string;
}

export interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  [key: string]: unknown;
}

/** Narrow to a tool_use block, optionally requiring a specific tool name. */
export function isToolUseBlock(
  block: AnthropicContentBlock,
  name?: string,
): block is ToolUseBlock {
  return block.type === "tool_use" && (name === undefined || block.name === name);
}

export function isTextBlock(block: AnthropicContentBlock): block is TextBlock {
  return block.type === "text";
}

// Block types emitted by the hosted web_search tool. Detecting search use
// from the response shape is more reliable than trusting the model to report
// it — see the call site in resolve-talent-name for the caveat about these
// names being taken from Anthropic's docs rather than an observed response.
const WEB_SEARCH_BLOCK_TYPES = ["server_tool_use", "web_search_tool_result"];

export function usedWebSearch(response: AnthropicResponse): boolean {
  return response.content?.some((c) => WEB_SEARCH_BLOCK_TYPES.includes(c.type)) ?? false;
}