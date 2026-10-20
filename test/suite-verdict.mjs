/**
 * DP-FLAG-21 (independent M-1 on f555e93b): the verdict on ONE suite, from
 * its exit code AND its printed output. A suite fails if any of:
 *   - it exited non-zero (or was killed: code null);
 *   - it printed a harness FAIL line;
 *   - it printed no `<label>: x/y checks passed` summary line (it died early,
 *     or never reached its checks);
 *   - any summary line reports FAILED, x !== y, or zero checks.
 * Exiting 0 alone is not a pass: three suites once ended with a bare
 * summary(...) and exited 0 with failing checks.
 * Returns null for a pass, else the reason.
 */
const SUMMARY = /^.*: (\d+)\/(\d+) checks passed( \((\d+) FAILED\))?\s*$/;
const FAIL_LINE = /^\s*FAIL /;
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

export const suiteFailure = (code, output) => {
	if (code !== 0) return `exit ${code}`;
	const lines = String(output ?? "").replace(ANSI, "").split(/\r?\n/);
	if (lines.some((l) => FAIL_LINE.test(l))) return "printed a FAIL line";
	const sums = lines.map((l) => SUMMARY.exec(l)).filter(Boolean);
	if (sums.length === 0) return "printed no summary line";
	for (const [, ok, total, failedPart] of sums) {
		if (failedPart) return "summary reports FAILED";
		if (Number(total) === 0) return "summary reports zero checks";
		if (ok !== total) return "summary passed count differs from total";
	}
	return null;
};
