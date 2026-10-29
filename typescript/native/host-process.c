/* Host tasks are trusted, ordinary processes. Match only their inherited random
 * marker; never export argv/environ. Birth identities guard every signal. */
#define _GNU_SOURCE
#include <node_api.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(__APPLE__)
#include <libproc.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#elif defined(__linux__)
#include <dirent.h>
#include <fcntl.h>
#include <sys/syscall.h>
#endif

#define ENV_LIMIT (16 * 1024 * 1024)
#define MARKER_PREFIX "GROUNDS_HOST_PROCESS_SCOPE="
typedef struct { pid_t pid; uint64_t first, second; double born_ms; int zombie; pid_t ppid; uint32_t flags; } host_proc;
typedef struct { host_proc *items; size_t count; int complete; } host_list;

static int proc_identity(pid_t pid, host_proc *out) {
  memset(out, 0, sizeof(*out)); out->pid = pid;
#if defined(__APPLE__)
  struct proc_bsdinfo info;
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) {
    /* Darwin's libproc omits zombie details, although proc_listpids includes
     * them. The kernel process table can positively establish a zombie. */
    struct kinfo_proc kernel_info; size_t size = sizeof(kernel_info);
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    if (sysctl(mib, 4, &kernel_info, &size, NULL, 0) == 0 && size == sizeof(kernel_info) && kernel_info.kp_proc.p_stat == SZOMB) {out->zombie = 1; return 1;}
    return 0;
  }
  if (info.pbi_uid != getuid()) return -1;
  out->first = info.pbi_start_tvsec; out->second = info.pbi_start_tvusec;
  out->born_ms = (double)out->first * 1000 + (double)out->second / 1000;
  out->zombie = info.pbi_status == SZOMB;
  out->ppid = (pid_t)info.pbi_ppid; out->flags = info.pbi_flags;
  return 1;
#elif defined(__linux__)
  char path[64], data[8192]; struct stat st;
  snprintf(path, sizeof(path), "/proc/%d", pid);
  if (stat(path, &st) != 0) return 0;
  /* A nondumpable process's /proc directory changes ownership to root.
   * Its status Uid remains authoritative; do not mistake it for another user. */
  snprintf(path, sizeof(path), "/proc/%d/status", pid);
  FILE *status_file = fopen(path, "r"); if (!status_file) return 0;
  unsigned int real_uid = UINT32_MAX, effective_uid = UINT32_MAX;
  while (fgets(data, sizeof(data), status_file)) if (sscanf(data, "Uid: %u %u", &real_uid, &effective_uid) == 2) break;
  fclose(status_file);
  if (real_uid == UINT32_MAX || effective_uid == UINT32_MAX) return 0;
  if (real_uid != getuid() && effective_uid != getuid()) return -1;
  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  FILE *file = fopen(path, "r"); if (!file) return 0;
  size_t length = fread(data, 1, sizeof(data)-1, file); fclose(file); data[length] = 0;
  char *end = strrchr(data, ')'); if (!end || end[1] != ' ') return 0;
  char *cursor = end + 2, *save = NULL, *part; int field = 3;
  for (part = strtok_r(cursor, " ", &save); part; part = strtok_r(NULL, " ", &save), field++) {
    if (field == 3) out->zombie = *part == 'Z' || *part == 'X';
    if (field == 22) { char *tail; out->first = strtoull(part, &tail, 10); if (tail == part) return 0; break; }
  }
  if (field != 22) return 0;
  file = fopen("/proc/stat", "r"); if (!file) return 0;
  unsigned long long boot = 0; while (fgets(data, sizeof(data), file)) if (sscanf(data, "btime %llu", &boot) == 1) break;
  fclose(file); long hz = sysconf(_SC_CLK_TCK); if (!boot || hz <= 0) return 0;
  out->second = boot; out->born_ms = (double)boot * 1000 + (double)out->first * 1000 / hz;
  return 1;
#else
  return 0;
