# Notes for Claude

## Process matching in shell commands

Never use `pkill -f`, `pgrep -f` or `ps | grep` with a pattern that also
appears in the command you are running. The pattern is part of your own
shell's command line, so it matches (and `pkill` kills) your own process.

- Stop a background job by the PID you saved when starting it (`$!`), or by
  its port (`fuser -k 8642/tcp`), not by matching its command line.
- If you must match by name, anchor the pattern so it cannot match your own
  shell, e.g. `pgrep -f '^python3 -m http.server'`.
- To wait for a background job, rely on its completion notification rather
  than a polling loop that greps for the job's own command or output.
