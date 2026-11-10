// Template-evidence tests (scanner parity, v0.27.0).
// Fixture texts are verbatim from the scanner's fixture suite
// (policy-index/wider-scan-2026-11-09/test_patches.py): the scanner's
// classify_repo reads PR/issue templates as policy evidence, and the CLI
// now does the same. Template rules run ONLY over template paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGates, parseGatesFromSources, parseTemplateGates, isTemplatePath } from "../src/gates.js";
import { fetchHouseRulesDetailed } from "../src/github.js";

const DECKY = "Please tick as appropriate:\n- [ ] I have tested this code on a steam deck or on a PC\n"
    + "- [ ] My changes generate no new errors/warnings\n- [ ] This is a bugfix/hotfix\n"
    + "- [ ] This is a new feature\n- [ ] NO AI/LLM USED IN THE DEVELOPMENT OF THIS PULL REQUEST\n";
const DISCLOSURE = "## AI usage\n- [ ] If you used AI tools, describe the extent of AI usage below.\n"
    + "Did you use an LLM for this change? If so, disclose it here.\n";
const ISSUE_SCOPE = "## Bug report\nAI-generated bug reports will be closed without review. "
    + "Please write your report yourself.\n";
const NEUTRAL = "## Description\nWhat does this PR do?\n- [ ] Tests pass\n";

function kind<T extends { kind: string; detected: boolean }>(gates: T[], k: string) {
    return gates.find((g) => g.kind === k);
}

test("decky PR template classifies agents_banned", () => {
    const gates = parseTemplateGates(DECKY);
    assert.equal(kind(gates, "agents_banned")?.detected, true);
});

test("decky template via parseGatesFromSources records the template file as source", () => {
    const gates = parseGatesFromSources([{ file: ".github/pull_request_template.md", text: DECKY }]);
    const banned = kind(gates, "agents_banned");
    assert.equal(banned?.detected, true);
    assert.equal((banned as { source?: string }).source, ".github/pull_request_template.md");
});

test("disclosure template classifies agents_disclosure and NOT agents_banned", () => {
    const gates = parseTemplateGates(DISCLOSURE);
    assert.equal(kind(gates, "agents_disclosure")?.detected, true);
    assert.equal(kind(gates, "agents_banned")?.detected, false);
    const merged = parseGatesFromSources([{ file: ".github/ISSUE_TEMPLATE/config.yml", text: DISCLOSURE }]);
    assert.equal(kind(merged, "agents_disclosure")?.detected, true);
    assert.equal(kind(merged, "agents_banned")?.detected, false);
});

test("AI-generated bug report rule classifies nothing (scope guard)", () => {
    const gates = parseTemplateGates(ISSUE_SCOPE);
    assert.equal(kind(gates, "agents_banned")?.detected, false);
    assert.equal(kind(gates, "agents_disclosure")?.detected, false);
});

test("scope guard suppresses a ban scoped to bug reports, not a general one", () => {
    const scoped = parseTemplateGates("## Bug report\nNo AI-generated bug reports. File them yourself.\n");
    assert.equal(kind(scoped, "agents_banned")?.detected, false);
    const general = parseTemplateGates("No AI-generated content in pull requests.\n");
    assert.equal(kind(general, "agents_banned")?.detected, true);
});

test("neutral template classifies nothing", () => {
    const gates = parseTemplateGates(NEUTRAL);
    assert.equal(kind(gates, "agents_banned")?.detected, false);
    assert.equal(kind(gates, "agents_disclosure")?.detected, false);
});

test("isTemplatePath covers singles and both directories only", () => {
    assert.equal(isTemplatePath(".github/pull_request_template.md"), true);
    assert.equal(isTemplatePath(".github/PULL_REQUEST_TEMPLATE/default.md"), true);
    assert.equal(isTemplatePath(".github/ISSUE_TEMPLATE/bug_report.yml"), true);
    assert.equal(isTemplatePath(".github/ISSUE_TEMPLATE.md"), true);
    assert.equal(isTemplatePath("CONTRIBUTING.md"), false);
    assert.equal(isTemplatePath(".github/workflows/ci.yml"), false);
});

test("template rules do not run over CONTRIBUTING text", () => {
    // Pick a text only the attestation rule catches: verify the general
    // parser alone does not detect a ban on it, then prove the merged
    // source path stays clean when the file is not a template.
    const attestOnly = "I confirm that no AI was used in this contribution.\n";
    const general = parseGates(attestOnly);
    assert.equal(kind(general, "agents_banned")?.detected, false,
        "precondition: general rules must not catch the attestation-only text");
    const merged = parseGatesFromSources([{ file: "CONTRIBUTING.md", text: attestOnly }]);
    assert.equal(kind(merged, "agents_banned")?.detected, false);
    const asTemplate = parseGatesFromSources([{ file: ".github/pull_request_template.md", text: attestOnly }]);
    assert.equal(kind(asTemplate, "agents_banned")?.detected, true);
});

test("fetchHouseRulesDetailed returns template sources via seams", async () => {
    const issueTemplate = "---\nname: Bug report\n---\n" + ISSUE_SCOPE;
    const deps = {
        fetchRaw: async (file: string) => {
            if (file === ".github/pull_request_template.md") return DECKY;
            if (file === ".github/ISSUE_TEMPLATE/bug_report.md") return issueTemplate;
            return undefined;
        },
        fetchDir: async (dir: string) => {
            if (dir === ".github/ISSUE_TEMPLATE") return ["bug_report.md", "config.yml"];
            return [];
        },
    };
    const { sources, provenance } = await fetchHouseRulesDetailed("someowner", "somerepo", deps);
    const files = sources.map((s) => s.file);
    assert.ok(files.includes(".github/pull_request_template.md"), `template single missing: ${files}`);
    assert.ok(files.includes(".github/ISSUE_TEMPLATE/bug_report.md"), `template dir file missing: ${files}`);
    assert.ok(provenance.some((p) => p.file === ".github/pull_request_template.md" && p.status === "read"));
    const gates = parseGatesFromSources(sources);
    assert.equal(kind(gates, "agents_banned")?.detected, true);
});