#endif
}
static int same_proc(const host_proc *a, const host_proc *b) {
  return a->pid == b->pid && a->first == b->first && a->second == b->second;
}
static void identity_string(const host_proc *p, char *out, size_t size) {
  snprintf(out, size, "%llu:%llu", (unsigned long long)p->first, (unsigned long long)p->second);
}
static int compare_proc(const void *a, const void *b) {
  const host_proc *left = a, *right = b;
  return (left->pid > right->pid) - (left->pid < right->pid);
}
static host_list list_processes(double cutoff) {
  host_list out = {NULL, 0, 1}; size_t capacity = 1024;
  out.items = calloc(capacity, sizeof(host_proc)); if (!out.items) {out.complete = 0; return out;}
#if defined(__APPLE__)
  int bytes = proc_listpids(PROC_UID_ONLY, getuid(), NULL, 0);
  if (bytes <= 0) {out.complete = 0; return out;}
  size_t pid_capacity = (size_t)bytes / sizeof(pid_t) + 1024;
  pid_t *pids = calloc(pid_capacity, sizeof(pid_t)); if (!pids) {out.complete = 0; return out;}
  bytes = proc_listpids(PROC_UID_ONLY, getuid(), pids, (int)(pid_capacity * sizeof(pid_t)));
  if (bytes <= 0 || (size_t)bytes >= pid_capacity * sizeof(pid_t)) out.complete = 0;
  size_t count = bytes > 0 ? (size_t)bytes / sizeof(pid_t) : 0;
  for (size_t i = 0; i < count; i++) {pid_t pid = pids[i]; if (pid <= 0) continue;
#elif defined(__linux__)
  DIR *directory = opendir("/proc"); if (!directory) {out.complete = 0; return out;}
  struct dirent *entry;
  while ((entry = readdir(directory))) {char *end; long number = strtol(entry->d_name, &end, 10); if (*end || number <= 0 || number > INT32_MAX) continue; pid_t pid = (pid_t)number;
#else
  out.complete = 0;
  if (0) {pid_t pid = 0;
#endif
    host_proc p; int result = proc_identity(pid, &p);
    if (result == 0) {if (kill(pid, 0) != 0 && errno == ESRCH) continue; out.complete = 0; continue;}
    if (result < 0 || p.zombie || p.born_ms < cutoff) continue;
    if (out.count == capacity) {capacity *= 2; host_proc *grown = realloc(out.items, capacity * sizeof(host_proc)); if (!grown) {out.complete = 0; break;} out.items = grown;}
    out.items[out.count++] = p;
  }
#if defined(__APPLE__)
  free(pids);
#elif defined(__linux__)
  closedir(directory);
#endif
  qsort(out.items, out.count, sizeof(host_proc), compare_proc);
  return out;
}
/* 1 matched; 0 readable and not matched; -1 unreadable. Zero the private buffer
 * before freeing it. macOS begins with argc, executable path, argv, then env. */
static int has_marker(pid_t pid, const char *marker) {
  char *data = NULL; size_t length = 0, capacity = 0; int result = -1;
#if defined(__APPLE__)
  int argmax = 0, mib[3] = {CTL_KERN, KERN_ARGMAX, 0}; size_t size = sizeof(argmax);
  if (sysctl(mib, 2, &argmax, &size, NULL, 0) != 0 || argmax <= 0 || argmax > ENV_LIMIT) return -1;
  capacity = (size_t)argmax; data = malloc(capacity); if (!data) return -1;
  mib[1] = KERN_PROCARGS2; mib[2] = pid; length = capacity;
  if (sysctl(mib, 3, data, &length, NULL, 0) != 0 || length < sizeof(int)) goto done;
  int argc; memcpy(&argc, data, sizeof(argc)); if (argc < 0 || argc > argmax) goto done;
  size_t offset = sizeof(int), span = strnlen(data + offset, length-offset); if (span == length-offset) goto done;
  offset += span + 1; while (offset < length && data[offset] == 0) offset++;
  for (int i = 0; i < argc; i++) {if (offset >= length) goto done; span = strnlen(data+offset, length-offset); if (span == length-offset) goto done; offset += span+1;}
  /* KERN_PROCARGS2 silently omits env for cs_restricted binaries. An absent
   * environment is unreadable, never evidence that the marker is absent. */
  if (offset >= length || data[offset] == 0) goto done;
#elif defined(__linux__)
  char path[64]; snprintf(path, sizeof(path), "/proc/%d/environ", pid);
  FILE *file = fopen(path, "rb"); if (!file) return -1;
  capacity = ENV_LIMIT; data = malloc(capacity); if (!data) {fclose(file); return -1;}
  length = fread(data, 1, capacity, file); int failed = ferror(file) || length == capacity; fclose(file); if (failed) goto done;
  size_t offset = 0, span;
#else
  return -1;
#endif
  result = 0;
  while (offset < length) {
    span = strnlen(data+offset, length-offset);
    if (span == strlen(MARKER_PREFIX) + strlen(marker) && memcmp(data+offset, MARKER_PREFIX, strlen(MARKER_PREFIX)) == 0 && memcmp(data+offset+strlen(MARKER_PREFIX), marker, strlen(marker)) == 0) {result = 1; break;}
    if (span == length-offset) break;
    offset += span+1;
  }
 done:
  if (data) {volatile char *secret = data; for (size_t i = 0; i < length && i < capacity; i++) secret[i] = 0; free(data);}
  return result;
}
static int marker_argument(napi_env env, napi_value value, char marker[65]) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, marker, 65, &length) != napi_ok || length != 64) return 0;
  for (size_t i = 0; i < length; i++) if (!((marker[i] >= '0' && marker[i] <= '9') || (marker[i] >= 'a' && marker[i] <= 'f'))) return 0;
  return 1;
}
#if defined(__APPLE__)
/* Ordinary XNU orphans go to initproc; ptrace is the non-init reparenting
 * exception and exposes PROC_FLAG_TRACED. These sources describe the reviewed
 * implementation, not a future OS guarantee:
 * https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/kern_exit.c#L2471-L2473
 * https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/kern/mach_process.c#L278-L292
 * Any traced, changed, inaccessible, or init-parent chain remains unknown.
 * Linux deliberately does not use this proof: arbitrary subreapers can adopt
 * task descendants into an older non-init process. */
