import { describe, expect, test } from "bun:test";
import { listRegisteredToolNames, TOOLS } from "../src/tools.ts";

const EXPECTED_TOOLS = new Set([
  "add_memory",
  "query_memory",
  "archive_memories",
  "recall_memory",
  "get_stats",
  "scheduler_status",
  "scheduler_control",
  "index_file",
  "index_directory",
  "search_files",
  "list_indexed_files",
  "get_file_info",
  "get_file_stats",
]);

describe("tool contract", () => {
  test("registers exactly the expected tools", () => {
    const actual = new Set(listRegisteredToolNames());
    expect(actual).toEqual(EXPECTED_TOOLS);
  });

  test("every tool has a description", () => {
    const undescribed = TOOLS.filter((t) => !(t.description || "").trim()).map(
      (t) => t.name,
    );
    expect(undescribed).toEqual([]);
  });
});
