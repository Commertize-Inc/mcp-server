/**
 * Unit suite for suite-verdict.mjs (DP-FLAG-21): the runner must call a suite
 * failed whenever it failed, whatever its exit code.
 */
import { suiteFailure } from "./suite-verdict.mjs";
import { check, resetCounters, section, summary } from "./harness.mjs";

const ESC = String.fromCharCode(27);
resetCounters();
section("suite verdict");
const OK = "  ok   a\n  ok   b\n\nx e2e: 2/2 checks passed\n";
const BAD = "  ok   a\n  FAIL b — detail\n\nx e2e: 1/2 checks passed (1 FAILED)\n";
check("clean output, exit 0: pass", suiteFailure(0, OK) === null);
check("FAIL line + FAILED summary, exit 0: fail (the M-1 shape)", suiteFailure(0, BAD) !== null);
check("FAIL line alone, exit 0: fail", suiteFailure(0, "  FAIL b\nx: 2/2 checks passed\n") !== null);
check("FAILED in summary alone, exit 0: fail", suiteFailure(0, "x: 1/2 checks passed (1 FAILED)\n") !== null);
check("FAILED marker with equal counts, exit 0: fail", suiteFailure(0, "x: 2/2 checks passed (1 FAILED)\n") !== null);
check("passed != total, exit 0: fail", suiteFailure(0, "x: 1/2 checks passed\n") !== null);
check("no summary line, exit 0: fail", suiteFailure(0, "  ok   a\n") !== null);
check("zero checks: fail", suiteFailure(0, "x: 0/0 checks passed\n") !== null);
check("empty output: fail", suiteFailure(0, "") !== null);
check("clean output, exit 1: fail", suiteFailure(1, OK) !== null);
check("killed (code null): fail", suiteFailure(null, OK) !== null);
check("two summaries, second FAILED: fail", suiteFailure(0, OK + BAD) !== null);
check("ANSI-coloured FAIL line: fail", suiteFailure(0, `${ESC}[31m  FAIL b${ESC}[0m\nx: 2/2 checks passed\n`) !== null);
check("a check NAME containing FAIL is not a FAIL line", suiteFailure(0, "  ok   refusal FAIL path\nx: 1/1 checks passed\n") === null);
process.exit(summary("runner verdict") === 0 ? 0 : 1);