static int same_parent_link(const host_proc *a, const host_proc *b) {
  return same_proc(a, b) && a->ppid == b->ppid && (a->flags & PROC_FLAG_TRACED) == (b->flags & PROC_FLAG_TRACED);
}
static int fixed_leader_matches(const host_proc *p, pid_t leader_pid, const char *leader_identity) {
  char actual[64]; identity_string(p, actual, sizeof(actual));
  return p->pid == leader_pid && strcmp(actual, leader_identity) == 0;
}
static int unrelated_parent_chain(const host_proc *candidate, const char *marker,
                                  double started, pid_t leader_pid, const char *leader_identity) {
  host_proc chain[128], current = *candidate; size_t count = 0; int unrelated = 0;
  while (count < sizeof(chain) / sizeof(chain[0])) {
    if (current.pid <= 1 || current.zombie || (current.flags & PROC_FLAG_TRACED)) return 0;
    /* An unreadable original leader must never be discarded as a child of
     * its older controller. Identity checks precede the old-parent shortcut. */
    if (fixed_leader_matches(&current, leader_pid, leader_identity) || has_marker(current.pid, marker) == 1) return 0;
    for (size_t i = 0; i < count; i++) if (same_proc(&chain[i], &current)) return 0;
    chain[count++] = current;
    if (current.pid != candidate->pid && current.born_ms < started) {unrelated = 1; break;}
    if (current.ppid <= 1) return 0;
    host_proc parent;
    if (proc_identity(current.ppid, &parent) != 1 || parent.zombie || parent.born_ms > current.born_ms) return 0;
    current = parent;
  }
  if (!unrelated) return 0;
  /* Revalidate every birth, parent link and trace flag, not just the leaf. */
  for (size_t i = count; i > 0; i--) {
    host_proc actual;
    if (proc_identity(chain[i-1].pid, &actual) != 1 || actual.zombie ||
        (actual.flags & PROC_FLAG_TRACED) || !same_parent_link(&chain[i-1], &actual)) return 0;
  }
  return 1;
}
#endif
static napi_value scan(napi_env env, napi_callback_info info) {
  napi_value argv[4], result, array, complete_value; size_t argc = 4; char marker[65]; double started;
  int32_t leader_pid = 0; char leader_identity[64] = {0};
#if defined(__APPLE__)
  int parent_proof = 0;
#endif
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || (argc != 2 && argc != 4) || !marker_argument(env, argv[0], marker) || napi_get_value_double(env, argv[1], &started) != napi_ok || !(started > 0)) {napi_throw_type_error(env, NULL, "valid host process scope required"); return NULL;}
  if (argc == 4) {
    size_t length = 0;
    if (napi_get_value_int32(env, argv[2], &leader_pid) != napi_ok || leader_pid <= 0 ||
        napi_get_value_string_utf8(env, argv[3], leader_identity, sizeof(leader_identity), &length) != napi_ok ||
        length == 0 || length >= sizeof(leader_identity)) {napi_throw_type_error(env, NULL, "valid fixed leader identity required"); return NULL;}
#if defined(__APPLE__)
    unsigned long long seconds, micros; char tail;
    if (sscanf(leader_identity, "%llu:%llu%c", &seconds, &micros, &tail) == 2 && micros < 1000000 &&
        (double)seconds * 1000 + (double)micros / 1000 >= started) {
      host_proc actual; int found = proc_identity(leader_pid, &actual);
      if (found == 1) parent_proof = fixed_leader_matches(&actual, leader_pid, leader_identity);
      else if (found == 0 && kill(leader_pid, 0) != 0 && errno == ESRCH) parent_proof = 1;
    }
#endif
  }
  host_list matched = {NULL, 0, 0}; int complete = 0;
  /* Darwin exposes microsecond births. Linux's /proc boot epoch is rounded
   * to seconds, so its cutoff conservatively includes one extra second. */
