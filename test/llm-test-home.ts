/**
 * Imported FIRST by llm-claims.test.ts: points HOME at a throwaway dir
 * before any src/* module computes its cache path, so the file cache
 * never touches the real ~/.cache/greenlight during tests.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "gl-llm-test-"));
