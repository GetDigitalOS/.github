set -euo pipefail

want_uid="$GUARD_UID"
want_gid="$GUARD_GID"

# FAIL CLOSED ON A MISSING OWNER. Do not treat this as paranoia — an empty uid makes
# this whole guard a no-op that reports success:
#   * `chown -R ":" <path>` is VALID and does nothing, and exits 0;
#   * `find -uid ""` errors, and the error-tolerant count above then reads as ZERO
#     foreign-owned paths.
# Together that prints "PASSED" over a workspace it never touched. An absent input is
# not a safe input, and this exact hole was caught by the suite's own negative control.
case "$want_uid" in ''|*[!0-9]*)
  echo "::error::runner-workspace-guard: owner-uid must be a non-empty NUMERIC uid (got '$want_uid'). Refusing to run: an empty owner silently turns this guard into a no-op that reports success."
  exit 1;; esac
case "$want_gid" in ''|*[!0-9]*)
  echo "::error::runner-workspace-guard: owner-gid must be a non-empty NUMERIC gid (got '$want_gid'). Refusing to run."
  exit 1;; esac

targets=()
[ -e "${GITHUB_WORKSPACE:-}" ] && targets+=("$GITHUB_WORKSPACE")
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ -e "$p" ] && targets+=("$p")
done <<< "${GUARD_EXTRA_PATHS:-}"

if [ ${#targets[@]} -eq 0 ]; then
  echo "runner-workspace-guard: nothing to restore (no paths on disk)"
  exit 0
fi

rc=0

for t in "${targets[@]}"; do
  echo "::group::restore: $t"

  # `{ find ...; || true; }` for the same reason as the preflight: find exits
  # non-zero on an undescendable directory, and `set -eo pipefail` would then abort
  # this step BEFORE it reported anything — a silent failure inside the very step
  # whose job is to make failure loud.
  before=$({ find "$t" \( ! -uid "$want_uid" -o ! -gid "$want_gid" \) -printf 'x\n' 2>/dev/null || true; } | wc -l)
  echo "foreign-owned before: $before"

  if ! chown -R "${want_uid}:${want_gid}" "$t" 2>/dev/null; then
    echo "::error::runner-workspace-guard: chown failed on $t (this step must run as root — it is meant for a container job)."
    rc=1
  fi

  # VERIFY THE MUTATION. A chown that reports success is not proof; re-measure.
  # This is the whole point of the step — a restore that silently half-worked is
  # indistinguishable from one that worked, right up until the next deploy dies.
  after=$({ find "$t" \( ! -uid "$want_uid" -o ! -gid "$want_gid" \) -printf 'x\n' 2>/dev/null || true; } | wc -l)
  echo "foreign-owned after:  $after"

  if [ "$after" -ne 0 ]; then
    echo "::error::runner-workspace-guard: RESTORE INCOMPLETE — $after path(s) under $t are still not owned by ${want_uid}:${want_gid}."
    { find "$t" \( ! -uid "$want_uid" -o ! -gid "$want_gid" \) -printf '  %U:%G %M %p\n' 2>/dev/null || true; } \
      | head -10
    rc=1
  else
    echo "restored: all paths under $t are now owned by ${want_uid}:${want_gid}"
  fi

  echo "::endgroup::"
done

if [ "$rc" -ne 0 ]; then
  echo "::error::runner-workspace-guard: RESTORE FAILED — this job has left the reusable host workspace poisoned for the next non-container job in this repo."
  exit 1
fi
echo "runner-workspace-guard: restore PASSED — host workspace ownership invariant holds"