#if defined(__linux__)
  double cutoff = started - 1000;
#else
  double cutoff = started;
#endif
  for (int attempt = 0; attempt < 3; attempt++) {
    host_list before = list_processes(cutoff);
    free(matched.items);
    matched.items = calloc(before.count+1, sizeof(host_proc)); matched.count = 0;
    host_proc *verified = calloc(before.count+1, sizeof(host_proc));
    size_t verified_count = 0;
    if (matched.items && verified) for (size_t i = 0; i < before.count; i++) {
      int match = has_marker(before.items[i].pid, marker); host_proc after;
#if defined(__APPLE__)
      if (match < 0 && parent_proof && unrelated_parent_chain(&before.items[i], marker, started, leader_pid, leader_identity)) match = 0;
#endif
      if (match >= 0 && proc_identity(before.items[i].pid, &after) == 1 && !after.zombie && same_proc(&before.items[i], &after)
#if defined(__APPLE__)
          && same_parent_link(&before.items[i], &after)
#endif
      ) {
        verified[verified_count++] = after;
        if (match == 1) matched.items[matched.count++] = after;
      }
    }
    host_list after = list_processes(cutoff);
    int stable = before.complete && after.complete && matched.items && verified;
    /* Every final live candidate must have been inspected in this pass.
     * A verified unrelated process subsequently exiting is irrelevant; newly
     * appearing or unreadable live candidates require another pass/unknown. */
    size_t cursor = 0;
    if (stable) for (size_t i = 0; i < after.count; i++) {
      while (cursor < verified_count && verified[cursor].pid < after.items[i].pid) cursor++;
      if (cursor == verified_count || !same_proc(&verified[cursor], &after.items[i])
#if defined(__APPLE__)
          || !same_parent_link(&verified[cursor], &after.items[i])
#endif
      ) {stable = 0; break;}
    }
    free(verified); free(before.items); free(after.items);
    if (stable) {complete = 1; break;}
  }
  napi_create_object(env, &result); napi_get_boolean(env, complete, &complete_value); napi_set_named_property(env, result, "complete", complete_value);
  napi_create_array_with_length(env, matched.count, &array);
  for (size_t i = 0; i < matched.count; i++) {napi_value item, pid, identity; char text[64]; identity_string(&matched.items[i], text, sizeof(text)); napi_create_object(env, &item); napi_create_int32(env, matched.items[i].pid, &pid); napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &identity); napi_set_named_property(env, item, "pid", pid); napi_set_named_property(env, item, "identity", identity); napi_set_element(env, array, (uint32_t)i, item);}
  free(matched.items); napi_set_named_property(env, result, "processes", array); return result;
}
static napi_value signal_owned(napi_env env, napi_callback_info info) {
  napi_value argv[4], result; size_t argc = 4, length; int32_t pid, sig; char marker[65], expected[64], actual[64];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 4 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0 || napi_get_value_string_utf8(env, argv[1], expected, sizeof(expected), &length) != napi_ok || length >= sizeof(expected) || !marker_argument(env, argv[2], marker) || napi_get_value_int32(env, argv[3], &sig) != napi_ok || (sig != SIGTERM && sig != SIGKILL)) {napi_throw_type_error(env, NULL, "valid process identity, scope and termination signal required"); return NULL;}
  int sent = 0; host_proc before, after;
