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

# Collect the paths to inspect. The workspace always; extra paths only if present.
targets=()
[ -e "${GITHUB_WORKSPACE:-}" ] && targets+=("$GITHUB_WORKSPACE")
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ -e "$p" ] && targets+=("$p")
done <<< "${GUARD_EXTRA_PATHS:-}"

if [ ${#targets[@]} -eq 0 ]; then
  echo "runner-workspace-guard: nothing to inspect (no workspace on disk yet) — CLEAN"
  exit 0
fi

rc=0

for t in "${targets[@]}"; do
  echo "::group::preflight: $t"
  echo "expected owner: ${want_uid}:${want_gid} (the runner service user)"

  # --- 1. foreign-owned paths -------------------------------------------------
  # "Foreign" is a NUMERIC comparison. Inside a container, uid 0 is 'root' and the
  # host's uid 1000 may not have a name at all, so name comparison is meaningless.
  #
  # Every find(1) below is wrapped `{ ...; || true; }`. find EXITS NON-ZERO when it
  # cannot descend into a directory — which is precisely the condition this guard
  # exists to report. Under `set -eo pipefail` that killed the script before it
  # printed a single diagnostic: correct exit code, zero evidence. Neutralise find's
  # STATUS (never its output) so the guard always gets to speak.
  n_foreign=$({ find "$t" \( ! -uid "$want_uid" -o ! -gid "$want_gid" \) -printf 'x\n' 2>/dev/null || true; } | wc -l)

  if [ "$n_foreign" -gt 0 ]; then
    echo "::error::runner-workspace-guard: $n_foreign path(s) under $t are not owned by ${want_uid}:${want_gid}."
    echo "distinct owners present:"
    { find "$t" \( ! -uid "$want_uid" -o ! -gid "$want_gid" \) -printf '%U:%G\n' 2>/dev/null || true; } \
      | sort | uniq -c | sort -rn | sed 's/^/  /'
    echo "first 10 offending paths:"
    { find "$t" \( ! -uid "$want_uid" -o ! -gid "$want_gid" \) -printf '  %U:%G %M %p\n' 2>/dev/null || true; } \
      | head -10
    rc=1
  else
    echo "ownership: OK — all paths owned by ${want_uid}:${want_gid}"
  fi

  # --- 2. undeletable paths ---------------------------------------------------
  # This is the invariant actions/checkout ACTUALLY needs, and it is not the same
  # as "is the entry owned by me": to delete or replace an entry, the service user
  # needs write permission on its PARENT directory. Check that directly.
  undeletable=$(
    { find "$t" -type d -printf '%U\t%G\t%m\t%p\n' 2>/dev/null || true; } |
    awk -F'\t' -v u="$want_uid" -v g="$want_gid" '
      {
        own=$1; grp=$2; mode=$3; path=$4;
        m = substr(mode, length(mode)-2, 3);      # strip any setuid/sticky digit
        uw = int(substr(m,1,1)) ; gw = int(substr(m,2,1)) ; ow = int(substr(m,3,1));
        writable = 0;
        if      (own == u && int(uw/2) % 2 == 1) writable = 1;   # owner  write bit
        else if (grp == g && int(gw/2) % 2 == 1) writable = 1;   # group  write bit
        else if (int(ow/2) % 2 == 1)             writable = 1;   # other  write bit
        if (!writable) print "  " own ":" grp " " m " " path;
      }'
  )
  if [ -n "$undeletable" ]; then
    echo "::error::runner-workspace-guard: directories under $t are NOT writable by ${want_uid}:${want_gid} — checkout cannot delete or replace their contents."
    echo "$undeletable" | head -10
    rc=1
  else
    echo "deletability: OK — every directory is writable by ${want_uid}:${want_gid}"
  fi

  # --- 3. git locks -----------------------------------------------------------
  # Classified by OWNERSHIP (is a live process holding it), never by age. A lock is
  # not stale because it is old; it is stale because nothing owns it. Reported, not
  # removed — this action never deletes anything.
  locks=$(find "$t" -name '*.lock' -path '*/.git/*' 2>/dev/null || true)
  if [ -z "$locks" ]; then
    echo "git locks: none found"
  else
    while IFS= read -r lk; do
      [ -n "$lk" ] || continue
      if command -v fuser >/dev/null 2>&1 && fuser "$lk" >/dev/null 2>&1; then
        echo "::error::runner-workspace-guard: ACTIVE git lock (a live process holds it): $lk"
        rc=1
      else
        echo "::warning::runner-workspace-guard: STALE git lock (no process holds it): $lk"
      fi
    done <<< "$locks"
  fi

  echo "::endgroup::"
done

if [ "$rc" -ne 0 ]; then
  echo "::error::runner-workspace-guard: PREFLIGHT FAILED — the reusable host workspace is poisoned. This is an infrastructure fault, not a code fault. Do not retry; run 'hub runner-doctor' and clean the workspace."
  exit 1
fi
echo "runner-workspace-guard: preflight PASSED"
