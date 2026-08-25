/**
 * Portability rules for MODEL-AUTHORED shell, run at plan-validation time.
 *
 * The planner is the worst-informed agent in the system about the shell: it
 * never runs anything, it is a one-shot structured call, and it is writing
 * executable code blind. So it reaches for whatever LOOKS rigorous, and what
 * looks rigorous is frequently wrong on BSD userland.
 *
 * The bug that motivated this, reproduced on macOS:
 *
 *     printf '' | wc -l | od -c        →  '        0\n'   (BSD pads to width 8)
 *     printf '' | wc -l | grep -qx 0   →  exit 1.  FAILS.
 *     [ "$(printf '' | wc -l)" -eq 0 ] →  exit 0.  PASSES.
 *
 * None of this is novel — it is checkbashisms and ShellCheck's POSIX mode. The
 * trick is the PLACEMENT: these feed the planner's existing three-attempt
 * repair loop, so every rule becomes a self-repairing constraint at no extra
 * control-flow cost. That is the cheapest quality lever in the system.
 *
 * The messages matter more than the rules. Told "`wc -l` pads on BSD; use
 * `[ "$(…)" -eq 0 ]`", the planner fixes it. The deeper cause is that it wanted
 * to say "no matches" and reached for COUNTING because counting feels rigorous,
 * when the portable expression is `! grep -rq pattern src/`.
 */

export interface ShellIssue {
  rule: string
  message: string
}

interface Rule {
  id: string
  test: (command: string) => boolean
  message: string
}

const endsPipelineWith = (command: string, tools: string[]): boolean => {
  // The LAST stage of the last pipeline decides the exit code.
  const last = command.split(/&&|\|\||;/).pop() ?? ''
  const stage = last.split('|').pop()?.trim() ?? ''
  return tools.some((tool) => new RegExp(`^${tool}\\b`).test(stage))
}

const RULES: Rule[] = [
  {
    id: 'wc-l-string-compare',
    test: (c) => /wc\s+-l/.test(c) && /wc\s+-l[^|]*\|\s*(grep|test|\[)/.test(c),
    message: 'BSD `wc -l` pads its output to width 8, so a STRING comparison of its result fails on macOS. '
      + 'Compare numerically instead: `[ "$(… | wc -l)" -eq 0 ]`.',
  },
  {
    id: 'grep-c-zero',
    // Decisive, or feeding a zero comparison. Both are the same bug: the count
    // vanishes exactly when the assertion is true.
    test: (c) => /\bgrep\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*c\b/.test(c)
      && (endsPipelineWith(c, ['grep']) || /-c\b[^|]*\|[^|]*(grep\s+-q|-eq\s*0|=\s*["']?0)/.test(c)),
    message: '`grep -c` exits 1 when the count is ZERO and prints nothing, so "there are no matches" '
      + 'reports failure exactly when the assertion is true. For absence use `! grep -rq pattern src/`; '
      + 'counting only feels more rigorous.',
  },
  {
    id: 'exit-code-masked',
    test: (c) => endsPipelineWith(c, ['head', 'tail', 'sort', 'tee', 'cat', 'tr', 'wc']),
    message: 'A pipeline ending in head/tail/sort/tee/cat/tr/wc returns THAT tool\'s exit code, not the real one — '
      + 'a red result reports green. Put the decisive command last, or use `set -o pipefail`.',
  },
  {
    id: 'sed-i-suffix',
    test: (c) => /\bsed\s+(-[a-zA-Z]*\s+)*-i(?!\s*(\.|''|""))/.test(c),
    message: 'BSD `sed -i` REQUIRES a backup suffix; `sed -i` alone consumes the next argument as one. '
      + "Write `sed -i '' -e …` for BSD, or avoid in-place editing in a proof.",
  },
  {
    id: 'date-d',
    test: (c) => /\bdate\s+(-[a-zA-Z]*\s+)*-d\b/.test(c),
    message: '`date -d` is GNU-only; BSD date uses `-v` or `-j -f`. Avoid date arithmetic in a proof.',
  },
  {
    id: 'timeout-missing',
    test: (c) => /(^|[;&|(\s])timeout\s/.test(c),
    message: '`timeout` is not installed by default on macOS (it is `gtimeout` from coreutils). '
      + 'Arc already imposes a timeout on every command it runs — do not add your own.',
  },
  {
    id: 'readlink-f',
    test: (c) => /\breadlink\s+-f\b/.test(c),
    message: '`readlink -f` is GNU-only on older macOS. Use `cd "$(dirname "$x")" && pwd -P` or avoid it.',
  },
  {
    id: 'grep-P',
    test: (c) => /\bgrep\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*P\b/.test(c),
    message: '`grep -P` (PCRE) is not available in BSD grep. Use `grep -E` with a POSIX ERE.',
  },
  {
    id: 'echo-e',
    test: (c) => /\becho\s+-e\b/.test(c),
    message: '`echo -e` is not portable — the shell built-in differs between bash, sh and dash. Use `printf`.',
  },
  {
    id: 'stat-c',
    test: (c) => /\bstat\s+(-[a-zA-Z]*\s+)*-c\b/.test(c),
    message: '`stat -c` is GNU-only; BSD stat uses `-f`. Avoid stat in a proof.',
  },
  {
    id: 'base64-w',
    test: (c) => /\bbase64\s+-w\b/.test(c),
    message: '`base64 -w` is GNU-only; BSD base64 wraps by default and has no `-w`.',
  },
  {
    id: 'find-printf',
    test: (c) => /\bfind\b[^|;&]*-printf\b/.test(c),
    message: '`find -printf` is GNU-only. Use `-exec` or `-print` with a separate formatter.',
  },
  {
    id: 'xargs-r',
    test: (c) => /\bxargs\s+(-[a-zA-Z]*\s+)*-r\b/.test(c),
    message: '`xargs -r` is GNU-only; BSD xargs does not run the command on empty input anyway.',
  },
  {
    id: 'ls-parsing',
    test: (c) => /\bls\b[^|;&]*\|\s*(grep|wc|awk|head|tail)/.test(c),
    message: 'Parsing `ls` breaks on any filename with a space or newline. Use a glob, `find`, or `git ls-files`.',
  },
  {
    id: 'chain-length',
    test: (c) => (c.match(/&&/g) ?? []).length >= 3,
    message: 'A chain of four or more commands is a complexity smell, not a portability bug: '
      + 'the longer the one-liner, the less likely it means what you think. Prove ONE thing.',
  },
]

/** Every portability problem in one model-authored command. */
export function lintShell(command: string): ShellIssue[] {
  return RULES.filter((rule) => rule.test(command)).map((rule) => ({ rule: rule.id, message: rule.message }))
}