#if defined(__linux__) && defined(SYS_pidfd_open) && defined(SYS_pidfd_send_signal)
  int fd = (int)syscall(SYS_pidfd_open, pid, 0);
  if (fd < 0) {napi_get_boolean(env, 0, &result); return result;}
#endif
  if (proc_identity(pid, &before) == 1) {
    identity_string(&before, actual, sizeof(actual));
    if (strcmp(actual, expected) == 0 && has_marker(pid, marker) == 1 && proc_identity(pid, &after) == 1 && same_proc(&before, &after)) {
#if defined(__linux__) && defined(SYS_pidfd_open) && defined(SYS_pidfd_send_signal)
      sent = syscall(SYS_pidfd_send_signal, fd, sig, NULL, 0) == 0;
#elif defined(__APPLE__)
      /* Darwin has no public pidfd signal API. Both the birth identity and
       * marker are checked in this native call immediately before kill. */
      sent = kill(pid, sig) == 0;
#endif
    }
  }
#if defined(__linux__) && defined(SYS_pidfd_open) && defined(SYS_pidfd_send_signal)
  close(fd);
#endif
  napi_get_boolean(env, sent, &result); return result;
}
static napi_value read_identity(napi_env env, napi_callback_info info) {
  napi_value argv[1], result; size_t argc = 1; int32_t pid; host_proc process;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0) {napi_throw_type_error(env, NULL, "positive PID required"); return NULL;}
  if (proc_identity(pid, &process) != 1 || process.zombie) {napi_get_undefined(env, &result); return result;}
  char identity[64]; identity_string(&process, identity, sizeof(identity));
  napi_create_string_utf8(env, identity, NAPI_AUTO_LENGTH, &result); return result;
}
static napi_value signal_leader(napi_env env, napi_callback_info info) {
  napi_value argv[3], result; size_t argc = 3, length; int32_t pid, sig; char expected[64], actual[64];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 || napi_get_value_int32(env, argv[0], &pid) != napi_ok || pid <= 0 || napi_get_value_string_utf8(env, argv[1], expected, sizeof(expected), &length) != napi_ok || length >= sizeof(expected) || napi_get_value_int32(env, argv[2], &sig) != napi_ok || (sig != SIGTERM && sig != SIGKILL)) {napi_throw_type_error(env, NULL, "valid process identity and termination signal required"); return NULL;}
  host_proc before, after; int sent = 0;
  if (proc_identity(pid, &before) == 1 && !before.zombie) {
    identity_string(&before, actual, sizeof(actual));
    if (strcmp(actual, expected) == 0 && getpgid(pid) == pid && proc_identity(pid, &after) == 1 && same_proc(&before, &after) && !after.zombie) sent = kill(-pid, sig) == 0;
  }
  napi_get_boolean(env, sent, &result); return result;
}
napi_status register_host_process(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"hostProcesses", NULL, scan, NULL, NULL, NULL, napi_default, NULL},
    {"signalHostProcess", NULL, signal_owned, NULL, NULL, NULL, napi_default, NULL},
    {"hostProcessIdentity", NULL, read_identity, NULL, NULL, NULL, napi_default, NULL},
    {"signalHostProcessLeader", NULL, signal_leader, NULL, NULL, NULL, napi_default, NULL}
  };
  return napi_define_properties(env, exports, 4, methods);
}
